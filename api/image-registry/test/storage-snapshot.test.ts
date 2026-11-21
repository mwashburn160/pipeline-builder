// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for services/storage-snapshot: per-org storage measured in the
 * background and read from a snapshot.
 *
 * SCOPE (unchanged from the on-demand rollup it replaces): an org's total is
 * its own `org-<id>/*` namespace PLUS every `public/*` repository billed to it,
 * a shared (mounted) layer counted once; `quarantine/*` is billed to nobody.
 *
 * FAIL-CLOSED: no snapshot, a stale one, an aborted run, or an org whose scan
 * was incomplete all read as `incomplete` (unknown) — the push gate refuses on
 * it and the usage route answers 503. The run marker is written last.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { registryClientMock } from './helpers/registry-client-mock.js';

const listRepositoriesUnderPrefix = jest.fn<(p: string) => Promise<string[]>>();
const listTags = jest.fn<(name: string) => Promise<{ tags: string[] }>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ body: unknown; digest: string; mediaType: string }>>();
const headBlob = jest.fn<(name: string, digest: string) => Promise<{ contentLength?: number }>>();
jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({
  listRepositoriesUnderPrefix, listTags, getManifest, headBlob,
}));

type Owners = { owners: Map<string, string | null>; complete: boolean };
const readPublicationOwners = jest.fn<(opts?: { force?: boolean; catalog?: readonly string[] }) => Promise<Owners>>();
const publicRepositoriesOwnedBy = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/public-publications.js', () => ({ readPublicationOwners, publicRepositoriesOwnedBy }));

const observe = jest.fn();
const incCounter = jest.fn();
const setGauge = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  observe, incCounter, setGauge,
}));
const createEnvRedisClient = jest.fn<AnyFn>(() => null);
const createEnvRedisLock = jest.fn<AnyFn>(() => null);
const schedulerStart = jest.fn();
const schedulerStop = jest.fn();
const createScheduler = jest.fn<AnyFn>(() => ({ start: schedulerStart, stop: schedulerStop }));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ createEnvRedisClient, createEnvRedisLock, createScheduler }));

type AnyFn = (...args: unknown[]) => unknown;

const {
  readOrgStorageUsage,
  runStorageSnapshot,
  refreshOrgSnapshot,
  maxSnapshotAgeMs,
  setSnapshotStoreForTests,
  startStorageSnapshotScheduler,
  stopStorageSnapshotScheduler,
  SNAPSHOT_PHASE_HISTOGRAM,
  SNAPSHOT_READS_COUNTER,
  SNAPSHOT_RUNS_COUNTER,
  SNAPSHOT_LAST_SUCCESS_GAUGE,
  SNAPSHOT_INTERVAL_GAUGE,
  runStorageSnapshotCycle,
} = await import('../src/services/storage-snapshot.js');
const { invalidateOrgStorageCache } = await import('../src/services/storage-usage.js');

const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const INTERVAL = 600_000;
let SIZES: Record<string, number>;

/** org-acme/app → cfg-own + shared; public/acme/app → cfg-pub + shared (a MOUNT of the same layer). */
const REPO_BLOBS: Record<string, string[]> = {
  'org-acme/app': ['sha256:cfg-own', 'sha256:shared'],
  'public/acme/app': ['sha256:cfg-pub', 'sha256:shared'],
  'public/beta/tool': ['sha256:other'],
  'quarantine/sub-1': ['sha256:other'],
};
let catalog: string[];

/**
 * In-memory store that records write order. `beforeWrite`, when set, is awaited
 * at the start of every write (a test parks one writer there); the compare and
 * the write after it are one synchronous step, as Redis's script is.
 */
function memoryStore() {
  const data = new Map<string, string>();
  const writes: string[] = [];
  const self = {
    data,
    writes,
    beforeWrite: null as null | ((key: string) => Promise<void>),
    seq: 0,
    nextSeq: async () => ++self.seq,
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string, _ttlSeconds?: number) => {
      await self.beforeWrite?.(key);
      data.set(key, value); writes.push(key);
    },
    setIfUnchanged: async (key: string, expected: string | null, value: string, ttlSeconds: number) => {
      await self.beforeWrite?.(key);
      if ((data.get(key) ?? null) !== expected) return false;
      // Through `self.set` (minus its hook) so a test overriding `set` still sees every write.
      const hook = self.beforeWrite;
      self.beforeWrite = null;
      try { await self.set(key, value, ttlSeconds); } finally { self.beforeWrite = hook; }
      return true;
    },
  };
  return self;
}
let store: ReturnType<typeof memoryStore>;

beforeEach(() => {
  jest.clearAllMocks();
  store = memoryStore();
  setSnapshotStoreForTests(store);
  SIZES = { 'sha256:cfg-own': 10, 'sha256:shared': 1000, 'sha256:cfg-pub': 20, 'sha256:other': 5 };
  catalog = ['org-acme/app', 'public/acme/app', 'public/beta/tool', 'quarantine/sub-1', 'registry-meta/publications/acme/app'];
  listRepositoriesUnderPrefix.mockImplementation(async () => catalog);
  readPublicationOwners.mockResolvedValue({
    owners: new Map([['public/acme/app', 'acme'], ['public/beta/tool', 'beta']]),
    complete: true,
  });
  listTags.mockResolvedValue({ tags: ['v1'] });
  getManifest.mockImplementation(async (repo) => {
    const [cfg, ...layers] = REPO_BLOBS[repo]!;
    return { body: { config: { digest: cfg }, layers: layers.map((digest) => ({ digest })) }, digest: `sha256:m-${repo}`, mediaType: MANIFEST };
  });
  headBlob.mockImplementation(async (_repo, digest) => ({ contentLength: SIZES[digest] }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

const run = () => runStorageSnapshot({ intervalMs: INTERVAL });

describe('scope — same as the on-demand rollup it replaces', () => {
  it('bills an org its own namespace plus its published public/* repos, a shared (mounted) layer once', async () => {
    await run();
    // cfg-own 10 + shared 1000 (once) + cfg-pub 20.
    expect(await readOrgStorageUsage('acme')).toMatchObject({ prefix: 'org-acme/', bytes: 1030, blobs: 3, repos: 2, incomplete: false });
    // Another publisher's listing is billed to that publisher, not here.
    expect(await readOrgStorageUsage('beta')).toMatchObject({ bytes: 5, repos: 1, incomplete: false });
  });

  it('counts only the own namespace for an org that publishes nothing', async () => {
    readPublicationOwners.mockResolvedValue({ owners: new Map(), complete: true });
    await run();
    expect(await readOrgStorageUsage('acme')).toMatchObject({ bytes: 1010, repos: 1, incomplete: false });
  });

  it('still bills a publisher whose private copy is gone', async () => {
    catalog = ['public/acme/app'];
    await run();
    expect(await readOrgStorageUsage('acme')).toMatchObject({ bytes: 1020, repos: 1, incomplete: false });
  });

  it('never bills quarantine/* to anyone', async () => {
    await run();
    expect(listTags.mock.calls.some((c) => c[0].startsWith('quarantine/'))).toBe(false);
  });

  it('reads org ids case-insensitively', async () => {
    await run();
    expect((await readOrgStorageUsage('ACME')).bytes).toBe(1030);
  });
});

describe('one catalog walk per run', () => {
  it('lists the catalog once and hands that listing to the publication-record read', async () => {
    await run();
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(1);
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledWith('');
    expect(readPublicationOwners).toHaveBeenCalledWith({ force: true, catalog });
  });
});

describe('fail-closed reads', () => {
  it('no snapshot yet → unknown', async () => {
    expect(await readOrgStorageUsage('acme')).toMatchObject({ incomplete: true, bytes: 0 });
    expect(incCounter).toHaveBeenCalledWith(SNAPSHOT_READS_COUNTER, { outcome: 'missing' });
  });

  it('a snapshot older than two intervals plus the run time → unknown', async () => {
    const meta = (await run())!;
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => meta.completedAt + maxSnapshotAgeMs(meta) - 1);
    expect((await readOrgStorageUsage('acme')).incomplete).toBe(false);
    jest.spyOn(Date, 'now').mockImplementation(() => meta.completedAt + maxSnapshotAgeMs(meta) + 1);
    expect(await readOrgStorageUsage('acme')).toMatchObject({ incomplete: true, bytes: 0 });
    expect(incCounter).toHaveBeenCalledWith(SNAPSHOT_READS_COUNTER, { outcome: 'stale' });
    Date.now = realNow;
  });

  it('max age is derived from the interval and the measured run time', () => {
    expect(maxSnapshotAgeMs({ intervalMs: 600_000, durationMs: 90_000 })).toBe(1_290_000);
  });

  it('unreadable publication records make every org incomplete', async () => {
    readPublicationOwners.mockResolvedValue({ owners: new Map([['public/acme/app', 'acme']]), complete: false });
    await run();
    expect((await readOrgStorageUsage('acme')).incomplete).toBe(true);
  });

  it('publication records that throw: incomplete, own namespace still measured', async () => {
    readPublicationOwners.mockRejectedValue(new Error('registry-meta unreadable'));
    await run();
    expect(await readOrgStorageUsage('acme')).toMatchObject({ incomplete: true, bytes: 1010 });
  });

  it('a published repository that cannot be scanned makes that org incomplete', async () => {
    getManifest.mockImplementation(async (repo) => {
      if (repo.startsWith('public/')) throw Object.assign(new Error('500'), { statusCode: 500 });
      return { body: { config: { digest: 'sha256:cfg-own' }, layers: [] }, digest: 'sha256:m', mediaType: MANIFEST };
    });
    await run();
    expect((await readOrgStorageUsage('acme')).incomplete).toBe(true);
  });

  it('an aborted run (lock lost / shutdown) marks nothing current', async () => {
    const ac = new AbortController();
    ac.abort('lock-lost');
    expect(await runStorageSnapshot({ intervalMs: INTERVAL, signal: ac.signal })).toBeNull();
    expect((await readOrgStorageUsage('acme')).incomplete).toBe(true);
  });

  it('a catalog failure throws (no scheduler success) and writes nothing', async () => {
    listRepositoriesUnderPrefix.mockRejectedValue(new Error('catalog down'));
    await expect(run()).rejects.toThrow('catalog down');
    expect(store.writes).toEqual([]);
  });

  it('writes the run marker LAST, so a run that dies part-way never looks current', async () => {
    await run();
    expect(store.writes[store.writes.length - 1]).toBe('image-registry:storage-snapshot:meta');
    expect(store.writes.filter((k) => k.endsWith(':meta'))).toHaveLength(1);
  });

  it('one org\'s store write failure does not lose the run: that org reads unknown, the rest are current', async () => {
    const first = (await run())!;
    const realSet = store.set;
    store.set = async (key: string, value: string) => {
      if (key.endsWith('org:beta')) throw new Error('redis down');
      return realSet(key, value);
    };
    const second = (await run())!;
    expect(second).not.toBeNull();
    // The marker still moved on, naming the org whose record did not land.
    const meta = JSON.parse(store.data.get('image-registry:storage-snapshot:meta')!);
    expect(meta.runId).toBe(second.runId);
    expect(meta.runId).toBeGreaterThanOrEqual(first.runId);
    expect(meta.incompleteOrgIds).toEqual(['beta']);
    expect(await readOrgStorageUsage('acme')).toMatchObject({ bytes: 1030, incomplete: false });
    // Fail closed: beta's last record is older than the marker, which would
    // otherwise read as "the run found nothing for it" (0 bytes, complete).
    expect(await readOrgStorageUsage('beta')).toMatchObject({ bytes: 0, incomplete: true });
  });

  it('a store write failure for the marker itself still throws (nothing marked current)', async () => {
    const first = (await run())!;
    const realSet = store.set;
    store.set = async (key: string, value: string) => {
      if (key.endsWith(':meta')) throw new Error('redis down');
      return realSet(key, value);
    };
    await expect(run()).rejects.toThrow('redis down');
    expect(JSON.parse(store.data.get('image-registry:storage-snapshot:meta')!).runId).toBe(first.runId);
  });
});

describe('orgs absent from the latest run', () => {
  it('an org the run found nothing for reads 0 bytes, complete', async () => {
    await run();
    expect(await readOrgStorageUsage('nobody')).toMatchObject({ bytes: 0, incomplete: false });
  });

  it('an org measured by an older run but gone from the latest reads 0, not its old figure', async () => {
    const realNow = Date.now;
    let now = realNow();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await run();
    expect((await readOrgStorageUsage('beta')).bytes).toBe(5);
    now += 1000;
    readPublicationOwners.mockResolvedValue({ owners: new Map([['public/acme/app', 'acme']]), complete: true });
    await run();
    expect(await readOrgStorageUsage('beta')).toMatchObject({ bytes: 0, incomplete: false });
    Date.now = realNow;
  });
});

describe('phase timings (step 2)', () => {
  it('observes each phase and the total in the snapshot histogram', async () => {
    await run();
    const phases = observe.mock.calls.filter((c) => c[0] === SNAPSHOT_PHASE_HISTOGRAM).map((c) => (c[1] as { phase: string }).phase);
    expect(phases.sort()).toEqual(['blob_heads', 'catalog', 'manifests', 'publication_records', 'tags', 'total']);
  });
});

describe('targeted refresh after a delete / prune', () => {
  it('invalidating an org re-measures its known repositories', async () => {
    await run();
    expect((await readOrgStorageUsage('acme')).bytes).toBe(1030);
    SIZES['sha256:shared'] = 0;
    invalidateOrgStorageCache('acme');
    await refreshOrgSnapshot('acme'); // joins the refresh the invalidation started
    expect(await readOrgStorageUsage('acme')).toMatchObject({ bytes: 30, incomplete: false });
    // The refresh scanned only that org's repositories — no catalog walk.
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an org the snapshot has never measured', async () => {
    await refreshOrgSnapshot('nobody');
    expect(listTags).not.toHaveBeenCalled();
  });

  it('coalesces a burst of invalidations into the in-flight refresh plus one re-run', async () => {
    await run();
    listTags.mockClear();
    const first = refreshOrgSnapshot('acme');
    const second = refreshOrgSnapshot('acme');
    const third = refreshOrgSnapshot('acme');
    expect(second).toBe(first);
    expect(third).toBe(first);
    await first;
    // 2 repos per pass, 2 passes (the original + one coalesced re-run).
    expect(listTags).toHaveBeenCalledTimes(4);
  });

  it('each org record carries a per-repository breakdown that sums to its total', async () => {
    await run();
    const record = JSON.parse(store.data.get('image-registry:storage-snapshot:org:acme')!);
    expect(Object.keys(record.perRepo).sort()).toEqual(['org-acme/app', 'public/acme/app']);
    // The shared layer is billed once, to the first repository (sorted) that references it.
    expect(record.perRepo['org-acme/app']).toMatchObject({ bytes: 1010, blobs: 2, incomplete: false, seq: expect.any(Number) });
    expect(record.perRepo['public/acme/app']).toMatchObject({ bytes: 20, blobs: 1, incomplete: false });
    expect(record.bytes).toBe(1030);
    expect(record.blobs).toBe(3);
  });

  it('a refresh that lands while a full run is measuring the org is not overwritten by the run', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 1));
    await run();
    // The second run reads every blob size, then stalls before its results
    // come back — the window in which a delete + targeted refresh lands.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let stall = true;
    headBlob.mockImplementation(async (_repo, digest) => {
      const size = SIZES[digest];
      if (stall) await gate;
      return { contentLength: size };
    });
    const before = headBlob.mock.calls.length;
    const second = run();
    while (headBlob.mock.calls.length < before + 4) await new Promise((r) => setImmediate(r));
    stall = false;
    SIZES['sha256:shared'] = 0; // the delete
    await refreshOrgSnapshot('acme');
    expect(await readOrgStorageUsage('acme')).toMatchObject({ bytes: 30 });
    release();
    await second;
    // The run measured before the delete; the refresh's newer figures survive it.
    expect(await readOrgStorageUsage('acme')).toMatchObject({ bytes: 30, repos: 2, incomplete: false });
    // An org the refresh did not touch takes the run's figures as usual.
    expect(await readOrgStorageUsage('beta')).toMatchObject({ bytes: 5, incomplete: false });
  });

  it('a refresh that read the record before a full run wrote it does not overwrite the run (no lost update)', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 1));
    await run();
    SIZES['sha256:shared'] = 0; // the delete
    // Park the refresh's write of acme's record: it has read (and merged) the
    // record the FIRST run stored, but not written it yet.
    let parked!: () => void;
    const isParked = new Promise<void>((r) => { parked = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    store.beforeWrite = async (key) => {
      if (!key.endsWith('org:acme')) return;
      store.beforeWrite = null;
      parked();
      await gate;
    };
    const refresh = refreshOrgSnapshot('acme');
    await isParked;
    // A full run starts AFTER the refresh did, and stores acme's record meanwhile.
    const second = (await run())!;
    release();
    await refresh;
    const record = JSON.parse(store.data.get('image-registry:storage-snapshot:org:acme')!);
    // The record must still count as current for the latest marker — a record
    // older than the run reads as "the run found nothing": 0 bytes, complete,
    // and the push gate waves pushes through.
    expect(record.runId).toBeGreaterThanOrEqual(second.runId);
    expect(await readOrgStorageUsage('acme')).toMatchObject({ bytes: 30, repos: 2, incomplete: false });
  });

  it('a full run keeps its own figures where they are newer than a refresh, and adds repositories the refresh never knew', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 1));
    await run();
    await refreshOrgSnapshot('acme');
    REPO_BLOBS['org-acme/new'] = ['sha256:new'];
    SIZES['sha256:new'] = 7;
    catalog = [...catalog, 'org-acme/new'];
    try {
      await run();
      expect(await readOrgStorageUsage('acme')).toMatchObject({ bytes: 1037, repos: 3, incomplete: false });
    } finally {
      delete REPO_BLOBS['org-acme/new'];
    }
  });

  it('a refresh stamped by a pod whose clock is ahead does not beat a newer run\'s figure (ordered by the store\'s sequence, never wall time)', async () => {
    await run();
    // The refresh runs on a pod whose clock is an hour fast.
    const ahead = Date.now() + 3_600_000;
    const skewed = jest.spyOn(Date, 'now').mockImplementation(() => ahead);
    await refreshOrgSnapshot('acme');
    skewed.mockRestore();
    SIZES['sha256:shared'] = 0; // a delete, measured only by the NEXT run
    await run();
    expect(await readOrgStorageUsage('acme')).toMatchObject({ bytes: 30, incomplete: false });
  });

  it('a failing refresh never throws to the caller', async () => {
    await run();
    listTags.mockRejectedValue(new Error('registry down'));
    await expect(refreshOrgSnapshot('acme')).resolves.toBeUndefined();
  });
});

describe('backing store', () => {
  it('uses Redis when configured: values written with an expiry, read back', async () => {
    const kv = new Map<string, string>();
    let seq = 0;
    const redis = {
      get: jest.fn(async (k: string) => kv.get(k) ?? null),
      incr: jest.fn(async (_k: string) => ++seq),
      set: jest.fn(async (k: string, v: string, _mode: string, _secs: number) => { kv.set(k, v); return 'OK'; }),
      // The compare-and-set script, emulated: ARGV = hasExpected, expected, value, ttl.
      eval: jest.fn(async (_script: string, _n: number, k: string, has: string, expected: string, v: string, _secs: number) => {
        const cur = kv.get(k);
        if (has === '1' ? cur !== expected : cur !== undefined) return 0;
        kv.set(k, v);
        return 1;
      }),
    };
    createEnvRedisClient.mockReturnValueOnce(redis);
    setSnapshotStoreForTests(null);
    await run();
    expect(redis.set).toHaveBeenCalledWith('image-registry:storage-snapshot:meta', expect.any(String), 'EX', 7 * 24 * 60 * 60);
    // Org records are written conditionally on what was merged, with the same expiry.
    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])"), 1,
      'image-registry:storage-snapshot:org:acme', '0', '', expect.any(String), 7 * 24 * 60 * 60);
    expect((await readOrgStorageUsage('acme')).bytes).toBe(1030);
    // A second run's write expects the record the first stored.
    await run();
    expect(redis.eval).toHaveBeenLastCalledWith(expect.any(String), 1, expect.any(String), '1', expect.any(String), expect.any(String), expect.any(Number));
  });

  it('an org record that stays contended is not stored, and the org reads unknown', async () => {
    const first = (await run())!;
    store.setIfUnchanged = async () => false;
    const second = (await run())!;
    expect(second.incompleteOrgIds).toEqual(['acme', 'beta']);
    expect(second.runId).toBeGreaterThanOrEqual(first.runId);
    expect(await readOrgStorageUsage('acme')).toMatchObject({ incomplete: true });
  });

  it('falls back to process memory without Redis', async () => {
    createEnvRedisClient.mockReturnValueOnce(null);
    setSnapshotStoreForTests(null);
    await run();
    expect(await readOrgStorageUsage('acme')).toMatchObject({ bytes: 1030, incomplete: false });
  });

  it('an unparseable record reads as absent, never as a figure', async () => {
    await run();
    store.data.set('image-registry:storage-snapshot:meta', '{not json');
    expect((await readOrgStorageUsage('acme')).incomplete).toBe(true);
  });
});

describe('scheduler', () => {
  afterEach(() => stopStorageSnapshotScheduler());

  it('starts once, leader-locked when Redis is available, and stops', () => {
    const lock = {};
    createEnvRedisLock.mockReturnValueOnce(lock);
    startStorageSnapshotScheduler();
    startStorageSnapshotScheduler();
    expect(createScheduler).toHaveBeenCalledTimes(1);
    const opts = createScheduler.mock.calls[0]![0] as { name: string; intervalMs: number; lock?: { key: string; redis: () => unknown } };
    expect(opts).toMatchObject({ name: 'storage-snapshot', intervalMs: INTERVAL });
    expect(opts.lock?.key).toMatch(/storage-snapshot/);
    expect(opts.lock?.redis()).toBe(lock);
    expect(schedulerStart).toHaveBeenCalledTimes(1);
    stopStorageSnapshotScheduler();
    expect(schedulerStop).toHaveBeenCalledTimes(1);
  });

  it('runs unlocked without Redis, and its cycle runs a snapshot', async () => {
    startStorageSnapshotScheduler();
    const opts = createScheduler.mock.calls[0]![0] as { lock?: unknown; run: (r: { signal: AbortSignal }) => Promise<void> };
    expect(opts.lock).toBeUndefined();
    await opts.run({ signal: new AbortController().signal });
    expect((await readOrgStorageUsage('acme')).bytes).toBe(1030);
  });
});

describe('recent-run skip — N pods, one walk per interval', () => {
  let now: number;
  beforeEach(() => {
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  const cycle = () => runStorageSnapshotCycle({ intervalMs: INTERVAL });
  const gaugeValue = (name: string) => setGauge.mock.calls.filter((c) => c[0] === name).map((c) => c[2]).pop();

  it('a second cycle (another pod, same store) inside 0.9 × interval skips the walk', async () => {
    expect(await cycle()).toBe('ran');
    const meta = JSON.parse(store.data.get('image-registry:storage-snapshot:meta')!);
    now = meta.startedAt + 0.9 * INTERVAL - 1;
    setGauge.mockClear();
    expect(await cycle()).toBe('skipped_recent');
    // One full registry walk for both cycles.
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(1);
    expect(incCounter).toHaveBeenCalledWith(SNAPSHOT_RUNS_COUNTER, { outcome: 'skipped_recent' });
    // The reads counter keeps per-read outcomes only.
    expect(incCounter).not.toHaveBeenCalledWith(SNAPSHOT_READS_COUNTER, { outcome: 'skipped_recent' });
    // The skipping pod republishes the fleet's figures from the stored marker.
    expect(gaugeValue(SNAPSHOT_LAST_SUCCESS_GAUGE)).toBe(meta.completedAt / 1000);
    expect(gaugeValue(SNAPSHOT_INTERVAL_GAUGE)).toBe(INTERVAL / 1000);
  });

  it('at 0.9 × interval after the last run started, a new walk runs', async () => {
    await cycle();
    const meta = JSON.parse(store.data.get('image-registry:storage-snapshot:meta')!);
    now = meta.startedAt + 0.9 * INTERVAL;
    expect(await cycle()).toBe('ran');
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(2);
    expect(incCounter).not.toHaveBeenCalledWith(SNAPSHOT_RUNS_COUNTER, { outcome: 'skipped_recent' });
    expect(incCounter.mock.calls.filter((c) => c[0] === SNAPSHOT_RUNS_COUNTER)).toEqual([
      [SNAPSHOT_RUNS_COUNTER, { outcome: 'ran' }],
      [SNAPSHOT_RUNS_COUNTER, { outcome: 'ran' }],
    ]);
  });

  it('with no completed run stored, a cycle always walks', async () => {
    expect(await cycle()).toBe('ran');
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(1);
  });

  it('an aborted cycle reports it and marks nothing', async () => {
    const ac = new AbortController();
    ac.abort('lock-lost');
    expect(await runStorageSnapshotCycle({ intervalMs: INTERVAL, signal: ac.signal })).toBe('aborted');
    expect(store.data.has('image-registry:storage-snapshot:meta')).toBe(false);
    expect(incCounter).toHaveBeenCalledWith(SNAPSHOT_RUNS_COUNTER, { outcome: 'aborted' });
    expect(incCounter).not.toHaveBeenCalledWith(SNAPSHOT_RUNS_COUNTER, { outcome: 'ran' });
  });
});

describe('snapshot liveness gauges', () => {
  const gaugeValue = (name: string) => setGauge.mock.calls.filter((c) => c[0] === name).map((c) => c[2]).pop();
  afterEach(() => stopStorageSnapshotScheduler());

  it('a completed run publishes the last-success time and the interval', async () => {
    const meta = (await run())!;
    expect(gaugeValue(SNAPSHOT_LAST_SUCCESS_GAUGE)).toBe(meta.completedAt / 1000);
    expect(gaugeValue(SNAPSHOT_INTERVAL_GAUGE)).toBe(INTERVAL / 1000);
  });

  it('an aborted run publishes no success', async () => {
    const ac = new AbortController();
    ac.abort('lock-lost');
    await runStorageSnapshot({ intervalMs: INTERVAL, signal: ac.signal });
    expect(gaugeValue(SNAPSHOT_LAST_SUCCESS_GAUGE)).toBeUndefined();
  });

  it('a non-leader pod (lock held elsewhere) republishes the FLEET last success from the store', async () => {
    const meta = (await run())!;
    setGauge.mockClear();
    createEnvRedisLock.mockReturnValueOnce({});
    startStorageSnapshotScheduler();
    const opts = createScheduler.mock.calls[0]![0] as { onSkipped?: () => Promise<void> };
    await opts.onSkipped!();
    expect(gaugeValue(SNAPSHOT_LAST_SUCCESS_GAUGE)).toBe(meta.completedAt / 1000);
    expect(gaugeValue(SNAPSHOT_INTERVAL_GAUGE)).toBe(INTERVAL / 1000);
  });

  it('republishing never throws: no marker publishes nothing, an unreachable store is logged', async () => {
    startStorageSnapshotScheduler();
    const opts = createScheduler.mock.calls[0]![0] as { onSkipped?: () => Promise<void> };
    await opts.onSkipped!();
    expect(gaugeValue(SNAPSHOT_LAST_SUCCESS_GAUGE)).toBeUndefined();
    store.get = async () => { throw new Error('redis down'); };
    await expect(opts.onSkipped!()).resolves.toBeUndefined();
  });

  it('the scheduler cycle applies the recent-run skip', async () => {
    startStorageSnapshotScheduler();
    const opts = createScheduler.mock.calls[0]![0] as { run: (r: { signal: AbortSignal }) => Promise<void> };
    await opts.run({ signal: new AbortController().signal });
    await opts.run({ signal: new AbortController().signal });
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(1);
  });
});

describe('per-org scans run concurrently (REGISTRY_STORAGE_SCAN_CONCURRENCY)', () => {
  const ENV = 'REGISTRY_STORAGE_SCAN_CONCURRENCY';
  afterEach(() => { delete process.env[ENV]; });

  /** 12 orgs × 2 repos, each call slow enough to overlap. */
  function manyOrgs() {
    const orgs = Array.from({ length: 12 }, (_, i) => `o${i}`);
    catalog = orgs.flatMap((o) => [`org-${o}/a`, `org-${o}/b`]);
    readPublicationOwners.mockResolvedValue({ owners: new Map(), complete: true });
    let inFlight = 0;
    const state = { peak: 0 };
    const slow = async <T>(fn: () => T): Promise<T> => {
      inFlight++;
      state.peak = Math.max(state.peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 2));
        return fn();
      } finally {
        inFlight--;
      }
    };
    listTags.mockImplementation(() => slow(() => ({ tags: ['v1', 'v2'] })));
    getManifest.mockImplementation((repo, tag) => slow(() => ({
      body: { config: { digest: `sha256:cfg-${repo}-${tag}` }, layers: [{ digest: `sha256:base-${repo.split('/')[0]}` }] },
      digest: 'sha256:m',
      mediaType: MANIFEST,
    })));
    headBlob.mockImplementation((_repo, digest) => slow(() => ({ contentLength: digest.length })));
    return { orgs, state };
  }

  it('measures several orgs at once, all registry calls under ONE shared cap, with the serial totals', async () => {
    const { orgs, state } = manyOrgs();
    process.env[ENV] = '1';
    await run();
    const serial = await Promise.all(orgs.map((o) => readOrgStorageUsage(o)));
    expect(state.peak).toBe(1);

    state.peak = 0;
    process.env[ENV] = '6';
    await run();
    const parallel = await Promise.all(orgs.map((o) => readOrgStorageUsage(o)));
    // The cap holds across orgs (not 6 per org), and is reached.
    expect(state.peak).toBe(6);
    const strip = (u: { bytes: number; blobs: number; repos: number; incomplete: boolean }) =>
      ({ bytes: u.bytes, blobs: u.blobs, repos: u.repos, incomplete: u.incomplete });
    expect(parallel.map(strip)).toEqual(serial.map(strip));
    expect(serial.every((u) => !u.incomplete && u.bytes > 0)).toBe(true);
  });

  it('still writes the run marker LAST', async () => {
    manyOrgs();
    process.env[ENV] = '6';
    await run();
    expect(store.writes[store.writes.length - 1]).toBe('image-registry:storage-snapshot:meta');
    expect(store.writes).toHaveLength(13);
  });
});
