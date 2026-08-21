// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the reporting retention scheduler wiring (Phase 7,
 * src/services/reporting-retention.ts). api-core is mocked so createScheduler /
 * createEnvRedisLock are spies; pipeline-data's reportingService is mocked so we
 * can assert the sweep delegates to purgeExpiredReportingData with the env-tuned
 * batch options.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const createSchedulerSpy = jest.fn(() => ({ start: jest.fn(), stop: jest.fn() }));
const createEnvRedisLockSpy = jest.fn<() => unknown>(() => null);
// D8: the scheduler is gated on billing being enabled — default ON, toggled per-test.
const isBillingEnabledSpy = jest.fn<() => boolean>(() => true);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: createSchedulerSpy,
  createEnvRedisLock: createEnvRedisLockSpy,
  isBillingEnabled: isBillingEnabledSpy,
}));

const purgeExpiredReportingData = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({});
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  reportingService: { purgeExpiredReportingData: (...a: unknown[]) => purgeExpiredReportingData(...a) },
}));

const { createReportingRetentionScheduler, isReportingRetentionEnabled } =
  await import('../src/services/reporting-retention.js');

const ENV_KEY = 'REPORTING_RETENTION_ENABLED';
let saved: string | undefined;
beforeEach(() => { saved = process.env[ENV_KEY]; jest.clearAllMocks(); createEnvRedisLockSpy.mockReturnValue(null); isBillingEnabledSpy.mockReturnValue(true); });
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

  it('builds a scheduler with a leader lock when Redis is configured', () => {
    process.env[ENV_KEY] = 'true';
    createEnvRedisLockSpy.mockReturnValue({ set: jest.fn() });
    const sched = createReportingRetentionScheduler();
    expect(sched).not.toBeNull();
    const opts = createSchedulerSpy.mock.calls[0][0] as { name: string; lock?: { key: string } };
    expect(opts.name).toBe('reporting-retention');
    expect(opts.lock?.key).toBe('reporting-retention:leader');
  });

  it('omits the lock when Redis is not configured', () => {
    process.env[ENV_KEY] = 'true';
    createEnvRedisLockSpy.mockReturnValue(null);
    createReportingRetentionScheduler();
    const opts = createSchedulerSpy.mock.calls[0][0] as { lock?: unknown };
    expect(opts.lock).toBeUndefined();
  });

  it('the run callback delegates to reportingService.purgeExpiredReportingData', async () => {
    process.env[ENV_KEY] = 'true';
    createReportingRetentionScheduler();
    const opts = createSchedulerSpy.mock.calls[0][0] as { run: () => Promise<void> };
    await opts.run();
    expect(purgeExpiredReportingData).toHaveBeenCalledTimes(1);
    const arg = purgeExpiredReportingData.mock.calls[0][0] as { batchSize: number; maxBatchesPerTable: number };
    expect(arg).toMatchObject({ batchSize: expect.any(Number), maxBatchesPerTable: expect.any(Number) });
  });

  it('the run callback swallows sweep errors (never throws into the scheduler)', async () => {
    process.env[ENV_KEY] = 'true';
    purgeExpiredReportingData.mockRejectedValueOnce(new Error('boom'));
    createReportingRetentionScheduler();
    const opts = createSchedulerSpy.mock.calls[0][0] as { run: () => Promise<void> };
    await expect(opts.run()).resolves.toBeUndefined();
  });
});
