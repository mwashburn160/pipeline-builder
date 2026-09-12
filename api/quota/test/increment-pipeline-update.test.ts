// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for the Mongoose 9 pipeline-update break.
 *
 * `incrementUsage` / `decrementUsage` drive an aggregation-pipeline (array)
 * update via `findOneAndUpdate`. As of Mongoose 9 a pipeline-array update
 * throws "Cannot pass an array to query updates unless the `updatePipeline`
 * option is set." — which surfaced as a 500 on EVERY quota increment (and, via
 * the quota client's fail-closed path, a 429 that blocked all plugin uploads).
 *
 * The pre-existing quota suites mock the Organization model wholesale, so they
 * never exercised the real driver guard — which is exactly why the bump slipped
 * through. This file closes that gap two ways:
 *   1. assert OUR service hands Mongoose an array update WITH `updatePipeline:true`
 *   2. assert the REAL Mongoose guard rejects the array update WITHOUT it (and
 *      accepts it with it) — so a future Mongoose change, or a dropped option,
 *      fails loudly here instead of in production.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import mongoose from 'mongoose';
import { apiCoreMock } from './helpers/mock-api-core.js';

// The quota-service module graph (quota-service + quota-helpers) imports these
// names from api-core; ESM linking needs them present even though the paths we
// exercise don't call them.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isValidTier: () => true,
  ValidationError: class ValidationError extends Error {},
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'],
  // quota-helpers re-exports these from api-core, so the linker needs them too.
  QUOTA_TIERS: { developer: { limits: { plugins: 100, pipelines: 10, apiCalls: -1 } } },
  VALID_TIERS: ['developer', 'pro', 'team', 'enterprise'],
  isValidQuotaType: (t: string) => ['plugins', 'pipelines', 'apiCalls'].includes(t),
}));

// Capture the exact (filter, update, options) the service passes to Mongoose.
const findOneAndUpdate = jest.fn();
const findById = jest.fn();
jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: { findOneAndUpdate, findById },
}));

// Flat org → `getParentOrgId` returns undefined → `pooledLimitAndUsage`
// short-circuits and `checkSharedRootCap` returns null → incrementUsage takes
// the atomic pipeline-update path (the one that broke), not the shared-cap branch.
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  getParentOrgId: async () => undefined,
  resolveRootOrgId: async (id: string) => id,
  expandOrgScope: async (id: string) => [id],
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { quota: { resetDays: 30, defaults: { pipelines: 10, plugins: 10, apiCalls: 1000, aiCalls: 100 } } },
}));

const { quotaService } = await import('../src/services/quota-service.js');

// Satisfies both the increment and decrement success-path reads
// (`org.quotas[type]` + `org.usage[type].used/resetAt`).
const fakeOrg = {
  quotas: { plugins: 100 },
  usage: { plugins: { used: 1, resetAt: new Date('2026-07-01T00:00:00.000Z') } },
};

beforeEach(() => {
  jest.clearAllMocks();
  findOneAndUpdate.mockResolvedValue(fakeOrg);
});

describe('quota service passes updatePipeline:true on pipeline-array updates', () => {
  it('incrementUsage sends an array (pipeline) update WITH updatePipeline:true', async () => {
    await quotaService.incrementUsage('org-1', 'plugins', 1);

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, update, options] = findOneAndUpdate.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(Array.isArray(update)).toBe(true); // aggregation pipeline
    expect(options).toEqual(expect.objectContaining({ updatePipeline: true }));
  });

  it('decrementUsage sends an array (pipeline) update WITH updatePipeline:true', async () => {
    await quotaService.decrementUsage('org-1', 'plugins', 1);

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, update, options] = findOneAndUpdate.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(Array.isArray(update)).toBe(true);
    expect(options).toEqual(expect.objectContaining({ updatePipeline: true }));
  });

  it('bypassLimit increment also sends an array (pipeline) update WITH updatePipeline:true', async () => {
    // The sysadmin bypass path skips the limit check but still resets an expired
    // period via the same reset-if-expired pipeline, so it too must set
    // updatePipeline:true or the Mongoose 9 driver rejects the array update.
    await quotaService.incrementUsage('org-1', 'plugins', 1, { bypassLimit: true });

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, update, options] = findOneAndUpdate.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(Array.isArray(update)).toBe(true);
    expect(options).toEqual(expect.objectContaining({ updatePipeline: true }));
  });
});

describe('real Mongoose 9 guard — why updatePipeline is required', () => {
  // Throwaway real model. The guard fires synchronously when the query is built,
  // before any server round-trip, so no DB connection (or in-memory server) is
  // needed — we never `.exec()` these queries.
  const Probe =
    mongoose.models.QuotaUpdatePipelineProbe ||
    mongoose.model('QuotaUpdatePipelineProbe', new mongoose.Schema({ n: Number }));
  const pipeline = [{ $set: { n: { $add: ['$n', 1] } } }];

  it('REJECTS a pipeline-array update when updatePipeline is omitted', () => {
    expect(() =>
      Probe.findOneAndUpdate({ _id: new mongoose.Types.ObjectId() }, pipeline, { returnDocument: 'after' }),
    ).toThrow(/Cannot pass an array to query updates/);
  });

  it('ACCEPTS the same update when updatePipeline:true is set (the fix)', () => {
    expect(() =>
      Probe.findOneAndUpdate({ _id: new mongoose.Types.ObjectId() }, pipeline, {
        returnDocument: 'after',
        updatePipeline: true,
      }),
    ).not.toThrow();
  });
});

describe('un-backfilled org docs never yield undefined/NaN quota numbers', () => {
  /**
   * The exceeded path and the read path both defaulted a missing stored limit to
   * the tier default; the SUCCESS path did not. So for a newly-added quota type
   * on an un-backfilled org doc, a successful reservation returned
   * `limit: undefined` and `remaining: Math.max(0, undefined - used)` = NaN —
   * which flowed to every `reserveQuota` caller and the `/quotas` read surface.
   */
  it('incrementUsage defaults a MISSING stored limit on the success path', async () => {
    // `quotas.plugins` absent — exactly the un-backfilled shape.
    findOneAndUpdate.mockResolvedValue({
      quotas: {},
      usage: { plugins: { used: 3, resetAt: new Date('2026-07-01T00:00:00.000Z') } },
    });

    const { quota } = await quotaService.incrementUsage('org-1', 'plugins', 1);

    expect(quota.limit).toBe(10); // config default for plugins
    expect(quota.remaining).not.toBeNaN();
    expect(quota.remaining).toBe(7);
  });

  it('treats a missing `used` as 0 rather than propagating NaN', async () => {
    // `resetAt` present but `used` absent — the subdoc shape the $ifNull guards.
    findOneAndUpdate.mockResolvedValue({
      quotas: { plugins: 10 },
      usage: { plugins: { resetAt: new Date('2026-07-01T00:00:00.000Z') } },
    });

    const { quota } = await quotaService.incrementUsage('org-1', 'plugins', 1);

    expect(quota.used).toBe(0);
    expect(quota.remaining).toBe(10);
    expect(quota.remaining).not.toBeNaN();
  });

  it('guards `used` with $ifNull in BOTH the filter and the update', async () => {
    await quotaService.incrementUsage('org-1', 'plugins', 1);
    const [filter, update] = findOneAndUpdate.mock.calls[0] as [unknown, unknown];

    // A subdoc with resetAt set but `used` absent made `$add` yield null, so
    // `used` was WRITTEN as null and stopped incrementing (and enforcing).
    expect(JSON.stringify(filter)).toContain('$ifNull');
    expect(JSON.stringify(update)).toContain('$ifNull');
  });

  it('decrementUsage also defaults a missing stored limit', async () => {
    findOneAndUpdate.mockResolvedValue({
      quotas: {},
      usage: { plugins: { used: 2, resetAt: new Date('2026-07-01T00:00:00.000Z') } },
    });

    const result = await quotaService.decrementUsage('org-1', 'plugins', 1);

    expect(result?.quota.limit).toBe(10);
    expect(result?.quota.remaining).not.toBeNaN();
  });
});
