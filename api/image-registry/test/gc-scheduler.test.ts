// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the GC scheduler's cross-pod LEADER LOCK wiring.
 *
 * The GC sweep is destructive (it DELETEs manifests). Without a leader lock,
 * every replica with REGISTRY_GC_ENABLED=true runs the sweep concurrently. These
 * tests assert that:
 *  - when Redis is configured, the scheduler is created WITH a `lock` (key +
 *    TTL) so only the lock winner sweeps;
 *  - when Redis is unconfigured (createEnvRedisLock → null), no `lock` is passed
 *    and the scheduler degrades to running on every pod (pre-lock behavior);
 *  - the disabled path never touches Redis / creates a scheduler at all.
 *
 * Mocked at the api-core boundary so createScheduler is captured, never run.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

interface CapturedSchedulerOpts {
  name: string;
  intervalMs: number;
  startupDelayMs?: number;
  lock?: { redis: () => unknown; key: string; ttlMs: number };
  run: () => Promise<void>;
}

const createScheduler = jest.fn<(opts: CapturedSchedulerOpts) => { start: () => void; stop: () => void }>(
  () => ({ start: jest.fn(), stop: jest.fn() }),
);
const fakeLockClient = { set: jest.fn(), get: jest.fn(), del: jest.fn() };
const createEnvRedisLock = jest.fn<() => unknown>(() => fakeLockClient);

jest.unstable_mockModule('@pipeline-builder/api-core', () =>
  apiCoreMock({ createScheduler, createEnvRedisLock }),
);

// The scheduler module imports these at load; stub them so nothing real runs.
const listRepositoriesUnderPrefix = jest.fn<(p: string) => Promise<string[]>>(async () => []);
jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  listRepositoriesUnderPrefix,
}));
const runQuarantineGc = jest.fn(async () => ({ reposScanned: 0, deleted: 0, skippedNoTimestamp: 0 }));
interface FakeGcResult { candidates: number; deleted: number; reposScanned: number; companionsDeleted: number; failedRepos: number }
const runRegistryGc = jest.fn<(o: { prefix: string }) => Promise<FakeGcResult>>(
  async () => ({ candidates: 0, deleted: 0, reposScanned: 1, companionsDeleted: 0, failedRepos: 0 }),
);
jest.unstable_mockModule('../src/services/registry-gc.js', () => ({
  runRegistryGc,
  runQuarantineGc,
  GC_FAILED_COUNTER: 'registry_gc_failed_total',
}));
const incCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter }));
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({
  invalidateStorageCache: jest.fn(),
  computeStorageUsage: jest.fn(async () => ({ bytes: 0, incomplete: false })),
}));

const {
  startGcScheduler, stopGcScheduler, startQuarantineGcScheduler, stopQuarantineGcScheduler, sweepOnceForTests,
} = await import('../src/services/gc-scheduler.js');

const ENV_KEYS = ['REGISTRY_GC_ENABLED', 'REGISTRY_GC_LOCK_TTL_MS'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  createScheduler.mockReturnValue({ start: jest.fn(), stop: jest.fn() });
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  stopGcScheduler();
  stopQuarantineGcScheduler();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('startGcScheduler leader lock', () => {
  it('wires the leader lock (key + TTL) when Redis is configured', () => {
    process.env.REGISTRY_GC_ENABLED = 'true';
    delete process.env.REGISTRY_GC_LOCK_TTL_MS; // default: api-core DEFAULT_LEADER_LOCK_TTL_MS (120s)

    startGcScheduler();

    expect(createEnvRedisLock).toHaveBeenCalledTimes(1);
    expect(createScheduler).toHaveBeenCalledTimes(1);
    const opts = createScheduler.mock.calls[0][0];
    expect(opts.lock).toBeDefined();
    expect(opts.lock?.key).toBe('image-registry:gc-scheduler:leader');
    // A crash-recovery window, not a run-duration cover: the holder heartbeats for
    // as long as the GC runs, so the TTL only bounds how long a dead pod parks it.
    expect(opts.lock?.ttlMs).toBe(120_000);
    // The redis resolver must return the env lock client (not null).
    expect(opts.lock?.redis()).toBe(fakeLockClient);
  });

  it('honors REGISTRY_GC_LOCK_TTL_MS override', () => {
    process.env.REGISTRY_GC_ENABLED = 'true';
    process.env.REGISTRY_GC_LOCK_TTL_MS = '60000';

    startGcScheduler();

    expect(createScheduler.mock.calls[0][0].lock?.ttlMs).toBe(60000);
  });

  it('omits the lock (runs on every pod) when Redis is unconfigured', () => {
    process.env.REGISTRY_GC_ENABLED = 'true';
    createEnvRedisLock.mockReturnValueOnce(null);

    startGcScheduler();

    expect(createScheduler).toHaveBeenCalledTimes(1);
    expect(createScheduler.mock.calls[0][0].lock).toBeUndefined();
  });

  it('does nothing (no lock, no scheduler) when disabled', () => {
    delete process.env.REGISTRY_GC_ENABLED;

    startGcScheduler();

    expect(createEnvRedisLock).not.toHaveBeenCalled();
    expect(createScheduler).not.toHaveBeenCalled();
  });
});

// Anonymous-submission builds (`quarantine/*`) are
// removed 30 days after their build whether or not the operator opted in to the
// org sweep: the 30-day bound is a retention promise, not a preference.
describe('startQuarantineGcScheduler', () => {
  it('runs even with REGISTRY_GC_ENABLED unset, under its own leader lock', async () => {
    delete process.env.REGISTRY_GC_ENABLED;

    startQuarantineGcScheduler();

    expect(createScheduler).toHaveBeenCalledTimes(1);
    const opts = createScheduler.mock.calls[0][0];
    expect(opts.name).toBe('quarantine-gc');
    expect(opts.lock?.key).toBe('image-registry:quarantine-gc:leader');
    expect(opts.lock?.key).not.toBe('image-registry:gc-scheduler:leader');
    await opts.run();
    expect(runQuarantineGc).toHaveBeenCalledTimes(1);
  });

  it('hands a failed sweep to the scheduler, so no success is stamped and SchedulerJobStale can fire', async () => {
    // createScheduler catches and logs a throwing run; swallowing it HERE made
    // every failed sweep look like a success.
    startQuarantineGcScheduler();
    runQuarantineGc.mockRejectedValueOnce(new Error('registry down'));
    await expect(createScheduler.mock.calls[0][0].run()).rejects.toThrow('registry down');
  });

  it('is idempotent', () => {
    startQuarantineGcScheduler();
    startQuarantineGcScheduler();
    expect(createScheduler).toHaveBeenCalledTimes(1);
  });
});

// The org sweep's failures must reach the scheduler (SchedulerJobStale) and a
// counter (RegistryGcFailing) — a registry that is down must not look swept.
describe('org sweep failure visibility', () => {
  it('throws, and counts, when the catalog cannot be listed', async () => {
    listRepositoriesUnderPrefix.mockRejectedValueOnce(new Error('registry down'));
    await expect(sweepOnceForTests(30)).rejects.toThrow(/catalog listing failed/);
    expect(incCounter).toHaveBeenCalledWith('registry_gc_failed_total', { stage: 'catalog' });
  });

  it('throws when EVERY namespace failed', async () => {
    listRepositoriesUnderPrefix.mockResolvedValueOnce(['org-a/x', 'org-b/y']);
    runRegistryGc.mockRejectedValue(new Error('boom'));
    await expect(sweepOnceForTests(30)).rejects.toThrow(/every namespace failed/);
    expect(incCounter).toHaveBeenCalledWith('registry_gc_failed_total', { stage: 'namespace' });
    runRegistryGc.mockReset();
  });

  it('counts a namespace none of whose repositories could be walked as failed', async () => {
    listRepositoriesUnderPrefix.mockResolvedValueOnce(['org-a/x']);
    runRegistryGc.mockResolvedValueOnce({ candidates: 0, deleted: 0, reposScanned: 2, companionsDeleted: 0, failedRepos: 2 });
    await expect(sweepOnceForTests(30)).rejects.toThrow(/every namespace failed/);
  });

  it('completes (stamping success) when only SOME namespaces failed — those are counted', async () => {
    listRepositoriesUnderPrefix.mockResolvedValueOnce(['org-a/x', 'org-b/y']);
    runRegistryGc
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ candidates: 1, deleted: 1, reposScanned: 1, companionsDeleted: 2, failedRepos: 0 });
    await expect(sweepOnceForTests(30)).resolves.toBeUndefined();
    expect(incCounter).toHaveBeenCalledWith('registry_gc_failed_total', { stage: 'namespace' });
  });
});
