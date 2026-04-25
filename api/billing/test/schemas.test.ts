// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for zod validation schemas used by billing routes.
 */

import {
  SubscriptionCreateSchema,
  SubscriptionUpdateSchema,
  AdminSubscriptionUpdateSchema,
} from '../src/validation/schemas';

// SubscriptionCreateSchema

describe('SubscriptionCreateSchema', () => {
  it('accepts a valid payload with explicit interval', () => {
    const result = SubscriptionCreateSchema.parse({ planId: 'pro', interval: 'annual' });
    expect(result).toEqual({ planId: 'pro', interval: 'annual' });
  });

  it('defaults interval to "monthly" when omitted', () => {
    const result = SubscriptionCreateSchema.parse({ planId: 'pro' });
    expect(result.interval).toBe('monthly');
  });

  it('rejects empty planId', () => {
    expect(() => SubscriptionCreateSchema.parse({ planId: '' })).toThrow();
  });

  it('rejects missing planId', () => {
    expect(() => SubscriptionCreateSchema.parse({})).toThrow();
  });

  it('rejects invalid interval', () => {
    expect(() => SubscriptionCreateSchema.parse({ planId: 'pro', interval: 'weekly' })).toThrow();
  });
});

// SubscriptionUpdateSchema

describe('SubscriptionUpdateSchema', () => {
  it('accepts only planId', () => {
    const result = SubscriptionUpdateSchema.parse({ planId: 'enterprise' });
    expect(result).toEqual({ planId: 'enterprise' });
  });

  it('accepts only interval', () => {
    const result = SubscriptionUpdateSchema.parse({ interval: 'annual' });
    expect(result).toEqual({ interval: 'annual' });
  });

  it('accepts both fields', () => {
    const result = SubscriptionUpdateSchema.parse({ planId: 'pro', interval: 'monthly' });
    expect(result).toEqual({ planId: 'pro', interval: 'monthly' });
  });

  it('accepts an empty object (route-level validation enforces at-least-one)', () => {
    expect(() => SubscriptionUpdateSchema.parse({})).not.toThrow();
  });

  it('rejects empty planId string', () => {
    expect(() => SubscriptionUpdateSchema.parse({ planId: '' })).toThrow();
  });
});

// AdminSubscriptionUpdateSchema

describe('AdminSubscriptionUpdateSchema', () => {
  it('accepts a complete admin override payload', () => {
    const result = AdminSubscriptionUpdateSchema.parse({
      planId: 'pro',
      status: 'active',
      interval: 'annual',
      cancelAtPeriodEnd: true,
    });
    expect(result.status).toBe('active');
    expect(result.cancelAtPeriodEnd).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(() => AdminSubscriptionUpdateSchema.parse({})).not.toThrow();
  });

  it('rejects an invalid status value', () => {
    expect(() =>
      AdminSubscriptionUpdateSchema.parse({ status: 'paused' }),
    ).toThrow();
  });

  it('rejects non-boolean cancelAtPeriodEnd', () => {
    expect(() =>
      AdminSubscriptionUpdateSchema.parse({ cancelAtPeriodEnd: 'yes' }),
    ).toThrow();
  });
});
