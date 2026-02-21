import {
  QUOTA_TIERS,
  VALID_TIERS,
  DEFAULT_TIER,
  isValidTier,
  getTierLimits,
} from '../src/types/quota-tiers';

describe('QUOTA_TIERS', () => {
  it('should define developer tier', () => {
    expect(QUOTA_TIERS.developer).toEqual({
      label: 'Developer',
      limits: { plugins: 100, pipelines: 10, apiCalls: -1 },
    });
  });

  it('should define pro tier', () => {
    expect(QUOTA_TIERS.pro).toEqual({
      label: 'Pro',
      limits: { plugins: 1000, pipelines: 100, apiCalls: -1 },
    });
  });

  it('should define unlimited tier', () => {
    expect(QUOTA_TIERS.unlimited).toEqual({
      label: 'Unlimited',
      limits: { plugins: -1, pipelines: -1, apiCalls: -1 },
    });
  });
});

describe('VALID_TIERS', () => {
  it('should contain all tier names', () => {
    expect(VALID_TIERS).toContain('developer');
    expect(VALID_TIERS).toContain('pro');
    expect(VALID_TIERS).toContain('unlimited');
    expect(VALID_TIERS).toHaveLength(3);
  });
});

describe('DEFAULT_TIER', () => {
  it('should be developer', () => {
    expect(DEFAULT_TIER).toBe('developer');
  });
});

describe('isValidTier', () => {
  it('should return true for valid tiers', () => {
    expect(isValidTier('developer')).toBe(true);
    expect(isValidTier('pro')).toBe(true);
    expect(isValidTier('unlimited')).toBe(true);
  });

  it('should return false for invalid tiers', () => {
    expect(isValidTier('free')).toBe(false);
    expect(isValidTier('enterprise')).toBe(false);
    expect(isValidTier('')).toBe(false);
    expect(isValidTier('Developer')).toBe(false);
  });
});

describe('getTierLimits', () => {
  it('should return limits for valid tiers', () => {
    expect(getTierLimits('developer')).toEqual({ plugins: 100, pipelines: 10, apiCalls: -1 });
    expect(getTierLimits('pro')).toEqual({ plugins: 1000, pipelines: 100, apiCalls: -1 });
    expect(getTierLimits('unlimited')).toEqual({ plugins: -1, pipelines: -1, apiCalls: -1 });
  });

  it('should fall back to developer limits for invalid tiers', () => {
    expect(getTierLimits('invalid')).toEqual({ plugins: 100, pipelines: 10, apiCalls: -1 });
    expect(getTierLimits('')).toEqual({ plugins: 100, pipelines: 10, apiCalls: -1 });
  });
});
