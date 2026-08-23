// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for seed-plans helper.
 *
 * Verifies that seedPlans() reconciles the plan catalog in Mongo with the
 * env-driven Config.get('billing').plans on every boot: upserting each
 * configured plan (so env price/feature changes propagate), retiring plans no
 * longer in config, and invalidating the plan read-cache.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockBulkWrite = jest.fn();
const mockUpdateMany = jest.fn();
const mockInvalidate = jest.fn();

jest.unstable_mockModule('../src/models/plan.js', () => ({
  Plan: {
    bulkWrite: mockBulkWrite,
    updateMany: mockUpdateMany,
  },
}));

jest.unstable_mockModule('../src/routes/read-plans.js', () => ({
  invalidatePlanCache: mockInvalidate,
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const mockPlans = [
  {
    id: 'developer',
    name: 'Developer',
    description: 'Free starter tier',
    tier: 'developer',
    prices: { monthly: 0, annual: 0 },
    features: ['Up to 100 plugins'],
    isActive: true,
    isDefault: true,
    sortOrder: 0,
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'For teams',
    tier: 'pro',
    prices: { monthly: 999, annual: 9990 },
    features: ['Up to 1,000 plugins'],
    isActive: true,
    isDefault: false,
    sortOrder: 1,
  },
];

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: {
    get: (section: string) => {
      if (section === 'billing') return { plans: mockPlans };
      return {};
    },
  },
}));

const { seedPlans } = await import('../src/helpers/seed-plans.js');

describe('seedPlans', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBulkWrite.mockResolvedValue({ upsertedCount: 2, modifiedCount: 0 });
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockInvalidate.mockResolvedValue(0);
  });

  it('upserts every configured plan by _id (so env changes propagate)', async () => {
    await seedPlans();

    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
    const ops = mockBulkWrite.mock.calls[0][0] as Array<{ updateOne: { filter: { _id: string }; update: { $set: Record<string, unknown> }; upsert: boolean } }>;
    expect(ops).toHaveLength(2);

    expect(ops[0].updateOne.filter).toEqual({ _id: 'developer' });
    expect(ops[0].updateOne.upsert).toBe(true);
    expect(ops[0].updateOne.update.$set).toMatchObject({
      name: 'Developer',
      tier: 'developer',
      prices: { monthly: 0, annual: 0 },
    });

    expect(ops[1].updateOne.filter).toEqual({ _id: 'pro' });
    expect(ops[1].updateOne.update.$set).toMatchObject({
      name: 'Pro',
      tier: 'pro',
      prices: { monthly: 999, annual: 9990 },
    });
  });

  it('reconciles on every boot (does NOT skip when plans already exist)', async () => {
    // No count guard any more — reconcile runs unconditionally so price/feature
    // edits in env always land.
    await seedPlans();
    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
  });

  it('retires plans not present in the current config (deactivate, not delete)', async () => {
    await seedPlans();

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateMany.mock.calls[0];
    expect(filter).toEqual({ _id: { $nin: ['developer', 'pro'] }, isActive: true });
    expect(update).toEqual({ $set: { isActive: false } });
  });

  it('invalidates the plan read-cache after reconciling', async () => {
    await seedPlans();
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });

  it('spreads readonly features to a mutable array', async () => {
    await seedPlans();
    const ops = mockBulkWrite.mock.calls[0][0] as Array<{ updateOne: { update: { $set: { features: unknown } } } }>;
    const features = ops[0].updateOne.update.$set.features as string[];
    expect(Array.isArray(features)).toBe(true);
    expect(features).toEqual(['Up to 100 plugins']);
  });
});
