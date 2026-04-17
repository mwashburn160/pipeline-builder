// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for seed-plans helper.
 *
 * Verifies that seedPlans() reads plan definitions from Config.get('billing').plans
 * and inserts them into MongoDB when no plans exist.
 */

const mockCountDocuments = jest.fn();
const mockInsertMany = jest.fn();

jest.mock('../src/models/plan', () => ({
  Plan: {
    countDocuments: mockCountDocuments,
    insertMany: mockInsertMany,
  },
}));

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

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

jest.mock('@pipeline-builder/pipeline-core', () => ({
  Config: {
    get: (section: string) => {
      if (section === 'billing') return { plans: mockPlans };
      return {};
    },
  },
}));

import { seedPlans } from '../src/helpers/seed-plans';

describe('seedPlans', () => {
  beforeEach(() => jest.clearAllMocks());

  it('seeds plans from Config when collection is empty', async () => {
    mockCountDocuments.mockResolvedValue(0);
    mockInsertMany.mockResolvedValue(mockPlans);

    await seedPlans();

    expect(mockInsertMany).toHaveBeenCalledTimes(1);
    const insertedDocs = mockInsertMany.mock.calls[0][0];
    expect(insertedDocs).toHaveLength(2);
    expect(insertedDocs[0]).toMatchObject({
      _id: 'developer',
      name: 'Developer',
      tier: 'developer',
      prices: { monthly: 0, annual: 0 },
    });
    expect(insertedDocs[1]).toMatchObject({
      _id: 'pro',
      name: 'Pro',
      tier: 'pro',
      prices: { monthly: 999, annual: 9990 },
    });
  });

  it('skips seeding when plans already exist', async () => {
    mockCountDocuments.mockResolvedValue(3);

    await seedPlans();

    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  it('maps id to _id for Mongoose documents', async () => {
    mockCountDocuments.mockResolvedValue(0);
    mockInsertMany.mockResolvedValue(mockPlans);

    await seedPlans();

    const insertedDocs = mockInsertMany.mock.calls[0][0];
    // Should use _id (Mongoose), not id (Config)
    expect(insertedDocs[0]._id).toBe('developer');
    expect(insertedDocs[0].id).toBeUndefined();
  });

  it('spreads readonly features to mutable array', async () => {
    mockCountDocuments.mockResolvedValue(0);
    mockInsertMany.mockResolvedValue(mockPlans);

    await seedPlans();

    const insertedDocs = mockInsertMany.mock.calls[0][0];
    expect(Array.isArray(insertedDocs[0].features)).toBe(true);
    expect(insertedDocs[0].features).toEqual(['Up to 100 plugins']);
  });
});
