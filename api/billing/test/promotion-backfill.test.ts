// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * helpers/promotion-backfill.ts — the leader-locked backfill cron: off unless
 * promotions are enabled; each cycle runs in a sysadmin tenant scope, heals
 * each active promotion's spend cache from the ledger BEFORE granting, and is
 * fail-soft per promotion.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock, loggerMock } from './helpers/mock-api-core.js';

const logger = loggerMock();
const start = jest.fn<AnyFn>();
let schedulerOpts: { name: string; intervalMs: number; run: () => Promise<void>; lock?: { key: string; ttlMs: number; redis: () => unknown } } | undefined;
const lockClient = { id: 'redis-lock' };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => logger,
  createEnvRedisLock: () => lockClient,
  createScheduler: (opts: typeof schedulerOpts) => { schedulerOpts = opts; return { start, stop: jest.fn() }; },
}));

const tenantScopes: unknown[] = [];
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  runWithTenantContext: async (ctx: unknown, fn: () => Promise<unknown>) => { tenantScopes.push(ctx); return fn(); },
}));

const cfg = { promotions: { enabled: true, backfillIntervalMs: 3_600_000 } };
jest.unstable_mockModule('../src/config.js', () => ({ config: cfg }));

const calls: string[] = [];
const reconcilePromotionSpend = jest.fn<AnyFn>(async (p: { _id: string }) => { calls.push(`reconcile:${p._id}`); });
const batchEvaluatePromotion = jest.fn<AnyFn>(async (p: { _id: string }) => { calls.push(`batch:${p._id}`); return { granted: p._id === 'p1' ? 2 : 0 }; });
jest.unstable_mockModule('../src/helpers/promotion-engine.js', () => ({ reconcilePromotionSpend, batchEvaluatePromotion }));

const find = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/promotion.js', () => ({ Promotion: { find } }));

const { startPromotionBackfill } = await import('../src/helpers/promotion-backfill.js');

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  tenantScopes.length = 0;
  cfg.promotions.enabled = true;
});

describe('promotion backfill cron', () => {
  it('is registered once, leader-locked, at the configured interval', () => {
    expect(schedulerOpts).toMatchObject({ name: 'promotion-backfill', intervalMs: 3_600_000, lock: { key: 'promotion-backfill', ttlMs: 5 * 60 * 1000 } });
    expect(schedulerOpts!.lock!.redis()).toBe(lockClient);
  });

  it('does not start while promotions are disabled', () => {
    cfg.promotions.enabled = false;
    startPromotionBackfill();
    expect(start).not.toHaveBeenCalled();
  });

  it('starts when enabled', () => {
    startPromotionBackfill();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a cycle heals then grants every ACTIVE promotion, as sysadmin, fail-soft per promotion', async () => {
    find.mockResolvedValue([{ _id: 'p1' }, { _id: 'p2' }, { _id: 'p3' }]);
    batchEvaluatePromotion.mockImplementationOnce(async (p: { _id: string }) => { calls.push(`batch:${p._id}`); return { granted: 2 }; })
      .mockImplementationOnce(async () => { throw new Error('mongo blip'); });
    await schedulerOpts!.run();
    expect(find).toHaveBeenCalledWith({ isActive: true });
    expect(tenantScopes).toEqual([{ isSuperAdmin: true }]);
    expect(calls).toEqual(['reconcile:p1', 'batch:p1', 'reconcile:p2', 'reconcile:p3', 'batch:p3']);
    expect(logger.info).toHaveBeenCalledWith('Promotion backfill granted', expect.objectContaining({ promotionId: 'p1', granted: 2 }));
    expect(logger.error).toHaveBeenCalledWith('Promotion backfill cycle errored (fail-soft)', { promotionId: 'p2', error: 'mongo blip' });
  });
});
