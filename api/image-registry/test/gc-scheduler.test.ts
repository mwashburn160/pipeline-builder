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
jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  listRepositoriesUnderPrefix: jest.fn(async () => []),
}));
jest.unstable_mockModule('../src/services/registry-gc.js', () => ({
  runRegistryGc: jest.fn(async () => ({ candidates: 0, deleted: 0, reposScanned: 0 })),
}));
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({
  invalidateStorageCache: jest.fn(),
}));

const { startGcScheduler, stopGcScheduler } = await import('../src/services/gc-scheduler.js');

const ENV_KEYS = ['REGISTRY_GC_ENABLED', 'REGISTRY_GC_LOCK_TTL_MS'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  createScheduler.mockReturnValue({ start: jest.fn(), stop: jest.fn() });
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  stopGcScheduler();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('startGcScheduler leader lock', () => {
  it('wires the leader lock (key + TTL) when Redis is configured', () => {
    process.env.REGISTRY_GC_ENABLED = 'true';
    delete process.env.REGISTRY_GC_LOCK_TTL_MS; // default 15 min

    startGcScheduler();

    expect(createEnvRedisLock).toHaveBeenCalledTimes(1);
    expect(createScheduler).toHaveBeenCalledTimes(1);
    const opts = createScheduler.mock.calls[0][0];
    expect(opts.lock).toBeDefined();
    expect(opts.lock?.key).toBe('image-registry:gc-scheduler:leader');
    expect(opts.lock?.ttlMs).toBe(900000);
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
