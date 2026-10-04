// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic PersistentVolumeClaim expansion, driven by the storage alerts.
 *
 * Alertmanager routes PersistentVolumeFillingUp / PersistentVolumeCriticallyFull
 * here (see deploy/aws/eks/config/alertmanager/alertmanager.yml); this decides
 * whether to grow the claim and patches it.
 *
 * EKS ONLY, and that is a property of the volume, not a feature flag:
 *   * eks binds `pb-ebs` (ebs.csi.eks.amazonaws.com, allowVolumeExpansion: true),
 *     so raising spec.resources.requests.storage makes the CSI driver resize the
 *     EBS volume and the filesystem online.
 *   * ec2 and minikube bind MANUAL hostPath PVs (storageClassName: ""). There is
 *     no CSI volume to expand — patching the claim does nothing — and the kubelet
 *     emits no kubelet_volume_stats_* for them, so the alerts never fire there.
 *     Growing those means growing the instance's EBS volume and running
 *     growpart/resize2fs on the host, which a pod cannot do.
 *
 * Safety properties, in order of how badly their absence would hurt:
 *
 *   1. CEILING. Every claim may grow to at most `ceilingFactor` x its ORIGINAL
 *      request, and never past `maxGi`. The original is pinned in an annotation
 *      on first expansion, so the ceiling is measured from where the volume
 *      started rather than compounding off each new size. At the ceiling this
 *      stops expanding and raises a counter an alert watches — a runaway writer
 *      (an unarchived WAL, a log loop) must surface, not quietly bill.
 *   2. COOLDOWN. EBS refuses a second modification of the same volume for ~6h,
 *      and Alertmanager re-sends on its repeat_interval, so every decision takes
 *      a Redis lock keyed on the claim with a TTL matching that window. Without
 *      it the endpoint would patch, fail, and retry every repeat_interval.
 *   3. NO SHRINK. Expansion is irreversible in both EBS and Kubernetes, so a
 *      computed size that is not strictly larger is never submitted.
 *
 * StatefulSet claims (data-rustfs-*, data-redis-*) ARE expanded, by explicit
 * decision. Their size comes from volumeClaimTemplates, which is immutable on a
 * live StatefulSet, so patching the live claim leaves the manifest behind: a
 * replica created later provisions at the OLD size. That divergence is reported
 * through `pvc_autoexpand_template_drift` so it cannot rot silently.
 */

import { readFile } from 'fs/promises';
import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '../observability/metrics.js';
import { getRedisClient } from '../utils/redis-client.js';

const logger = createLogger('pvc-autoexpand');

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const GIB = 1024 ** 3;

/** Set on first expansion so the ceiling is measured from the original size. */
export const ORIGINAL_ANNOTATION = 'pipeline-builder.io/autoexpand-original';
/** Human breadcrumb for `kubectl describe pvc`. */
export const LAST_ANNOTATION = 'pipeline-builder.io/autoexpand-last';

export interface AutoExpandConfig {
  enabled: boolean;
  /** Multiplier applied to the current request, e.g. 1.5 for +50%. */
  stepFactor: number;
  /** Hard ceiling as a multiple of the ORIGINAL request. */
  ceilingFactor: number;
  /** Absolute ceiling in GiB, whatever the factors say. */
  maxGi: number;
  /** Cooldown seconds; matches the EBS modification window. */
  cooldownSeconds: number;
}

export type AutoExpandOutcome =
  | 'expanded'
  | 'cooldown'
  | 'at-ceiling'
  | 'disabled'
  | 'not-expandable'
  | 'error';

export interface AutoExpandResult {
  namespace: string;
  claim: string;
  outcome: AutoExpandOutcome;
  fromGi?: number;
  toGi?: number;
  detail?: string;
}

/**
 * Kubernetes quantities are not plain numbers: "20Gi", "500Mi", "1T", or a bare
 * byte count are all legal for the same field. Parsing only the shape we write
 * would silently misread a claim an operator sized by hand.
 */
export function parseQuantityToBytes(q: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([EPTGMK]i?|m)?$/.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = m[2] ?? '';
  const binary: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6 };
  const decimal: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  if (!suffix) return n;
  if (suffix === 'm') return n / 1000;
  return n * (binary[suffix] ?? decimal[suffix] ?? 1);
}

/**
 * The next size, or null when the claim must not grow.
 *
 * Rounds UP to a whole GiB: EBS allocates in whole GiB anyway, and a fractional
 * request would be rounded by the CSI driver into a size this code did not
 * choose — which would then disagree with the ceiling arithmetic.
 */
export function nextSizeGi(
  currentBytes: number,
  originalBytes: number,
  cfg: Pick<AutoExpandConfig, 'stepFactor' | 'ceilingFactor' | 'maxGi'>,
): { toGi: number } | { atCeiling: true; ceilingGi: number } {
  const currentGi = currentBytes / GIB;
  const ceilingGi = Math.min((originalBytes / GIB) * cfg.ceilingFactor, cfg.maxGi);
  // Already at or past the ceiling: never submit, and let the caller alert.
  if (currentGi >= ceilingGi) return { atCeiling: true, ceilingGi };
  const stepped = Math.ceil(currentGi * cfg.stepFactor);
  const toGi = Math.min(stepped, Math.floor(ceilingGi));
  // Clamping to the ceiling can land on the current size; growth must be strict
  // because neither EBS nor Kubernetes can undo an expansion.
  if (toGi <= currentGi) return { atCeiling: true, ceilingGi };
  return { toGi };
}

interface PvcBody {
  metadata?: { annotations?: Record<string, string>; labels?: Record<string, string>; ownerReferences?: { kind: string }[] };
  spec?: { resources?: { requests?: { storage?: string } }; storageClassName?: string };
  status?: { capacity?: { storage?: string } };
}

/**
 * Minimal in-cluster Kubernetes client.
 *
 * Deliberately not @kubernetes/client-node: this needs two calls (GET and a
 * merge PATCH) against one resource, and the in-pod ServiceAccount already
 * provides the host, the token and the CA. Pulling a large client tree for that
 * would add supply-chain surface for no capability.
 */
async function k8s(path: string, init?: { method: string; body: string; contentType: string }): Promise<unknown> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT || '443';
  if (!host) throw new Error('not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST unset)');
  const token = await readFile(`${SA_DIR}/token`, 'utf-8');
  const headers: Record<string, string> = { authorization: `Bearer ${token.trim()}`, accept: 'application/json' };
  if (init) headers['content-type'] = init.contentType;
  const res = await fetch(`https://${host}:${port}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body,
  });
  if (!res.ok) throw new Error(`k8s ${init?.method ?? 'GET'} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const pvcPath = (ns: string, name: string) =>
  `/api/v1/namespaces/${encodeURIComponent(ns)}/persistentvolumeclaims/${encodeURIComponent(name)}`;

/**
 * Expand one claim. Returns WHY when it does not, because "nothing happened" is
 * the outcome an operator most needs explained while a volume is filling.
 */
export async function expandClaim(
  namespace: string,
  claim: string,
  cfg: AutoExpandConfig,
): Promise<AutoExpandResult> {
  const labels = { namespace, claim };
  if (!cfg.enabled) {
    incCounter('pvc_autoexpand_total', { ...labels, result: 'disabled' });
    return { namespace, claim, outcome: 'disabled', detail: 'PVC_AUTOEXPAND_ENABLED is not true' };
  }

  // Cooldown FIRST: cheaper than a round trip, and the whole point is to not act
  // twice inside the window EBS would reject anyway.
  const redis = await getRedisClient();
  const key = `pvc:autoexpand:${namespace}/${claim}`;
  if (redis) {
    // NX+EX: claim the window atomically. Two platform replicas receiving the
    // same Alertmanager fan-out must not both patch.
    const won = await redis.set(key, String(Date.now()), 'EX', cfg.cooldownSeconds, 'NX');
    if (won !== 'OK') {
      incCounter('pvc_autoexpand_total', { ...labels, result: 'cooldown' });
      return { namespace, claim, outcome: 'cooldown', detail: `within ${cfg.cooldownSeconds}s of the last decision` };
    }
  } else {
    // Fail CLOSED. Without Redis there is no cooldown and no cross-replica
    // mutual exclusion, and the failure mode is repeated EBS modification
    // attempts on every repeat_interval — worse than not expanding.
    incCounter('pvc_autoexpand_total', { ...labels, result: 'error' });
    logger.error('PVC auto-expand skipped: no Redis, so no cooldown or cross-replica lock');
    return { namespace, claim, outcome: 'error', detail: 'Redis unavailable; refusing to expand without a cooldown' };
  }

  try {
    const pvc = (await k8s(pvcPath(namespace, claim))) as PvcBody;
    const sc = pvc.spec?.storageClassName;
    // An empty (or absent) storageClassName is manual PV binding — the hostPath
    // case. There is no CSI driver to resize, so a patch would be accepted by
    // the API server and then do nothing at all, which is the worst outcome:
    // the alert clears from the PVC spec while the disk keeps filling.
    if (!sc) {
      incCounter('pvc_autoexpand_total', { ...labels, result: 'not-expandable' });
      return { namespace, claim, outcome: 'not-expandable', detail: 'claim has no storageClassName (manual PV binding)' };
    }

    const currentStr = pvc.spec?.resources?.requests?.storage;
    const currentBytes = currentStr ? parseQuantityToBytes(currentStr) : null;
    if (!currentBytes) {
      incCounter('pvc_autoexpand_total', { ...labels, result: 'error' });
      return { namespace, claim, outcome: 'error', detail: `unreadable storage request: ${currentStr}` };
    }

    const originalStr = pvc.metadata?.annotations?.[ORIGINAL_ANNOTATION];
    const originalBytes = (originalStr && parseQuantityToBytes(originalStr)) || currentBytes;

    const decision = nextSizeGi(currentBytes, originalBytes, cfg);
    if ('atCeiling' in decision) {
      incCounter('pvc_autoexpand_total', { ...labels, result: 'at-ceiling' });
      // A gauge, not just a counter: "this claim is pinned at its ceiling" is a
      // STATE an alert should hold on, not an event that scrolls past.
      setGauge('pvc_autoexpand_at_ceiling', labels, 1);
      logger.warn('PVC at its auto-expand ceiling; not expanding', {
        namespace, claim, currentGi: currentBytes / GIB, ceilingGi: decision.ceilingGi,
      });
      return {
        namespace,
        claim,
        outcome: 'at-ceiling',
        fromGi: currentBytes / GIB,
        detail: `at the ${decision.ceilingGi}Gi ceiling — investigate what is writing, this will not grow further`,
      };
    }

    const toGi = decision.toGi;
    const patch = {
      metadata: {
        annotations: {
          // Pin the original once, so the ceiling never compounds.
          ...(originalStr ? {} : { [ORIGINAL_ANNOTATION]: currentStr }),
          [LAST_ANNOTATION]: new Date().toISOString(),
        },
      },
      spec: { resources: { requests: { storage: `${toGi}Gi` } } },
    };
    await k8s(pvcPath(namespace, claim), {
      method: 'PATCH',
      contentType: 'application/merge-patch+json',
      body: JSON.stringify(patch),
    });

    // A StatefulSet claim's size lives in volumeClaimTemplates, which is
    // immutable — the manifest now disagrees with the live claim, and a replica
    // created later comes back at the old size.
    if (/^data-(rustfs|redis)-\d+$/.test(claim)) {
      setGauge('pvc_autoexpand_template_drift', labels, 1);
      logger.warn('Expanded a StatefulSet claim; volumeClaimTemplates still says the old size', { namespace, claim, toGi });
    }

    incCounter('pvc_autoexpand_total', { ...labels, result: 'expanded' });
    setGauge('pvc_autoexpand_at_ceiling', labels, 0);
    logger.info('PVC expanded', { namespace, claim, fromGi: currentBytes / GIB, toGi });
    return { namespace, claim, outcome: 'expanded', fromGi: currentBytes / GIB, toGi };
  } catch (err) {
    incCounter('pvc_autoexpand_total', { ...labels, result: 'error' });
    logger.error('PVC auto-expand failed', { namespace, claim, error: errorMessage(err) });
    // Release the cooldown: the window exists to respect EBS's refusal to modify
    // twice, and nothing was modified. Holding it would blind us for 6h after a
    // transient API error.
    if (redis) await redis.del(key).catch(() => undefined);
    return { namespace, claim, outcome: 'error', detail: errorMessage(err) };
  }
}
