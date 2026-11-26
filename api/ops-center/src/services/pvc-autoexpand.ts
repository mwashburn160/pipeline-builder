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
 * StatefulSet claims (data-rustfs-*, data-redis-*, postgres-replica-data-*) ARE
 * expanded, by explicit decision. Their size comes from volumeClaimTemplates,
 * which is immutable on a live StatefulSet, so patching the live claim leaves
 * the manifest behind: a replica created later provisions at the OLD size. That
 * divergence is reported through `pvc_autoexpand_template_drift` so it cannot
 * rot silently — set at once on expansion, and RECOMPUTED from the cluster by
 * {@link reconcileTemplateDrift} on a sweep, so it survives a pod restart and
 * clears once the StatefulSet is recreated with the new size.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '../observability/metrics.js';
import { k8sRequest } from '../utils/k8s-client.js';
import { getRedisClient } from '../utils/redis-client.js';

const logger = createLogger('pvc-autoexpand');

const GIB = 1024 ** 3;

/**
 * The StatefulSets whose claims this controller may grow, with the
 * volumeClaimTemplate each one's claims come from. Kubernetes names those claims
 * `<template>-<statefulset>-<ordinal>`.
 */
export const TEMPLATED_STATEFULSETS: readonly { statefulSet: string; template: string }[] = [
  { statefulSet: 'rustfs', template: 'data' },
  { statefulSet: 'redis', template: 'data' },
  { statefulSet: 'postgres-replica', template: 'postgres-replica-data' },
];

/** The StatefulSet a claim was provisioned from, or null for a standalone claim. */
export function statefulSetOfClaim(claim: string): { statefulSet: string; template: string; ordinal: number } | null {
  for (const t of TEMPLATED_STATEFULSETS) {
    const prefix = `${t.template}-${t.statefulSet}-`;
    if (claim.startsWith(prefix) && /^\d+$/.test(claim.slice(prefix.length))) {
      return { ...t, ordinal: Number(claim.slice(prefix.length)) };
    }
  }
  return null;
}

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
    const pvc = (await k8sRequest(pvcPath(namespace, claim))) as PvcBody;
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
    await k8sRequest(pvcPath(namespace, claim), {
      method: 'PATCH',
      contentType: 'application/merge-patch+json',
      body: JSON.stringify(patch),
    });

    // A StatefulSet claim's size lives in volumeClaimTemplates, which is
    // immutable — the manifest now disagrees with the live claim, and a replica
    // created later comes back at the old size.
    if (statefulSetOfClaim(claim)) {
      setDrift(namespace, claim, 1);
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

interface StatefulSetBody {
  spec?: {
    replicas?: number;
    volumeClaimTemplates?: { metadata?: { name?: string }; spec?: { resources?: { requests?: { storage?: string } } } }[];
  };
}

/**
 * Every claim this process has published a drift series for, so a sweep can
 * zero the ones it can no longer see (StatefulSet deleted, claim deleted,
 * scaled away). Without it a series set to 1 keeps its value — and the alert
 * keeps firing — until the pod restarts.
 */
const publishedDrift = new Map<string, { namespace: string; claim: string }>();

function setDrift(namespace: string, claim: string, value: 0 | 1): void {
  publishedDrift.set(`${namespace}/${claim}`, { namespace, claim });
  setGauge('pvc_autoexpand_template_drift', { namespace, claim }, value);
}

const statefulSetPath = (ns: string, name: string) =>
  `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/statefulsets/${encodeURIComponent(name)}`;

/** One claim's drift verdict, as published. */
export interface TemplateDrift {
  claim: string;
  statefulSet: string;
  claimBytes: number;
  templateBytes: number;
  drift: boolean;
}

/**
 * Recompute `pvc_autoexpand_template_drift` from the cluster: for every
 * {@link TEMPLATED_STATEFULSETS} entry present in `namespace`, compare each live
 * claim's requested size with the StatefulSet's volumeClaimTemplates and publish
 * 1 (claim larger than the template) or 0.
 *
 * The gauge used to be set ONCE, in the memory of the pod that did the
 * expansion: nothing ever cleared it, so the alert outlived the fix, and a
 * restart dropped it while the drift was still real. Deriving it from the
 * cluster makes it true on every replica and after every restart.
 *
 * A StatefulSet this target does not run (404) is skipped, and a series this
 * process published earlier for a claim no longer found is zeroed. Never
 * throws: one unreadable object is logged and leaves its claims' gauges as
 * they were.
 */
export async function reconcileTemplateDrift(namespace: string): Promise<TemplateDrift[]> {
  const results: TemplateDrift[] = [];
  for (const { statefulSet, template } of TEMPLATED_STATEFULSETS) {
    // Claims of this StatefulSet published earlier: still checked when the set
    // has since scaled below their ordinal (the claim is retained and comes
    // back with the replica), and zeroed once they are gone.
    const earlier = [...publishedDrift.values()]
      .filter((p) => p.namespace === namespace && statefulSetOfClaim(p.claim)?.statefulSet === statefulSet)
      .map((p) => p.claim);
    let sts: StatefulSetBody;
    try {
      sts = (await k8sRequest(statefulSetPath(namespace, statefulSet))) as StatefulSetBody;
    } catch (err) {
      if (/-> 404\b/.test(errorMessage(err))) {
        // No StatefulSet, so no template for a new replica to provision from.
        for (const claim of earlier) setDrift(namespace, claim, 0);
      } else {
        logger.warn('Template drift: StatefulSet unreadable', { namespace, statefulSet, error: errorMessage(err) });
      }
      continue;
    }
    const tpl = sts.spec?.volumeClaimTemplates?.find((t) => t.metadata?.name === template);
    const templateBytes = parseQuantityToBytes(tpl?.spec?.resources?.requests?.storage ?? '');
    if (templateBytes === null) {
      logger.warn('Template drift: no readable size in volumeClaimTemplates', { namespace, statefulSet, template });
      continue;
    }
    const replicas = sts.spec?.replicas ?? 0;
    const claims = new Set(Array.from({ length: replicas }, (_, i) => `${template}-${statefulSet}-${i}`));
    for (const claim of earlier) claims.add(claim);
    for (const claim of claims) {
      try {
        const pvc = (await k8sRequest(pvcPath(namespace, claim))) as PvcBody;
        const claimBytes = parseQuantityToBytes(pvc.spec?.resources?.requests?.storage ?? '');
        if (claimBytes === null) continue;
        const drift = claimBytes > templateBytes;
        setDrift(namespace, claim, drift ? 1 : 0);
        results.push({ claim, statefulSet, claimBytes, templateBytes, drift });
      } catch (err) {
        if (/-> 404\b/.test(errorMessage(err))) {
          // Not provisioned yet, or deleted: either way not drift.
          if (publishedDrift.has(`${namespace}/${claim}`)) setDrift(namespace, claim, 0);
        } else {
          logger.warn('Template drift: claim unreadable', { namespace, claim, error: errorMessage(err) });
        }
      }
    }
  }
  return results;
}
