// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the soft-delete retention sweep orchestrator + scheduler factory
 * (src/api/soft-delete-sweep.ts). api-core is mocked so createScheduler is a
 * spy; tenancy is mocked so runWithTenantContext is a
 * pass-through we can assert the sysadmin scope on.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const createSchedulerSpy = jest.fn((_opts: unknown) => ({ start: jest.fn<AnyFn>(), stop: jest.fn<AnyFn>() }));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: createSchedulerSpy,
}));

const runWithTenantContextSpy = jest.fn(<T>(_ctx: unknown, fn: () => T): T => fn());
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  runWithTenantContext: runWithTenantContextSpy,
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({}),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_c: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));

const { runSoftDeletePurge, createSoftDeletePurgeScheduler, isSoftDeletePurgeEnabled } =
  await import('../src/api/soft-delete-sweep.js');

/** A fake PurgeableEntity whose purgeExpired returns the queued batch sizes. */
function fakeEntity(name: string, batches: number[]) {
  const purgeExpired = jest.fn<(now: Date, limit?: number) => Promise<number>>();
  batches.forEach((n) => purgeExpired.mockResolvedValueOnce(n));
  return { name, purgeExpired };
}

const ENV_KEY = 'SOFT_DELETE_PURGE_ENABLED';
let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env[ENV_KEY]; jest.clearAllMocks(); });
afterEach(() => { if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv; });

describe('runSoftDeletePurge', () => {
  it('returns {} and never purges when disabled', async () => {
    process.env[ENV_KEY] = 'false';
    const e = fakeEntity('pipeline', [0]);
    const res = await runSoftDeletePurge([e]);
    expect(res).toEqual({});
    expect(e.purgeExpired).not.toHaveBeenCalled();
  });

  it('drains an entity in one batch (purged < batchSize) and records the count', async () => {
    process.env[ENV_KEY] = 'true';
    const e = fakeEntity('pipeline', [3]); // < default 500 → drained
    const res = await runSoftDeletePurge([e]);
    expect(e.purgeExpired).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ pipeline: 3 });
  });

  it('loops batches until a short batch, summing the total', async () => {
    process.env[ENV_KEY] = 'true';
    const e = fakeEntity('plugin', [500, 500, 12]); // two full + one short
    const res = await runSoftDeletePurge([e], { batchSize: 500 });
    expect(e.purgeExpired).toHaveBeenCalledTimes(3);
    expect(res).toEqual({ plugin: 1012 });
  });

  it('stops at the per-tick cap when batches never drain', async () => {
    process.env[ENV_KEY] = 'true';
    const e = fakeEntity('plugin', [10, 10, 10, 10, 10]);
    const res = await runSoftDeletePurge([e], { batchSize: 10, maxBatchesPerEntity: 3 });
    expect(e.purgeExpired).toHaveBeenCalledTimes(3);
    expect(res).toEqual({ plugin: 30 });
  });

  it('isolates a failing entity (logs, records 0) and still processes the rest', async () => {
    process.env[ENV_KEY] = 'true';
    const bad = { name: 'bad', purgeExpired: jest.fn<() => Promise<number>>().mockRejectedValue(new Error('boom')) };
    const good = fakeEntity('good', [2]);
    const res = await runSoftDeletePurge([bad, good]);
    expect(res).toEqual({ bad: 0, good: 2 });
  });

  it('runs the sweep inside a sysadmin tenant scope', async () => {
    process.env[ENV_KEY] = 'true';
    await runSoftDeletePurge([fakeEntity('pipeline', [0])]);
    expect(runWithTenantContextSpy).toHaveBeenCalledWith({ isSuperAdmin: true }, expect.any(Function));
  });
});

describe('createSoftDeletePurgeScheduler', () => {
  it('returns null when disabled', () => {
    process.env[ENV_KEY] = 'false';
    expect(createSoftDeletePurgeScheduler({ service: 'pipeline', entities: [] })).toBeNull();
    expect(createSchedulerSpy).not.toHaveBeenCalled();
  });

  it('builds a leader-locked scheduler when enabled', () => {
    process.env[ENV_KEY] = 'true';
    const sched = createSoftDeletePurgeScheduler({ service: 'plugin', entities: [fakeEntity('plugin', [])] });
    expect(sched).not.toBeNull();
    expect(createSchedulerSpy).toHaveBeenCalledTimes(1);
    const opts = createSchedulerSpy.mock.calls[0][0] as { name: string; lock?: { key: string } };
    expect(opts.name).toBe('soft-delete-purge:plugin');
    expect(opts.lock?.key).toBe('soft-delete-purge:plugin:leader');
  });
});

describe('isSoftDeletePurgeEnabled', () => {
  it('defaults to enabled and honors the kill-switch', () => {
    delete process.env[ENV_KEY];
    expect(isSoftDeletePurgeEnabled()).toBe(true);
    process.env[ENV_KEY] = 'false';
    expect(isSoftDeletePurgeEnabled()).toBe(false);
    process.env[ENV_KEY] = 'FALSE';
    expect(isSoftDeletePurgeEnabled()).toBe(false);
  });
});
