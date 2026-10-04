// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic node-disk expansion on the ec2 target, driven by NodeDiskFillingUp.
 *
 * The counterpart to pvc-autoexpand.ts, and a completely different actuator:
 * there is no PersistentVolumeClaim to patch here. ec2 runs minikube on one EC2
 * instance and binds MANUAL hostPath PVs (storageClassName: ""), so every
 * database directory, every RustFS bucket and the registry all live on one EBS
 * volume — `/dev/xvdf`, whole-disk ext4 labelled `pipeline-data`, mounted at
 * /opt/pipeline. Growing it is two steps that no pod can do by itself:
 *
 *   1. ec2:ModifyVolume          — grow the EBS volume (an API call)
 *   2. resize2fs on the instance — grow the filesystem (needs root on the host)
 *
 * Step 2 is why this goes through SSM. The grant is deliberately NOT
 * `ssm:SendCommand` on arbitrary commands: the instance role may run exactly ONE
 * document (PIPELINE_BUILDER_RESIZE_DOCUMENT, defined in template.yaml), which
 * takes no parameters and resizes a fixed device. A pod that steals instance
 * credentials through IMDS can therefore trigger that one resize and nothing
 * else — it cannot run arbitrary root commands on a box that also builds
 * untrusted plugins.
 *
 * No `growpart`: the volume is formatted whole-disk (`mkfs.ext4 /dev/xvdf`, no
 * partition table), so the filesystem starts at sector 0 and resize2fs alone is
 * sufficient. That removes the step most likely to destroy data.
 *
 * Same safety discipline as the PVC path, for the same reasons:
 *   CEILING   never past maxGi, and never more than ceilingFactor x the size the
 *             volume was first seen at (recorded on the volume as a tag, so it
 *             cannot compound off each new size).
 *   COOLDOWN  EBS refuses a second modification of the same volume for ~6h;
 *             Redis holds the window AND the cross-replica lock, and this fails
 *             CLOSED without it.
 *   NO SHRINK a computed size that is not strictly larger is never submitted.
 *
 * The blast radius is larger than the PVC path's by nature: this is the single
 * disk the entire ec2 deployment runs on, not one claim.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '../observability/metrics.js';
import { getRedisClient } from '../utils/redis-client.js';

const logger = createLogger('node-disk-autoexpand');

/** The tag CloudFormation puts on the data volume (template.yaml DataVolume). */
const DATA_VOLUME_TAG_KEY = 'pipeline-builder-data-volume';

/**
 * This instance's id, from IMDSv2.
 *
 * Asking the instance who it is beats configuring it: the volume's Name tag
 * interpolates ${DomainName} and the purpose-built tag carries the stack name,
 * so any env-based lookup would need plumbing that can silently go stale or, far
 * worse, match a DIFFERENT stack's volume in the same account. Narrowing by
 * attachment to THIS instance cannot do that.
 *
 * IMDSv2 (token-first) because IMDSv1 is disabled on modern AMIs, and the hop is
 * already permitted: platform's egress policy allows 169.254.169.254:80.
 */
async function instanceId(): Promise<string> {
  const token = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '60' },
    signal: AbortSignal.timeout(2000),
  }).then((r) => r.text());
  const id = await fetch('http://169.254.169.254/latest/meta-data/instance-id', {
    headers: { 'x-aws-ec2-metadata-token': token },
    signal: AbortSignal.timeout(2000),
  }).then((r) => r.text());
  if (!/^i-[0-9a-f]+$/.test(id)) throw new Error(`IMDS returned an implausible instance id: ${id.slice(0, 40)}`);
  return id;
}

/** Records the first-seen size so the ceiling is measured from it, not compounded. */
export const ORIGINAL_TAG = 'pipeline-builder:autoexpand-original-gib';

export interface NodeDiskAutoExpandConfig {
  enabled: boolean;
  /** SSM document that resizes the filesystem. Takes no parameters by design. */
  resizeDocument: string;
  region: string;
  stepFactor: number;
  ceilingFactor: number;
  maxGi: number;
  cooldownSeconds: number;
}

export type NodeDiskOutcome = 'expanded' | 'cooldown' | 'at-ceiling' | 'disabled' | 'not-found' | 'error';

export interface NodeDiskResult {
  outcome: NodeDiskOutcome;
  volumeId?: string;
  fromGi?: number;
  toGi?: number;
  detail?: string;
}

/**
 * Next size in whole GiB, or null when the volume must not grow. Shares the
 * shape of the PVC path's decision deliberately — one rule, two actuators.
 */
export function nextVolumeGi(
  currentGi: number,
  originalGi: number,
  cfg: Pick<NodeDiskAutoExpandConfig, 'stepFactor' | 'ceilingFactor' | 'maxGi'>,
): { toGi: number } | { atCeiling: true; ceilingGi: number } {
  const ceilingGi = Math.min(originalGi * cfg.ceilingFactor, cfg.maxGi);
  if (currentGi >= ceilingGi) return { atCeiling: true, ceilingGi };
  const toGi = Math.min(Math.ceil(currentGi * cfg.stepFactor), Math.floor(ceilingGi));
  if (toGi <= currentGi) return { atCeiling: true, ceilingGi };
  return { toGi };
}

/**
 * Grow the instance's data volume, then its filesystem.
 *
 * Returns WHY when it does not act: while a disk is filling, "nothing happened"
 * is the outcome an operator most needs explained.
 */
export async function expandNodeDisk(cfg: NodeDiskAutoExpandConfig): Promise<NodeDiskResult> {
  if (!cfg.enabled) {
    incCounter('node_disk_autoexpand_total', { result: 'disabled' });
    return { outcome: 'disabled', detail: 'NODE_DISK_AUTOEXPAND_ENABLED is not true' };
  }

  // Cooldown and cross-replica lock first — cheaper than any AWS call, and the
  // point is to not act twice inside the window EBS would reject anyway.
  const redis = await getRedisClient();
  const key = 'node-disk:autoexpand:data-volume';
  if (!redis) {
    incCounter('node_disk_autoexpand_total', { result: 'error' });
    logger.error('Node-disk auto-expand skipped: no Redis, so no cooldown or cross-replica lock');
    return { outcome: 'error', detail: 'Redis unavailable; refusing to expand without a cooldown' };
  }
  if ((await redis.set(key, String(Date.now()), 'EX', cfg.cooldownSeconds, 'NX')) !== 'OK') {
    incCounter('node_disk_autoexpand_total', { result: 'cooldown' });
    return { outcome: 'cooldown', detail: `within ${cfg.cooldownSeconds}s of the last decision` };
  }

  try {
    // Lazily imported: an eks or local install never constructs these clients,
    // and never pays for loading the SDK.
    const { EC2Client, DescribeVolumesCommand, ModifyVolumeCommand, CreateTagsCommand } = await import('@aws-sdk/client-ec2');
    const ec2 = new EC2Client({ region: cfg.region });

    const self = await instanceId();
    // Attached to THIS instance and carrying the data-volume tag: the root
    // volume is excluded by the tag, another stack's volume by the attachment.
    const found = await ec2.send(new DescribeVolumesCommand({
      Filters: [
        { Name: 'attachment.instance-id', Values: [self] },
        { Name: 'tag-key', Values: [DATA_VOLUME_TAG_KEY] },
      ],
    }));
    const volume = found.Volumes?.[0];
    if (!volume?.VolumeId || !volume.Size) {
      incCounter('node_disk_autoexpand_total', { result: 'not-found' });
      await redis.del(key).catch(() => undefined);
      return { outcome: 'not-found', detail: `no EBS volume tagged ${DATA_VOLUME_TAG_KEY} attached to ${self}` };
    }

    const volumeId = volume.VolumeId;
    const currentGi = volume.Size;
    // First-seen size lives on the volume itself, so the ceiling survives a
    // platform restart and cannot compound off each new size.
    const originalTag = volume.Tags?.find((t) => t.Key === ORIGINAL_TAG)?.Value;
    const originalGi = Number(originalTag) || currentGi;

    const decision = nextVolumeGi(currentGi, originalGi, cfg);
    if ('atCeiling' in decision) {
      incCounter('node_disk_autoexpand_total', { result: 'at-ceiling' });
      setGauge('node_disk_autoexpand_at_ceiling', { volume_id: volumeId }, 1);
      logger.warn('Node disk at its auto-expand ceiling; not expanding', { volumeId, currentGi, ceilingGi: decision.ceilingGi });
      return {
        outcome: 'at-ceiling', volumeId, fromGi: currentGi,
        detail: `at the ${decision.ceilingGi}Gi ceiling — this disk backs the whole deployment; find what is writing`,
      };
    }

    if (!originalTag) {
      await ec2.send(new CreateTagsCommand({
        Resources: [volumeId],
        Tags: [{ Key: ORIGINAL_TAG, Value: String(currentGi) }],
      }));
    }

    await ec2.send(new ModifyVolumeCommand({ VolumeId: volumeId, Size: decision.toGi }));

    // The EBS volume is now larger; the filesystem is not. Only root on the
    // instance can fix that, hence the single fixed SSM document.
    const { SSMClient, SendCommandCommand } = await import('@aws-sdk/client-ssm');
    const ssm = new SSMClient({ region: cfg.region });
    const sent = await ssm.send(new SendCommandCommand({
      DocumentName: cfg.resizeDocument,
      // This instance by id, not a tag match — the same reasoning as the volume
      // lookup, and it keeps the SSM grant scopable to one instance ARN.
      InstanceIds: [self],
      // No Parameters: the document resizes a fixed device, so there is nothing
      // an attacker holding these credentials could inject.
      Comment: 'pipeline-builder: resize data filesystem after EBS growth',
    }));

    incCounter('node_disk_autoexpand_total', { result: 'expanded' });
    setGauge('node_disk_autoexpand_at_ceiling', { volume_id: volumeId }, 0);
    logger.info('Node disk expanded', { volumeId, fromGi: currentGi, toGi: decision.toGi, ssmCommandId: sent.Command?.CommandId });
    return { outcome: 'expanded', volumeId, fromGi: currentGi, toGi: decision.toGi };
  } catch (err) {
    incCounter('node_disk_autoexpand_total', { result: 'error' });
    logger.error('Node-disk auto-expand failed', { error: errorMessage(err) });
    // Release the window: it exists because EBS refuses a second modify, and if
    // this threw before ModifyVolume there was none. Holding it would blind us
    // for 6h after a transient API error.
    await redis.del(key).catch(() => undefined);
    return { outcome: 'error', detail: errorMessage(err) };
  }
}
