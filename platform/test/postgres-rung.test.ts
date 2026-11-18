// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Vertical scaling for Postgres — the ladder and, more importantly, the guards.
 *
 * WHAT IS AT RISK. A rung change RESTARTS a database container: on the single
 * primary that is a brief write interruption, chosen by a controller rather than
 * a person. So the valuable tests here are not the happy path but every reason
 * this must decline to act:
 *
 *   - past the ceiling, which is EXACTLY the namespace LimitRange's container
 *     max — a limit above it means the pod cannot be created AT ALL and there
 *     is no pod to debug;
 *   - below the floor, where the data tier stops being Guaranteed QoS;
 *   - a standby that could still scale OUT, because adding one adds read
 *     capacity without restarting anything;
 *   - a standby that would drop below the primary and stop being a promotion
 *     candidate;
 *   - no Redis, which means no cooldown and no cross-replica lock, so two
 *     platform replicas would both restart the primary.
 *
 * And one correctness property that is easy to lose in a refactor: the patch
 * must move resources AND the derived server config TOGETHER, preserving the
 * flags the ladder does not own (`max_slot_wal_keep_size` differs per target;
 * the standby carries `hot_standby_feedback`). A rung that moved memory and
 * left `shared_buffers` behind would report success and buy page cache.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockRedis = {
  set: jest.fn<(...a: unknown[]) => Promise<unknown>>(),
  del: jest.fn<(...a: unknown[]) => Promise<unknown>>(),
};
let redisAvailable = true;
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: () => Promise.resolve(redisAvailable ? mockRedis : null),
}));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: jest.fn(),
  setGauge: jest.fn(),
  observe: jest.fn(),
}));
jest.unstable_mockModule('fs/promises', () => ({
  readFile: () => Promise.resolve('fake-sa-token'),
}));

const { RUNGS, applyRungToArgs, cpuToMillis, currentRung, scaleRung } =
  await import('../src/services/postgres-rung.js');

const FLOOR_ARGS = [
  '-c', 'max_connections=200',
  '-c', 'shared_buffers=512MB',
  '-c', 'effective_cache_size=1200MB',
  '-c', 'work_mem=4MB',
  '-c', 'max_wal_senders=10',
  '-c', 'max_slot_wal_keep_size=4GB',
];

const cfg = { enabled: true, cooldownSeconds: 1800, maxRung: 2, replicaMax: 2, maxRungReplica: 2 };

/** A workload body as the API server would return it. */
const body = (container: string, cpu: string, memory: string, args = FLOOR_ARGS, status?: Record<string, number>) => ({
  spec: {
    template: {
      spec: {
        containers: [
          { name: container, args, resources: { limits: { cpu, memory }, requests: { cpu, memory } } },
          { name: 'postgres-exporter', resources: { limits: { cpu: '100m', memory: '128Mi' } } },
        ],
      },
    },
  },
  status: status ?? {},
});

/** Queue of fetch responses, consumed in order; captures the requests made. */
let responses: unknown[] = [];
let requests: { url: string; method: string; body?: string; contentType?: string }[] = [];

beforeEach(() => {
  redisAvailable = true;
  mockRedis.set.mockReset().mockResolvedValue('OK');
  mockRedis.del.mockReset().mockResolvedValue(1);
  responses = [];
  requests = [];
  process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
  process.env.KUBERNETES_SERVICE_PORT = '443';
  globalThis.fetch = jest.fn(async (url: unknown, init?: unknown) => {
    const i = (init ?? {}) as { method?: string; body?: string; headers?: Record<string, string> };
    requests.push({
      url: String(url),
      method: i.method ?? 'GET',
      body: i.body,
      contentType: i.headers?.['content-type'],
    });
    const next = responses.shift() ?? {};
    return { ok: true, json: async () => next, text: async () => '' } as Response;
  }) as typeof fetch;
});

describe('cpuToMillis', () => {
  it('reads both forms Kubernetes writes', () => {
    expect(cpuToMillis('1000m')).toBe(1000);
    expect(cpuToMillis('2')).toBe(2000);
    expect(cpuToMillis('1.5')).toBe(1500);
    expect(cpuToMillis(' 4000m ')).toBe(4000);
  });

  it('rejects nonsense rather than guessing', () => {
    // A misread limit would place the workload on the wrong rung, and the next
    // scale-up would then jump or stall.
    expect(cpuToMillis('')).toBeNull();
    expect(cpuToMillis('lots')).toBeNull();
    expect(cpuToMillis('1Gi')).toBeNull();
  });
});

describe('currentRung', () => {
  it('maps each rung\'s own CPU back to its index', () => {
    RUNGS.forEach((r, i) => expect(currentRung(r.cpu)).toBe(i));
  });

  it('rounds a between-rungs value DOWN', () => {
    // An operator who hand-edited the manifest to 3 CPU is between rungs.
    // Refusing to act would leave the ladder stuck for whoever inherits it;
    // rounding down means the next scale-up lands on a real rung rather than
    // skipping one.
    expect(currentRung('3000m')).toBe(1);
    expect(currentRung('1500m')).toBe(0);
  });

  it('clamps a value above the ceiling to the top rung', () => {
    expect(currentRung('8000m')).toBe(RUNGS.length - 1);
  });

  it('is null for an unreadable limit', () => {
    expect(currentRung(undefined)).toBeNull();
    expect(currentRung('nonsense')).toBeNull();
  });
});

describe('applyRungToArgs', () => {
  it('moves only the two flags the ladder owns', () => {
    const out = applyRungToArgs(FLOOR_ARGS, RUNGS[2]);
    expect(out).toEqual([
      '-c', 'max_connections=200',
      '-c', 'shared_buffers=2GB',
      '-c', 'effective_cache_size=4800MB',
      '-c', 'work_mem=4MB',
      '-c', 'max_wal_senders=10',
      '-c', 'max_slot_wal_keep_size=4GB',
    ]);
  });

  it('preserves per-target and standby-only flags', () => {
    // max_slot_wal_keep_size is 4GB on AWS and 256MB locally; the standby
    // carries two flags the primary does not. Emitting a canonical list instead
    // of rewriting the live one would silently delete them — and dropping
    // max_slot_wal_keep_size removes the guard that stops a stuck standby
    // filling the PRIMARY's volume and stopping writes.
    const standby = [...FLOOR_ARGS.slice(0, -2), '-c', 'max_slot_wal_keep_size=256MB',
      '-c', 'max_standby_streaming_delay=30s', '-c', 'hot_standby_feedback=on'];
    const out = applyRungToArgs(standby, RUNGS[1]);
    expect(out).toContain('max_slot_wal_keep_size=256MB');
    expect(out).toContain('max_standby_streaming_delay=30s');
    expect(out).toContain('hot_standby_feedback=on');
    expect(out).toContain('shared_buffers=1GB');
  });

  it('leaves a list with no owned flags untouched', () => {
    expect(applyRungToArgs(['-c', 'max_connections=200'], RUNGS[2]))
      .toEqual(['-c', 'max_connections=200']);
  });

  it('does not trip over a trailing -c with no value', () => {
    expect(applyRungToArgs(['-c'], RUNGS[0])).toEqual(['-c']);
  });

  it('keeps shared_buffers at 25% of every rung\'s memory limit', () => {
    // The pairing the ladder exists to enforce. If these drift, a rung change
    // raises the pod and buys page cache.
    const mib = (q: string) => (/Gi$/.test(q) ? parseInt(q, 10) * 1024 : parseInt(q, 10));
    const sb = (q: string) => (/GB$/.test(q) ? parseInt(q, 10) * 1024 : parseInt(q, 10));
    for (const r of RUNGS) expect(Math.round((sb(r.sharedBuffers) / mib(r.memory)) * 100)).toBe(25);
  });
});

describe('scaleRung — the guards', () => {
  it('does nothing while disabled', async () => {
    const r = await scaleRung('ns', 'primary', 'up', { ...cfg, enabled: false });
    expect(r.outcome).toBe('disabled');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses to act with no Redis, rather than acting without a cooldown', async () => {
    // Fail CLOSED. Without Redis there is no cross-replica mutual exclusion, so
    // two platform replicas receiving the same Alertmanager fan-out would both
    // patch — restarting the primary twice.
    redisAvailable = false;
    const r = await scaleRung('ns', 'primary', 'up', cfg);
    expect(r.outcome).toBe('error');
    expect(r.detail).toMatch(/Redis unavailable/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('declines inside the cooldown window', async () => {
    mockRedis.set.mockResolvedValue(null); // NX lost
    const r = await scaleRung('ns', 'primary', 'up', cfg);
    expect(r.outcome).toBe('cooldown');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('will not go past the ceiling', async () => {
    responses = [body('postgres', '4000m', '8Gi')];
    const r = await scaleRung('ns', 'primary', 'up', cfg);
    expect(r.outcome).toBe('at-ceiling');
    expect(r.fromRung).toBe(2);
    // The LimitRange is an admission gate, so the message has to say what to do
    // rather than just that it stopped.
    expect(r.detail).toMatch(/LimitRange/);
    expect(requests.some((q) => q.method === 'PATCH')).toBe(false);
  });

  it('respects a lowered ceiling', async () => {
    responses = [body('postgres', '2000m', '4Gi')];
    const r = await scaleRung('ns', 'primary', 'up', { ...cfg, maxRung: 1 });
    expect(r.outcome).toBe('at-ceiling');
  });

  it('caps a standby at its OWN ceiling, below the primary\'s', async () => {
    // The default shape: POSTGRES_RUNG_MAX=2 for the primary, 1 for a standby,
    // so two standbys cost 4 CPU rather than 8. At replicaMax the out-first
    // guard has already passed, so this is the next thing that stops it.
    responses = [body('postgres-replica', '2000m', '4Gi', FLOOR_ARGS, { replicas: 2 })];
    const r = await scaleRung('ns', 'replica', 'up', { ...cfg, maxRungReplica: 1 });
    expect(r.outcome).toBe('at-ceiling');
    expect(r.fromRung).toBe(1);
    expect(requests.some((q) => q.method === 'PATCH')).toBe(false);
  });

  it('refuses to raise the PRIMARY above the standby ceiling', async () => {
    // The invariant from the other side. A standby smaller than the primary
    // cannot be promoted, and with its own ceiling it can no longer catch up by
    // scaling — so the primary must stop where the standby stops, rather than
    // climbing and silently making every standby unpromotable.
    responses = [body('postgres', '2000m', '4Gi')];
    const r = await scaleRung('ns', 'primary', 'up', { ...cfg, maxRung: 2, maxRungReplica: 1 });
    expect(r.outcome).toBe('above-replica-ceiling');
    expect(r.fromRung).toBe(1);
    expect(r.detail).toMatch(/POSTGRES_RUNG_MAX_REPLICA/);
    expect(requests.some((q) => q.method === 'PATCH')).toBe(false);
  });

  it('still lets the primary climb when the standby ceiling allows it', async () => {
    // Guards the guard: with both ceilings at 2 the primary reaches rung 2, so
    // the refusal above is about the CAP and not a blanket block on scaling up.
    responses = [body('postgres', '2000m', '4Gi')];
    const r = await scaleRung('ns', 'primary', 'up', { ...cfg, maxRung: 2, maxRungReplica: 2 });
    expect(r.outcome).toBe('scaled');
    expect(r.toRung).toBe(2);
  });

  it('will not go below the floor', async () => {
    responses = [body('postgres', '1000m', '2Gi')];
    const r = await scaleRung('ns', 'primary', 'down', cfg);
    expect(r.outcome).toBe('at-floor');
    expect(requests.some((q) => q.method === 'PATCH')).toBe(false);
  });

  it('sends a standby to KEDA first while it can still scale OUT', async () => {
    // Out before up: another standby adds read capacity without restarting
    // anything, where a rung change restarts every standby.
    responses = [body('postgres-replica', '1000m', '2Gi', FLOOR_ARGS, { replicas: 1 })];
    const r = await scaleRung('ns', 'replica', 'up', cfg);
    expect(r.outcome).toBe('not-at-replica-max');
    expect(r.detail).toMatch(/1 of 2 standbys/);
    expect(requests.some((q) => q.method === 'PATCH')).toBe(false);
    // The cooldown is released: nothing changed, and holding it would block the
    // real decision once KEDA has finished scaling out.
    expect(mockRedis.del).toHaveBeenCalled();
  });

  it('scales a standby UP once it is at the replica ceiling', async () => {
    responses = [body('postgres-replica', '1000m', '2Gi', FLOOR_ARGS, { replicas: 2 })];
    const r = await scaleRung('ns', 'replica', 'up', cfg);
    expect(r.outcome).toBe('scaled');
    expect(r.toRung).toBe(1);
  });

  it('will not drop a standby below the primary\'s rung', async () => {
    // A standby smaller than the primary cannot be promoted, which is most of
    // the reason to keep one.
    responses = [
      body('postgres-replica', '2000m', '4Gi'), // standby at rung 1
      body('postgres', '2000m', '4Gi'), // primary also at rung 1
    ];
    const r = await scaleRung('ns', 'replica', 'down', cfg);
    expect(r.outcome).toBe('below-primary');
    expect(r.detail).toMatch(/cannot be promoted/);
    expect(requests.some((q) => q.method === 'PATCH')).toBe(false);
  });

  it('drops a standby that is above the primary', async () => {
    responses = [
      body('postgres-replica', '4000m', '8Gi'), // standby at rung 2
      body('postgres', '1000m', '2Gi'), // primary at the floor
    ];
    const r = await scaleRung('ns', 'replica', 'down', cfg);
    expect(r.outcome).toBe('scaled');
    expect(r.toRung).toBe(1);
  });

  it('releases the cooldown when the API call fails', async () => {
    // The window exists to space out real changes. Holding it after a transient
    // error would blind the controller for the whole window.
    globalThis.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }) as Response) as typeof fetch;
    const r = await scaleRung('ns', 'primary', 'up', cfg);
    expect(r.outcome).toBe('error');
    expect(mockRedis.del).toHaveBeenCalled();
  });

  it('reports an unreadable cpu limit instead of guessing a rung', async () => {
    responses = [body('postgres', 'nonsense', '2Gi')];
    const r = await scaleRung('ns', 'primary', 'up', cfg);
    expect(r.outcome).toBe('error');
    expect(r.detail).toMatch(/unreadable cpu limit/);
  });
});

describe('scaleRung — the patch it sends', () => {
  it('moves resources and the server config together, in one strategic merge patch', async () => {
    responses = [body('postgres', '1000m', '2Gi')];
    const r = await scaleRung('ns', 'primary', 'up', cfg);
    expect(r).toMatchObject({ outcome: 'scaled', fromRung: 0, toRung: 1 });

    const patch = requests.find((q) => q.method === 'PATCH')!;
    expect(patch.url).toContain('/apis/apps/v1/namespaces/ns/deployments/postgres');
    // STRATEGIC merge patch, not a plain merge patch: `containers` has a merge
    // key of `name`, so this touches one container. A plain merge patch would
    // replace the whole array and delete the metrics sidecar.
    expect(patch.contentType).toBe('application/strategic-merge-patch+json');

    const sent = JSON.parse(patch.body!);
    const containers = sent.spec.template.spec.containers;
    expect(containers).toHaveLength(1);
    expect(containers[0].name).toBe('postgres');
    // requests EQUAL limits: the data tier stays Guaranteed QoS.
    expect(containers[0].resources.limits).toEqual({ cpu: '2000m', memory: '4Gi' });
    expect(containers[0].resources.requests).toEqual(containers[0].resources.limits);
    // ...and the paired server config moved in the SAME patch.
    expect(containers[0].args).toContain('shared_buffers=1GB');
    expect(containers[0].args).toContain('effective_cache_size=2400MB');
    // ...while the flags the ladder does not own survived.
    expect(containers[0].args).toContain('max_slot_wal_keep_size=4GB');
    expect(containers[0].args).toContain('max_connections=200');
  });

  it('targets the StatefulSet for a standby, not a Deployment', async () => {
    responses = [body('postgres-replica', '1000m', '2Gi', FLOOR_ARGS, { replicas: 2 })];
    await scaleRung('ns', 'replica', 'up', cfg);
    const patch = requests.find((q) => q.method === 'PATCH')!;
    expect(patch.url).toContain('/statefulsets/postgres-replica');
  });

  it('leaves a breadcrumb for kubectl describe', async () => {
    responses = [body('postgres', '1000m', '2Gi')];
    await scaleRung('ns', 'primary', 'up', cfg);
    const sent = JSON.parse(requests.find((q) => q.method === 'PATCH')!.body!);
    expect(sent.metadata.annotations['pipeline-builder.io/rung-last']).toMatch(/rung 0->1/);
  });
});
