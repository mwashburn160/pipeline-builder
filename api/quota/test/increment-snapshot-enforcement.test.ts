// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CAPS ONLY RISE MID-PERIOD — at the point of ENFORCEMENT, not just in reads.
 *
 * Every increment's update stage captures `limitAtPeriodStart`, and the status
 * views take `max(snapshot, current)`. The atomic increment FILTERS did not:
 * they bound on the current limit alone. So after a mid-period downgrade
 * (1000 → 100) an account at 400 read `allowed: true, remaining: 600` and had
 * every reservation refused — the stranding the snapshot exists to prevent, for
 * a whole month on `cpuCredits`.
 *
 * These tests run the service's real filter `$expr` and update pipeline through
 * a small Mongo-expression evaluator (helpers/mongo-expr.ts) against a stored
 * document, so they assert what Mongo would DECIDE, not the expression's shape.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { MOCK_TIER_NAMES } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { applyPipeline, exprAdmits } from './helpers/mongo-expr.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isValidTier: () => true,
  ValidationError: class ValidationError extends Error {},
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'cpuCredits'],
  QUOTA_TIERS: { developer: { limits: { plugins: 100, cpuCredits: 100 } } },
  VALID_TIERS: [...MOCK_TIER_NAMES],
}));

type Lookup = { self: unknown; parentOrgId?: string; hasChildren: boolean };
const findOrgWithHierarchy = jest.fn<(id: string, fields: string) => Promise<Lookup>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  findOrgWithHierarchy,
  resolveRootOrgId: async (id: string) => id,
  expandOrgScope: async (id: string) => [id],
  getParentOrgId: async () => undefined,
}));

const findOneAndUpdate = jest.fn<AnyFn>();
const findById = jest.fn<AnyFn>();
const updateOne = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: { findOneAndUpdate, findById, updateOne, find: jest.fn() },
}));

jest.unstable_mockModule('../src/services/storage-usage.js', () => ({ fetchStorageBytes: async () => null }));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { quota: { resetDays: 3, poolFallbackTtlMs: 0, defaults: { plugins: 10, cpuCredits: 10 } } },
}));

const { quotaService } = await import('../src/services/quota-service.js');
const { pooledStatusFromRows } = await import('../src/services/pooled-quota.js');

const DAY = 86_400_000;
const live = () => new Date(Date.now() + 10 * DAY);
const expired = () => new Date(Date.now() - DAY);

/** A faithful single-document store: the filter `$expr` decides, the pipeline writes. */
function storeOf(doc: Record<string, unknown>) {
  const state = { doc };
  findOneAndUpdate.mockImplementation(async (filter: { $expr?: unknown }, stages: Array<{ $set: Record<string, unknown> }>) => {
    if (!exprAdmits(filter, state.doc)) return null;
    state.doc = applyPipeline(stages, state.doc);
    return state.doc;
  });
  findById.mockImplementation(() => {
    // Both the hydrated read (`await findById()`) and the lean projection
    // (`findById().select().lean()`) the exceeded paths use.
    const p = Promise.resolve(state.doc) as Promise<unknown> & { select: () => { lean: () => Promise<unknown> } };
    p.select = () => ({ lean: async () => state.doc });
    return p;
  });
  return state;
}

beforeEach(() => {
  jest.clearAllMocks();
  findOrgWithHierarchy.mockResolvedValue({ self: null, hasChildren: false }); // flat org
  updateOne.mockResolvedValue({ acknowledged: true });
});

describe('flat org: the increment filter honours the period snapshot', () => {
  it('a mid-period DOWNGRADE does not strand the account (1000 → 100 while at 400)', async () => {
    const state = storeOf({
      _id: 'o',
      tier: 'developer',
      quotas: { plugins: 100 },
      usage: { plugins: { used: 400, resetAt: live(), limitAtPeriodStart: 1000 } },
    });

    const result = await quotaService.incrementUsage('o', 'plugins', 1);

    expect(result.exceeded).toBe(false);
    // The cap the reservation was admitted under, not the lowered one — so
    // `remaining` agrees with what the next reservation will be judged by.
    expect(result.quota).toMatchObject({ limit: 1000, used: 401, remaining: 599 });
    // The snapshot survives the write for the rest of the period.
    expect((state.doc.usage as any).plugins.limitAtPeriodStart).toBe(1000);
  });

  it('still refuses at the period\'s effective cap', async () => {
    storeOf({
      _id: 'o',
      tier: 'developer',
      quotas: { plugins: 100 },
      usage: { plugins: { used: 1000, resetAt: live(), limitAtPeriodStart: 1000 } },
    });

    const result = await quotaService.incrementUsage('o', 'plugins', 1);

    expect(result.exceeded).toBe(true);
    // Reported as the EFFECTIVE limit: `incrementMetered` sizes its partial
    // retry from this figure, and the nominal 100 would make it think nothing fits.
    expect(result.quota).toMatchObject({ limit: 1000, used: 1000, remaining: 0 });
  });

  it('an UPGRADE lands immediately (the max picks the larger)', async () => {
    storeOf({
      _id: 'o',
      tier: 'developer',
      quotas: { plugins: 2000 },
      usage: { plugins: { used: 1500, resetAt: live(), limitAtPeriodStart: 1000 } },
    });
    expect((await quotaService.incrementUsage('o', 'plugins', 1)).exceeded).toBe(false);
  });

  it('an EXPIRED period starts at the CURRENT limit — the reduction applies from the next window', async () => {
    storeOf({
      _id: 'o',
      tier: 'developer',
      quotas: { plugins: 100 },
      usage: { plugins: { used: 400, resetAt: expired(), limitAtPeriodStart: 1000 } },
    });
    expect((await quotaService.incrementUsage('o', 'plugins', 101)).exceeded).toBe(true);
    const ok = await quotaService.incrementUsage('o', 'plugins', 100);
    expect(ok.exceeded).toBe(false);
    expect(ok.quota).toMatchObject({ limit: 100, used: 100 });
  });

  it('no snapshot (a counter predating the field) binds on the current limit', async () => {
    storeOf({ _id: 'o', tier: 'developer', quotas: { plugins: 100 }, usage: { plugins: { used: 99, resetAt: live() } } });
    expect((await quotaService.incrementUsage('o', 'plugins', 2)).exceeded).toBe(true);
    expect((await quotaService.incrementUsage('o', 'plugins', 1)).exceeded).toBe(false);
  });

  it('a period that began UNLIMITED stays unlimited until it rolls', async () => {
    storeOf({
      _id: 'o',
      tier: 'developer',
      quotas: { plugins: 100 },
      usage: { plugins: { used: 5000, resetAt: live(), limitAtPeriodStart: -1 } },
    });
    const result = await quotaService.incrementUsage('o', 'plugins', 1);
    expect(result.exceeded).toBe(false);
    expect(result.quota.limit).toBe(-1);
  });

  it('metered admission sizes its partial fit against the effective cap', async () => {
    const state = storeOf({
      _id: 'o',
      tier: 'developer',
      quotas: { plugins: 100 },
      usage: { plugins: { used: 990, resetAt: live(), limitAtPeriodStart: 1000 } },
    });
    const result = await quotaService.incrementMetered('o', 'plugins', 25);
    expect(result).toMatchObject({ counted: 10, overshoot: 15 });
    expect((state.doc.usage as any).plugins.used).toBe(1000);
  });
});

describe('pooled root: the pool filter honours the pool period snapshot', () => {
  beforeEach(() => {
    findOrgWithHierarchy.mockResolvedValue({ self: { _id: 'root' }, hasChildren: true });
  });

  it('a mid-period downgrade does not strand a pooled account', async () => {
    storeOf({
      _id: 'root',
      tier: 'developer',
      quotas: { cpuCredits: 100 },
      usage: { cpuCredits: { used: 400, resetAt: live() } },
      poolUsage: { cpuCredits: { used: 400, resetAt: live(), limitAtPeriodStart: 1000 } },
    });
    const result = await quotaService.incrementUsage('root', 'cpuCredits', 1);
    expect(result.exceeded).toBe(false);
    expect(result.quota).toMatchObject({ limit: 1000, used: 401 });
  });

  it('an unstarted pool is seeded from the root\'s own live usage and binds on the current limit', async () => {
    const state = storeOf({
      _id: 'root',
      tier: 'developer',
      quotas: { plugins: 100 },
      usage: { plugins: { used: 99, resetAt: live() } },
    });
    expect((await quotaService.incrementUsage('root', 'plugins', 2)).exceeded).toBe(true);
    expect((await quotaService.incrementUsage('root', 'plugins', 1)).exceeded).toBe(false);
    expect((state.doc.poolUsage as any).plugins).toMatchObject({ used: 100, limitAtPeriodStart: 100 });
  });

  it('an expired pool period starts afresh at the current limit', async () => {
    storeOf({
      _id: 'root',
      tier: 'developer',
      quotas: { plugins: 100 },
      usage: { plugins: { used: 0, resetAt: expired() } },
      poolUsage: { plugins: { used: 999, resetAt: expired(), limitAtPeriodStart: 1000 } },
    });
    expect((await quotaService.incrementUsage('root', 'plugins', 101)).exceeded).toBe(true);
    expect((await quotaService.incrementUsage('root', 'plugins', 100)).exceeded).toBe(false);
  });
});

describe('the gate reads agree with enforcement', () => {
  it('getQuotaStatus (flat) carries the snapshot instead of dropping it', async () => {
    findOrgWithHierarchy.mockResolvedValue({
      self: { _id: 'o', tier: 'developer', quotas: { plugins: 100 }, usage: { plugins: { used: 400, resetAt: live(), limitAtPeriodStart: 1000 } } },
      hasChildren: false,
    });
    expect(await quotaService.getQuotaStatus('o', 'plugins')).toMatchObject({ allowed: true, limit: 1000, remaining: 600 });
  });

  it('pooledStatusFromRows binds `allowed` on the EFFECTIVE cap, like `limit`', () => {
    const status = pooledStatusFromRows([{
      _id: 'root',
      tier: 'developer',
      quotas: { plugins: 100 },
      poolUsage: { plugins: { used: 400, resetAt: live(), limitAtPeriodStart: 1000 } },
    }], 'root', 'plugins');
    // It said `limit: 1000, remaining: 600` beside `allowed: false`.
    expect(status).toMatchObject({ limit: 1000, remaining: 600, allowed: true, unlimited: false });
  });
});
