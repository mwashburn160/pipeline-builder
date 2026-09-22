// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the reporting retention scheduler wiring
 * (src/services/reporting-retention.ts). api-core is mocked so createScheduler
 * is a spy; pipeline-data's reportingService is mocked so we
 * can assert the sweep delegates to purgeExpiredReportingData with the env-tuned
 * batch options.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const createSchedulerSpy = jest.fn((_opts: unknown) => ({ start: jest.fn<AnyFn>(), stop: jest.fn<AnyFn>() }));
// The scheduler is gated on billing being enabled — default ON, toggled per-test.
const isBillingEnabledSpy = jest.fn<() => boolean>(() => true);
const fetchParentOrgIdSpy = jest.fn<AnyFn>(async () => undefined);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: createSchedulerSpy,
  isBillingEnabled: isBillingEnabledSpy,
  fetchParentOrgId: fetchParentOrgIdSpy,
}));

const purgeExpiredReportingData = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({});
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  reportingService: { purgeExpiredReportingData: (...a: unknown[]) => purgeExpiredReportingData(...a) },
}));

const { createReportingRetentionScheduler, isReportingRetentionEnabled, startReportingRetention, stopReportingRetention } =
  await import('../src/services/reporting-retention.js');

const ENV_KEY = 'REPORTING_RETENTION_ENABLED';
let saved: string | undefined;
beforeEach(() => { saved = process.env[ENV_KEY]; jest.clearAllMocks(); isBillingEnabledSpy.mockReturnValue(true); });
afterEach(() => { if (saved === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = saved; });

describe('isReportingRetentionEnabled', () => {
  it('defaults to enabled and honors the kill-switch', () => {
    delete process.env[ENV_KEY];
    expect(isReportingRetentionEnabled()).toBe(true);
    process.env[ENV_KEY] = 'false';
    expect(isReportingRetentionEnabled()).toBe(false);
    process.env[ENV_KEY] = 'FALSE';
    expect(isReportingRetentionEnabled()).toBe(false);
  });
});

describe('createReportingRetentionScheduler', () => {
  it('returns null and never builds a scheduler when disabled', () => {
    process.env[ENV_KEY] = 'false';
    expect(createReportingRetentionScheduler()).toBeNull();
    expect(createSchedulerSpy).not.toHaveBeenCalled();
  });

  it('returns null and never schedules when billing is DISABLED (unlimited retention)', () => {
    process.env[ENV_KEY] = 'true';
    isBillingEnabledSpy.mockReturnValue(false);
    expect(createReportingRetentionScheduler()).toBeNull();
    expect(createSchedulerSpy).not.toHaveBeenCalled();
  });

  it('builds a leader-locked scheduler (shared env lock client)', () => {
    process.env[ENV_KEY] = 'true';
    const sched = createReportingRetentionScheduler();
    expect(sched).not.toBeNull();
    const opts = createSchedulerSpy.mock.calls[0][0] as { name: string; lock?: { key: string; redis?: unknown } };
    expect(opts.name).toBe('reporting-retention');
    expect(opts.lock?.key).toBe('reporting-retention:leader');
    expect(opts.lock?.redis).toBeUndefined();
  });

  it('the run callback delegates to reportingService.purgeExpiredReportingData', async () => {
    process.env[ENV_KEY] = 'true';
    createReportingRetentionScheduler();
    const opts = createSchedulerSpy.mock.calls[0][0] as { run: () => Promise<void> };
    await opts.run();
    expect(purgeExpiredReportingData).toHaveBeenCalledTimes(1);
    const arg = purgeExpiredReportingData.mock.calls[0][0] as { batchSize: number; maxBatchesPerTable: number };
    expect(arg).toMatchObject({ batchSize: expect.any(Number), maxBatchesPerTable: expect.any(Number) });
    // Team rows are purged on their ROOT's window — the sweep always gets a resolver.
    expect(typeof (arg as { resolveRetentionOrgId?: unknown }).resolveRetentionOrgId).toBe('function');
  });

  it('the run callback swallows sweep errors (never throws into the scheduler)', async () => {
    process.env[ENV_KEY] = 'true';
    purgeExpiredReportingData.mockRejectedValueOnce(new Error('boom'));
    createReportingRetentionScheduler();
    const opts = createSchedulerSpy.mock.calls[0][0] as { run: () => Promise<void> };
    await expect(opts.run()).resolves.toBeUndefined();
  });
});

describe('createRetentionRootResolver (team rows follow the ROOT\'s retention)', () => {
  it('walks the parent chain to the root and memoizes per sweep', async () => {
    const { createRetentionRootResolver } = await import('../src/services/reporting-retention.js');
    const parents: Record<string, string | undefined> = { 'team-b': 'team-a', 'team-a': 'root', 'root': undefined };
    const fetchParent = jest.fn(async (id: string) => parents[id]);
    const resolve = createRetentionRootResolver(fetchParent);
    expect(await resolve('team-b')).toBe('root');
    expect(await resolve('team-b')).toBe('root');
    expect(await resolve('root')).toBe('root');
    // team-b walk = 3 lookups; the repeat is memoized; `root` is its own lookup.
    expect(fetchParent).toHaveBeenCalledTimes(4);
  });

  it('fails CLOSED: a lookup error resolves to null (the sweep skips the org)', async () => {
    const { createRetentionRootResolver } = await import('../src/services/reporting-retention.js');
    const resolve = createRetentionRootResolver(async () => { throw new Error('platform down'); });
    expect(await resolve('team-1')).toBeNull();
  });

  it('treats a cycle as unresolvable (null)', async () => {
    const { createRetentionRootResolver } = await import('../src/services/reporting-retention.js');
    const resolve = createRetentionRootResolver(async (id) => (id === 'a' ? 'b' : 'a'));
    expect(await resolve('a')).toBeNull();
  });
});

describe('start/stopReportingRetention', () => {
  it('starts once, ignores a second start, and stops cleanly', () => {
    process.env[ENV_KEY] = 'true';
    startReportingRetention();
    startReportingRetention();
    expect(createSchedulerSpy).toHaveBeenCalledTimes(1);
    const sched = createSchedulerSpy.mock.results[0]!.value as { start: jest.Mock; stop: jest.Mock };
    expect(sched.start).toHaveBeenCalledTimes(1);
    stopReportingRetention();
    expect(sched.stop).toHaveBeenCalledTimes(1);
    stopReportingRetention(); // already stopped — no-op
  });

  it('the default resolver asks platform for each parent, failing closed on HTTP errors', async () => {
    const { createRetentionRootResolver } = await import('../src/services/reporting-retention.js');
    fetchParentOrgIdSpy.mockResolvedValueOnce(undefined);
    expect(await createRetentionRootResolver()('root-org')).toBe('root-org');
    expect(fetchParentOrgIdSpy).toHaveBeenCalledWith('root-org', expect.objectContaining({ throwOnHttpError: true }));
  });
});
