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
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  observe, incCounter, setGauge: jest.fn(),
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

/** In-memory store that records write order. */
function memoryStore() {
  const data = new Map<string, string>();
  const writes: string[] = [];
  return {
    data,
    writes,
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string) => { data.set(key, value); writes.push(key); },
  };
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

  it('a store write failure mid-run leaves the previous marker in charge', async () => {
    const first = (await run())!;
    const realSet = store.set;
    store.set = async (key: string, value: string) => {
      if (key.endsWith('org:beta')) throw new Error('redis down');
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

  it('a failing refresh never throws to the caller', async () => {
    await run();
    listTags.mockRejectedValue(new Error('registry down'));
    await expect(refreshOrgSnapshot('acme')).resolves.toBeUndefined();
  });
});

describe('backing store', () => {
  it('uses Redis when configured: values written with an expiry, read back', async () => {
    const kv = new Map<string, string>();
    const redis = {
      get: jest.fn(async (k: string) => kv.get(k) ?? null),
      set: jest.fn(async (k: string, v: string, _mode: string, _secs: number) => { kv.set(k, v); return 'OK'; }),
    };
    createEnvRedisClient.mockReturnValueOnce(redis);
    setSnapshotStoreForTests(null);
    await run();
    expect(redis.set).toHaveBeenCalledWith('image-registry:storage-snapshot:meta', expect.any(String), 'EX', 7 * 24 * 60 * 60);
    expect((await readOrgStorageUsage('acme')).bytes).toBe(1030);
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
