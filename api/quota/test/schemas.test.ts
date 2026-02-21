// ---------------------------------------------------------------------------
// Mock dependencies required by schemas module
// ---------------------------------------------------------------------------
jest.mock('../src/config', () => ({
  config: {
    quota: {
      defaults: { plugins: 100, pipelines: 10, apiCalls: -1 },
      resetDays: 3,
    },
  },
}));

jest.mock('@mwashburn160/api-core', () => ({
  sendError: jest.fn(),
  ErrorCode: {},
  DEFAULT_TIER: 'developer',
  VALID_QUOTA_TYPES: ['plugins', 'pipelines', 'apiCalls'] as const,
  QUOTA_TIERS: {},
  VALID_TIERS: ['developer', 'pro', 'unlimited'],
  isValidTier: jest.fn(),
  getTierLimits: jest.fn(),
  isValidQuotaType: jest.fn(),
}));

import { UpdateQuotaSchema, IncrementQuotaSchema, ResetQuotaSchema } from '../src/validation/schemas';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpdateQuotaSchema', () => {
  it('should accept valid name update', () => {
    const result = UpdateQuotaSchema.safeParse({ name: 'My Org' });
    expect(result.success).toBe(true);
  });

  it('should accept valid slug update', () => {
    const result = UpdateQuotaSchema.safeParse({ slug: 'my-org' });
    expect(result.success).toBe(true);
  });

  it('should accept valid tier update', () => {
    const result = UpdateQuotaSchema.safeParse({ tier: 'pro' });
    expect(result.success).toBe(true);
  });

  it('should accept valid quota limits update', () => {
    const result = UpdateQuotaSchema.safeParse({
      quotas: { plugins: 500, pipelines: 50, apiCalls: -1 },
    });
    expect(result.success).toBe(true);
  });

  it('should accept partial quota limits', () => {
    const result = UpdateQuotaSchema.safeParse({ quotas: { plugins: 200 } });
    expect(result.success).toBe(true);
  });

  it('should reject empty body', () => {
    const result = UpdateQuotaSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject invalid tier value', () => {
    const result = UpdateQuotaSchema.safeParse({ tier: 'enterprise' });
    expect(result.success).toBe(false);
  });

  it('should reject invalid slug format', () => {
    const result = UpdateQuotaSchema.safeParse({ slug: 'UPPER_CASE' });
    expect(result.success).toBe(false);
  });

  it('should reject empty name', () => {
    const result = UpdateQuotaSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('should reject quota below -1', () => {
    const result = UpdateQuotaSchema.safeParse({ quotas: { plugins: -5 } });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer quota', () => {
    const result = UpdateQuotaSchema.safeParse({ quotas: { plugins: 1.5 } });
    expect(result.success).toBe(false);
  });

  it('should accept combined update', () => {
    const result = UpdateQuotaSchema.safeParse({
      name: 'Updated Org',
      tier: 'unlimited',
      quotas: { plugins: -1 },
    });
    expect(result.success).toBe(true);
  });
});

describe('IncrementQuotaSchema', () => {
  it('should accept valid quota type with default amount', () => {
    const result = IncrementQuotaSchema.safeParse({ quotaType: 'plugins' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(1);
    }
  });

  it('should accept valid quota type with custom amount', () => {
    const result = IncrementQuotaSchema.safeParse({ quotaType: 'apiCalls', amount: 5 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(5);
    }
  });

  it('should accept all valid quota types', () => {
    for (const type of ['plugins', 'pipelines', 'apiCalls']) {
      const result = IncrementQuotaSchema.safeParse({ quotaType: type });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid quota type', () => {
    const result = IncrementQuotaSchema.safeParse({ quotaType: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('should reject missing quota type', () => {
    const result = IncrementQuotaSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject amount less than 1', () => {
    const result = IncrementQuotaSchema.safeParse({ quotaType: 'plugins', amount: 0 });
    expect(result.success).toBe(false);
  });

  it('should reject negative amount', () => {
    const result = IncrementQuotaSchema.safeParse({ quotaType: 'plugins', amount: -1 });
    expect(result.success).toBe(false);
  });

  it('should reject non-integer amount', () => {
    const result = IncrementQuotaSchema.safeParse({ quotaType: 'plugins', amount: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe('ResetQuotaSchema', () => {
  it('should accept no fields (reset all)', () => {
    const result = ResetQuotaSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.quotaType).toBeUndefined();
    }
  });

  it('should accept valid quota type', () => {
    const result = ResetQuotaSchema.safeParse({ quotaType: 'plugins' });
    expect(result.success).toBe(true);
  });

  it('should accept all valid quota types', () => {
    for (const type of ['plugins', 'pipelines', 'apiCalls']) {
      const result = ResetQuotaSchema.safeParse({ quotaType: type });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid quota type', () => {
    const result = ResetQuotaSchema.safeParse({ quotaType: 'invalid' });
    expect(result.success).toBe(false);
  });
});
