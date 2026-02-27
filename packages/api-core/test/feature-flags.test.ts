import {
  ALL_FEATURE_FLAGS,
  TIER_FEATURES,
  FEATURE_METADATA,
  isValidFeatureFlag,
  resolveUserFeatures,
  hasFeature,
} from '../src/types/feature-flags';

// ---------------------------------------------------------------------------
// ALL_FEATURE_FLAGS
// ---------------------------------------------------------------------------

describe('ALL_FEATURE_FLAGS', () => {
  it('should contain all 6 feature flags', () => {
    expect(ALL_FEATURE_FLAGS).toHaveLength(6);
    expect(ALL_FEATURE_FLAGS).toContain('advanced_analytics');
    expect(ALL_FEATURE_FLAGS).toContain('priority_support');
    expect(ALL_FEATURE_FLAGS).toContain('ai_generation');
    expect(ALL_FEATURE_FLAGS).toContain('bulk_operations');
    expect(ALL_FEATURE_FLAGS).toContain('custom_integrations');
    expect(ALL_FEATURE_FLAGS).toContain('audit_log');
  });
});

// ---------------------------------------------------------------------------
// TIER_FEATURES
// ---------------------------------------------------------------------------

describe('TIER_FEATURES', () => {
  it('developer tier has no features', () => {
    expect(TIER_FEATURES.developer).toEqual([]);
  });

  it('pro tier has 4 features', () => {
    expect(TIER_FEATURES.pro).toHaveLength(4);
    expect(TIER_FEATURES.pro).toContain('advanced_analytics');
    expect(TIER_FEATURES.pro).toContain('priority_support');
    expect(TIER_FEATURES.pro).toContain('ai_generation');
    expect(TIER_FEATURES.pro).toContain('bulk_operations');
  });

  it('pro tier does NOT include custom_integrations or audit_log', () => {
    expect(TIER_FEATURES.pro).not.toContain('custom_integrations');
    expect(TIER_FEATURES.pro).not.toContain('audit_log');
  });

  it('unlimited tier has all features', () => {
    expect(TIER_FEATURES.unlimited).toEqual(expect.arrayContaining([...ALL_FEATURE_FLAGS]));
    expect(TIER_FEATURES.unlimited).toHaveLength(ALL_FEATURE_FLAGS.length);
  });
});

// ---------------------------------------------------------------------------
// FEATURE_METADATA
// ---------------------------------------------------------------------------

describe('FEATURE_METADATA', () => {
  it('has metadata for every feature flag', () => {
    for (const flag of ALL_FEATURE_FLAGS) {
      expect(FEATURE_METADATA[flag]).toBeDefined();
      expect(FEATURE_METADATA[flag].label).toBeTruthy();
      expect(FEATURE_METADATA[flag].description).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// isValidFeatureFlag
// ---------------------------------------------------------------------------

describe('isValidFeatureFlag', () => {
  it('returns true for valid flags', () => {
    expect(isValidFeatureFlag('advanced_analytics')).toBe(true);
    expect(isValidFeatureFlag('audit_log')).toBe(true);
    expect(isValidFeatureFlag('ai_generation')).toBe(true);
  });

  it('returns false for invalid flags', () => {
    expect(isValidFeatureFlag('not_a_flag')).toBe(false);
    expect(isValidFeatureFlag('')).toBe(false);
    expect(isValidFeatureFlag('ADVANCED_ANALYTICS')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveUserFeatures
// ---------------------------------------------------------------------------

describe('resolveUserFeatures', () => {
  it('developer tier gets no features by default', () => {
    const features = resolveUserFeatures('developer');
    expect(features).toEqual([]);
  });

  it('pro tier gets 4 features by default', () => {
    const features = resolveUserFeatures('pro');
    expect(features).toHaveLength(4);
    expect(features).toContain('advanced_analytics');
    expect(features).toContain('priority_support');
    expect(features).toContain('ai_generation');
    expect(features).toContain('bulk_operations');
  });

  it('unlimited tier gets all features', () => {
    const features = resolveUserFeatures('unlimited');
    expect(features).toHaveLength(ALL_FEATURE_FLAGS.length);
    expect(features).toEqual([...ALL_FEATURE_FLAGS]);
  });

  it('system org always gets all features regardless of tier', () => {
    const features = resolveUserFeatures('developer', undefined, true);
    expect(features).toHaveLength(ALL_FEATURE_FLAGS.length);
    expect(features).toEqual([...ALL_FEATURE_FLAGS]);
  });

  it('system org ignores overrides', () => {
    const features = resolveUserFeatures('developer', { advanced_analytics: false }, true);
    expect(features).toEqual([...ALL_FEATURE_FLAGS]);
  });

  it('override true adds a feature to the tier', () => {
    const features = resolveUserFeatures('pro', { audit_log: true });
    expect(features).toContain('audit_log');
    expect(features).toHaveLength(5);
  });

  it('override false removes a feature from the tier', () => {
    const features = resolveUserFeatures('pro', { advanced_analytics: false });
    expect(features).not.toContain('advanced_analytics');
    expect(features).toHaveLength(3);
  });

  it('multiple overrides are applied correctly', () => {
    const features = resolveUserFeatures('pro', {
      advanced_analytics: false,
      audit_log: true,
      custom_integrations: true,
    });
    expect(features).not.toContain('advanced_analytics');
    expect(features).toContain('audit_log');
    expect(features).toContain('custom_integrations');
    expect(features).toHaveLength(5); // 4 - 1 + 2
  });

  it('invalid override keys are silently ignored', () => {
    const features = resolveUserFeatures('developer', { not_a_flag: true } as Record<string, boolean>);
    expect(features).toEqual([]);
  });

  it('null overrides are treated as no overrides', () => {
    const features = resolveUserFeatures('pro', null);
    expect(features).toHaveLength(4);
  });

  it('returns features in canonical order', () => {
    const features = resolveUserFeatures('developer', {
      audit_log: true,
      advanced_analytics: true,
    });
    // advanced_analytics should come before audit_log per ALL_FEATURE_FLAGS order
    expect(features.indexOf('advanced_analytics')).toBeLessThan(features.indexOf('audit_log'));
  });

  it('adding an already-included feature via override is a no-op', () => {
    const features = resolveUserFeatures('pro', { advanced_analytics: true });
    expect(features).toHaveLength(4); // unchanged
  });

  it('removing a feature not in the tier via override is a no-op', () => {
    const features = resolveUserFeatures('developer', { audit_log: false });
    expect(features).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hasFeature
// ---------------------------------------------------------------------------

describe('hasFeature', () => {
  it('returns true for tier-included features', () => {
    expect(hasFeature('pro', 'advanced_analytics')).toBe(true);
    expect(hasFeature('unlimited', 'audit_log')).toBe(true);
  });

  it('returns false for tier-excluded features', () => {
    expect(hasFeature('developer', 'advanced_analytics')).toBe(false);
    expect(hasFeature('pro', 'audit_log')).toBe(false);
  });

  it('system org always returns true', () => {
    expect(hasFeature('developer', 'audit_log', undefined, true)).toBe(true);
    expect(hasFeature('developer', 'advanced_analytics', undefined, true)).toBe(true);
  });

  it('override true enables a feature', () => {
    expect(hasFeature('developer', 'audit_log', { audit_log: true })).toBe(true);
  });

  it('override false disables a feature', () => {
    expect(hasFeature('pro', 'advanced_analytics', { advanced_analytics: false })).toBe(false);
  });

  it('falls back to tier default when no override', () => {
    expect(hasFeature('pro', 'advanced_analytics', {})).toBe(true);
    expect(hasFeature('pro', 'audit_log', {})).toBe(false);
  });

  it('null overrides fall back to tier default', () => {
    expect(hasFeature('pro', 'advanced_analytics', null)).toBe(true);
  });
});
