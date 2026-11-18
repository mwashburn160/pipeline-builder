// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Vertical scaling for Postgres — the resource ladder, driven by the saturation
 * and underutilisation alerts.
 *
 * Alertmanager routes the Postgres CPU/memory alerts here (see each target's
 * config/alertmanager/alertmanager.yml) and this moves the workload one RUNG up
 * or down. Shaped after {@link ./pvc-autoexpand.ts}, for the same reasons: a
 * mutation endpoint must not share a blast radius with the notification relay,
 * and the safety properties (ceiling, cooldown, no-op-is-explained) are the same
 * three.
 *
 * WHY A RUNG AND NOT TWO DIALS. CPU and memory are not independent here,
 * because the SERVER CONFIG is derived from the memory figure: `shared_buffers`
 * is 25% of the limit and `effective_cache_size` ~60%. Raising the pod and
 * leaving those flags alone buys page cache and almost nothing else — Postgres
 * runs on the image default of 128MB of shared buffers however much memory the
 * pod is given. So a change moves a whole row of the ladder, patching
 * `resources` AND `args` in ONE request.
 *
 * WHY NOT THE VERTICAL POD AUTOSCALER. VPA is the obvious tool and it cannot do
 * this job: it patches `resources` and not `args`, so it would raise memory to
 * 8Gi and leave `shared_buffers` at 512MB — exactly the half-applied rung the
 * ladder exists to prevent, and one that reports success. It also evicts to
 * resize by default, which on a single primary is write downtime at a moment
 * the autoscaler chooses rather than the operator.
 *
 * WRITES DO NOT SCALE HORIZONTALLY, and nothing here changes that. Streaming
 * replication gives exactly one primary, so the write path's only levers are
 * this ladder or less work. The STANDBYS scale out first (KEDA) and reach this
 * ladder only at their replica ceiling — out before up.
 *
 * A RUNG CHANGE RESTARTS THE CONTAINER. `shared_buffers` is read at startup, so
 * the manifests set `resizePolicy: memory -> RestartContainer`: the restart the
 * config change needs anyway. On the primary that is a brief write interruption,
 * which is why the cooldown here is long and the scale-down signal is slow.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '../observability/metrics.js';
import { k8sRequest } from '../utils/k8s-client.js';
import { getRedisClient } from '../utils/redis-client.js';

const logger = createLogger('postgres-rung');


/** Human breadcrumb for `kubectl describe`. */
export const LAST_ANNOTATION = 'pipeline-builder.io/rung-last';

/**
 * One row of the ladder. These MUST match the manifests' floor rung, or the
 * first scale-up would silently also change settings nobody chose —
 * postgres-rung-contract.test.ts asserts the floor here equals what
 * k8s/postgres.yaml ships.
 *
 * Memory is 2Gi per vCPU at every rung; `shared_buffers` 25% of the limit and
 * `effective_cache_size` ~60%, the conventional Postgres ratios.
 */
export interface Rung {
  cpu: string;
  memory: string;
  sharedBuffers: string;
  effectiveCacheSize: string;
}

export const RUNGS: readonly Rung[] = [
  { cpu: '1000m', memory: '2Gi', sharedBuffers: '512MB', effectiveCacheSize: '1200MB' },
  { cpu: '2000m', memory: '4Gi', sharedBuffers: '1GB', effectiveCacheSize: '2400MB' },
  // THE CEILING IS THE NAMESPACE'S HARD CAP, with zero headroom.
  // k8s/resource-limits.yaml is a LimitRange with container `max: cpu "4"`, and
  // a LimitRange is an ADMISSION GATE: a container whose limit exceeds it cannot
  // be created at all — the ReplicaSet emits `pods "..." is forbidden` and the
  // workload sits at 0/1 with no pod to inspect. So 4000m is not a policy
  // choice that can be raised here; going past it means raising the LimitRange
  // FIRST, which is a namespace-wide change affecting every workload.
  { cpu: '4000m', memory: '8Gi', sharedBuffers: '2GB', effectiveCacheSize: '4800MB' },
];

export type Workload = 'primary' | 'replica';
export type Direction = 'up' | 'down';

/** Which Kubernetes object and container each workload is. */
const TARGETS: Record<Workload, { kind: 'deployments' | 'statefulsets'; name: string; container: string }> = {
  primary: { kind: 'deployments', name: 'postgres', container: 'postgres' },
  replica: { kind: 'statefulsets', name: 'postgres-replica', container: 'postgres-replica' },
};

export interface PostgresRungConfig {
  enabled: boolean;
  /** Seconds to hold after a decision. A rung change restarts the container. */
  cooldownSeconds: number;
  /** Highest rung index this deployment may reach (0-based). */
  maxRung: number;
  /**
   * Highest rung a STANDBY may reach, capped separately from the primary.
   *
   * Reads scale OUT before they scale UP, so a standby rarely needs the top
   * rung, and the replica COUNT multiplies whatever this is: rung 1 across two
   * standbys is 4 CPU where rung 2 would be 8. The primary is held to this
   * ceiling on the way up as well, so a standby can always match it.
   */
  maxRungReplica: number;
  /** The standby replica ceiling, so `replica` only scales UP at max replicas. */
  replicaMax: number;
}

export type RungOutcome =
  | 'scaled'
  | 'cooldown'
  | 'at-ceiling'
  | 'at-floor'
  | 'not-at-replica-max'
  | 'below-primary'
  | 'above-replica-ceiling'
  | 'disabled'
  | 'error';

export interface RungResult {
  workload: Workload;
  direction: Direction;
  outcome: RungOutcome;
  fromRung?: number;
  toRung?: number;
  detail?: string;
}

/** `1000m` / `2` / `2500m` -> millicores. */
export function cpuToMillis(q: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === 'm' ? n : n * 1000;
}

/**
 * Which rung a workload is currently on.
 *
 * Matched on CPU alone, and deliberately by NEAREST-AT-OR-BELOW rather than
 * exact equality: an operator who hand-edited the manifest to 3 CPU is between
 * rungs, and refusing to act would leave the ladder stuck for whoever inherits
 * it. Rounding DOWN means the next scale-up lands on a real rung rather than
 * jumping past one.
 */
export function currentRung(cpuLimit: string | undefined): number | null {
  const millis = cpuLimit ? cpuToMillis(cpuLimit) : null;
  if (millis === null) return null;
  let idx = 0;
  for (let i = 0; i < RUNGS.length; i++) {
    if (cpuToMillis(RUNGS[i].cpu)! <= millis) idx = i;
  }
  return idx;
}

interface WorkloadBody {
  spec?: {
    replicas?: number;
    template?: { spec?: { containers?: { name: string; args?: string[]; resources?: { limits?: Record<string, string> } }[] } };
  };
  status?: { replicas?: number; readyReplicas?: number };
}


const workloadPath = (ns: string, w: Workload) =>
  `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/${TARGETS[w].kind}/${encodeURIComponent(TARGETS[w].name)}`;

/**
 * Rewrite the `-c key=value` server flags for a rung, preserving every flag the
 * ladder does not own.
 *
 * Rebuilt from the EXISTING args rather than emitted from a template, because
 * the list legitimately differs per target and per workload:
 * `max_slot_wal_keep_size` is 4GB on AWS and 256MB locally, and the standby
 * carries `max_standby_streaming_delay` and `hot_standby_feedback` that the
 * primary does not. Emitting a canonical list would quietly delete them.
 */
export function applyRungToArgs(args: readonly string[], rung: Rung): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && i + 1 < args.length) {
      const [key] = args[i + 1].split('=', 1);
      const replacement =
        key === 'shared_buffers' ? `shared_buffers=${rung.sharedBuffers}`
          : key === 'effective_cache_size' ? `effective_cache_size=${rung.effectiveCacheSize}`
            : args[i + 1];
      out.push('-c', replacement);
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * Move one workload one rung. Returns WHY when it does not, because "nothing
 * happened" is what an operator most needs explained while an alert is firing.
 */
export async function scaleRung(
  namespace: string,
  workload: Workload,
  direction: Direction,
  cfg: PostgresRungConfig,
): Promise<RungResult> {
  const labels = { workload, direction };
  const base: RungResult = { workload, direction, outcome: 'error' };
  if (!cfg.enabled) {
    incCounter('postgres_rung_total', { ...labels, result: 'disabled' });
    return { ...base, outcome: 'disabled', detail: 'POSTGRES_RUNG_ENABLED is not true' };
  }

  // Cooldown FIRST — cheaper than a round trip, and the point is to not act
  // twice inside a window where the previous change is still settling. A rung
  // change restarts the container; on the primary that is a write interruption.
  const redis = await getRedisClient();
  const key = `postgres:rung:${namespace}/${workload}`;
  if (!redis) {
    // Fail CLOSED, as pvc-autoexpand does. Without Redis there is no cooldown
    // and no cross-replica mutual exclusion, so two platform replicas receiving
    // the same Alertmanager fan-out would both patch — restarting the primary
    // twice. Not scaling is strictly better.
    incCounter('postgres_rung_total', { ...labels, result: 'error' });
    logger.error('Postgres rung change skipped: no Redis, so no cooldown or cross-replica lock');
    return { ...base, detail: 'Redis unavailable; refusing to scale without a cooldown' };
  }
  const won = await redis.set(key, String(Date.now()), 'EX', cfg.cooldownSeconds, 'NX');
  if (won !== 'OK') {
    incCounter('postgres_rung_total', { ...labels, result: 'cooldown' });
    return { ...base, outcome: 'cooldown', detail: `within ${cfg.cooldownSeconds}s of the last decision` };
  }

  try {
    const body = (await k8sRequest(workloadPath(namespace, workload))) as WorkloadBody;
    const container = body.spec?.template?.spec?.containers?.find((c) => c.name === TARGETS[workload].container);
    if (!container) throw new Error(`container ${TARGETS[workload].container} not found`);

    const from = currentRung(container.resources?.limits?.cpu);
    if (from === null) {
      incCounter('postgres_rung_total', { ...labels, result: 'error' });
      return { ...base, detail: `unreadable cpu limit: ${container.resources?.limits?.cpu}` };
    }
    setGauge('postgres_rung_current', { workload }, from);

    // ---- STANDBY: out before up -------------------------------------------
    // The vertical ladder is stage TWO. While KEDA can still add a standby,
    // adding one is strictly better than making each one bigger: it adds read
    // capacity without restarting anything, where a rung change restarts every
    // standby. `PostgresReadReplicaSaturated` is tuned above KEDA's threshold
    // so that reaching here already means the autoscaler could not fix it, but
    // the count is checked rather than assumed — the alert cannot see it.
    if (workload === 'replica' && direction === 'up') {
      const live = body.status?.replicas ?? body.spec?.replicas ?? 0;
      if (live < cfg.replicaMax) {
        incCounter('postgres_rung_total', { ...labels, result: 'not-at-replica-max' });
        await redis.del(key).catch(() => undefined);
        return {
          ...base,
          outcome: 'not-at-replica-max',
          detail: `${live} of ${cfg.replicaMax} standbys running — scaling OUT is cheaper than UP, so KEDA goes first`,
        };
      }
    }

    // Per-workload: a standby is capped below the primary (see
    // `maxRungReplica`), so these cannot collapse into one number.
    const replicaCeiling = Math.min(cfg.maxRungReplica, RUNGS.length - 1);
    const ceiling = Math.min(workload === 'replica' ? cfg.maxRungReplica : cfg.maxRung, RUNGS.length - 1);
    let to = direction === 'up' ? from + 1 : from - 1;

    // ---- PRIMARY: never above what a standby may reach --------------------
    // The mirror of the below-primary guard below. That one stops a standby
    // shrinking under the primary; this stops the primary growing past where a
    // standby is ALLOWED to follow — the same invariant from the other side.
    // Once the standby has its own ceiling it can no longer catch up by
    // scaling, so without this, raising the primary to rung 2 against a rung-1
    // replica ceiling silently makes every standby unpromotable.
    // `to <= ceiling` matters: when the primary is already at its OWN top rung
    // the honest answer is `at-ceiling` (handled below), not a complaint about
    // the standby cap. This fires only when the standby cap is the STRICTER of
    // the two, which is the case worth naming separately.
    if (workload === 'primary' && direction === 'up' && to <= ceiling && to > replicaCeiling) {
      incCounter('postgres_rung_total', { ...labels, result: 'above-replica-ceiling' });
      return {
        ...base,
        outcome: 'above-replica-ceiling',
        fromRung: from,
        detail: `rung ${to} is above the standby ceiling (rung ${replicaCeiling}, `
          + `${RUNGS[replicaCeiling].cpu}/${RUNGS[replicaCeiling].memory}); a standby that cannot match the `
          + 'primary cannot be promoted — raise POSTGRES_RUNG_MAX_REPLICA first',
      };
    }

    // ---- STANDBY: never below the primary ----------------------------------
    // Postgres refuses to start a hot standby whose max_connections (and four
    // other settings) is LOWER than the primary's. Those happen to be
    // rung-invariant here — all three rungs ship max_connections=200 — so a
    // rung change cannot strand a standby today. The floor is enforced anyway,
    // because a standby smaller than the primary is a standby that cannot be
    // promoted, which is most of the reason to keep one.
    if (workload === 'replica' && direction === 'down') {
      const primary = (await k8sRequest(workloadPath(namespace, 'primary'))) as WorkloadBody;
      const pc = primary.spec?.template?.spec?.containers?.find((c) => c.name === 'postgres');
      const primaryRung = currentRung(pc?.resources?.limits?.cpu);
      if (primaryRung !== null && to < primaryRung) {
        incCounter('postgres_rung_total', { ...labels, result: 'below-primary' });
        return {
          ...base,
          outcome: 'below-primary',
          fromRung: from,
          detail: `rung ${to} is below the primary's rung ${primaryRung}; a standby smaller than the primary cannot be promoted`,
        };
      }
    }

    if (to > ceiling) {
      incCounter('postgres_rung_total', { ...labels, result: 'at-ceiling' });
      // A gauge, not only a counter: "pinned at the ceiling" is a STATE an
      // alert should hold on, not an event that scrolls past. At the ceiling the
      // answer is no longer more resources — it is a query, an index, or moving
      // read load to a replica.
      setGauge('postgres_rung_at_ceiling', { workload }, 1);
      logger.warn('Postgres is at its top rung; not scaling up', { workload, rung: from, ceiling });
      return {
        ...base,
        outcome: 'at-ceiling',
        fromRung: from,
        detail: `at rung ${from} of ${ceiling} (${RUNGS[ceiling].cpu}/${RUNGS[ceiling].memory}) — raising this means raising the LimitRange FIRST, or the pod cannot be created at all`,
      };
    }
    if (to < 0) {
      incCounter('postgres_rung_total', { ...labels, result: 'at-floor' });
      return {
        ...base,
        outcome: 'at-floor',
        fromRung: from,
        detail: `already at the floor (${RUNGS[0].cpu}/${RUNGS[0].memory}); the data tier does not go below Guaranteed QoS at 1 CPU`,
      };
    }

    const rung = RUNGS[to];
    // STRATEGIC merge patch, not a plain merge patch: `containers` has a
    // patchMergeKey of `name`, so this touches ONE container and leaves the
    // metrics sidecar alone. A plain merge patch would replace the whole array
    // and delete the exporter.
    //
    // `args` has no merge key and is replaced wholesale, which is what we want
    // — applyRungToArgs rebuilt it from the live list, preserving every flag
    // the ladder does not own.
    const patch = {
      metadata: { annotations: { [LAST_ANNOTATION]: `${new Date().toISOString()} rung ${from}->${to}` } },
      spec: {
        template: {
          spec: {
            containers: [{
              name: TARGETS[workload].container,
              // requests EQUAL limits: the data tier stays Guaranteed QoS, so
              // the scheduler reserves what it may use and will not evict it
              // before a stateless pod.
              resources: {
                limits: { cpu: rung.cpu, memory: rung.memory },
                requests: { cpu: rung.cpu, memory: rung.memory },
              },
              args: applyRungToArgs(container.args ?? [], rung),
            }],
          },
        },
      },
    };
    await k8sRequest(workloadPath(namespace, workload), {
      method: 'PATCH',
      contentType: 'application/strategic-merge-patch+json',
      body: JSON.stringify(patch),
    });

    incCounter('postgres_rung_total', { ...labels, result: 'scaled' });
    setGauge('postgres_rung_current', { workload }, to);
    setGauge('postgres_rung_at_ceiling', { workload }, to >= ceiling ? 1 : 0);
    logger.info('Postgres rung changed', {
      workload,
      direction,
      fromRung: from,
      toRung: to,
      cpu: rung.cpu,
      memory: rung.memory,
      sharedBuffers: rung.sharedBuffers,
    });
    return { workload, direction, outcome: 'scaled', fromRung: from, toRung: to };
  } catch (err) {
    incCounter('postgres_rung_total', { ...labels, result: 'error' });
    logger.error('Postgres rung change failed', { workload, direction, error: errorMessage(err) });
    // Release the cooldown: it exists to space out real changes, and nothing
    // changed. Holding it would blind us for the whole window after a transient
    // API error.
    await redis.del(key).catch(() => undefined);
    return { ...base, detail: errorMessage(err) };
  }
}
