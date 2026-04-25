// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Stripe helper functions.
 */

const mockFindOne = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../src/models/subscription', () => ({
  Subscription: { findOne: (...args: unknown[]) => mockFindOne(...args) },
}));

import { mapStripeStatus, findSubscriptionByStripeId } from '../src/helpers/stripe-helpers';

// mapStripeStatus

describe('mapStripeStatus', () => {
  it('maps active to active', () => {
    expect(mapStripeStatus('active')).toBe('active');
  });

  it('maps trialing to trialing', () => {
    expect(mapStripeStatus('trialing')).toBe('trialing');
  });

  it('maps past_due to past_due', () => {
    expect(mapStripeStatus('past_due')).toBe('past_due');
  });

  it('maps canceled and unpaid to canceled', () => {
    expect(mapStripeStatus('canceled')).toBe('canceled');
    expect(mapStripeStatus('unpaid')).toBe('canceled');
  });

  it('maps incomplete and incomplete_expired to incomplete', () => {
    expect(mapStripeStatus('incomplete')).toBe('incomplete');
    expect(mapStripeStatus('incomplete_expired')).toBe('incomplete');
  });

  it('returns incomplete for unknown statuses', () => {
    expect(mapStripeStatus('something_new')).toBe('incomplete');
    expect(mapStripeStatus('')).toBe('incomplete');
  });
});

// findSubscriptionByStripeId

describe('findSubscriptionByStripeId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries by externalId and stripe provider', async () => {
    mockFindOne.mockResolvedValue({ _id: 'sub-1' });

    const result = await findSubscriptionByStripeId('sub_stripe_123');

    expect(mockFindOne).toHaveBeenCalledWith({
      'externalId': 'sub_stripe_123',
      'metadata.provider': 'stripe',
    });
    expect(result).toEqual({ _id: 'sub-1' });
  });

  it('returns null when no subscription matches', async () => {
    mockFindOne.mockResolvedValue(null);

    const result = await findSubscriptionByStripeId('sub_missing');

    expect(result).toBeNull();
  });
});
