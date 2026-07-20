// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  ALL_FEATURE_FLAGS,
  TIER_FEATURES,
  FEATURE_METADATA,
  isValidFeatureFlag,
  resolveUserFeatures,
  hasFeature,
} from '../src/types/feature-flags.js';

// ALL_FEATURE_FLAGS

describe('ALL_FEATURE_FLAGS', () => {
  it('should contain all 6 feature flags', () => {
    expect(ALL_FEATURE_FLAGS).toHaveLength(6);
    expect(ALL_FEATURE_FLAGS).toContain('priority_support');
    expect(ALL_FEATURE_FLAGS).toContain('ai_generation');
    expect(ALL_FEATURE_FLAGS).toContain('bulk_operations');
    expect(ALL_FEATURE_FLAGS).toContain('custom_integrations');
    expect(ALL_FEATURE_FLAGS).toContain('audit_log');
    expect(ALL_FEATURE_FLAGS).toContain('sso');
  });
});

// TIER_FEATURES

describe('TIER_FEATURES', () => {
  it('developer tier has no features', () => {
    expect(TIER_FEATURES.developer).toEqual([]);
  });

  it('pro tier has 3 features', () => {
    expect(TIER_FEATURES.pro).toHaveLength(3);
    expect(TIER_FEATURES.pro).toContain('priority_support');
    expect(TIER_FEATURES.pro).toContain('ai_generation');
    expect(TIER_FEATURES.pro).toContain('bulk_operations');
  });

  it('pro tier does NOT include custom_integrations or audit_log', () => {
    expect(TIER_FEATURES.pro).not.toContain('custom_integrations');
    expect(TIER_FEATURES.pro).not.toContain('audit_log');
  });

  it('team tier includes audit_log but not custom_integrations', () => {
    expect(TIER_FEATURES.team).toContain('audit_log');
    expect(TIER_FEATURES.team).toContain('ai_generation');
    expect(TIER_FEATURES.team).not.toContain('custom_integrations');
  });

  it('enterprise tier has all features', () => {
    expect(TIER_FEATURES.enterprise).toEqual(expect.arrayContaining([...ALL_FEATURE_FLAGS]));
    expect(TIER_FEATURES.enterprise).toHaveLength(ALL_FEATURE_FLAGS.length);
  });
});

// FEATURE_METADATA

describe('FEATURE_METADATA', () => {
  it('has metadata for every feature flag', () => {
    for (const flag of ALL_FEATURE_FLAGS) {
      expect(FEATURE_METADATA[flag]).toBeDefined();
      expect(FEATURE_METADATA[flag].label).toBeTruthy();
      expect(FEATURE_METADATA[flag].description).toBeTruthy();
    }
  });
});

// isValidFeatureFlag

describe('isValidFeatureFlag', () => {
  it('returns true for valid flags', () => {
    expect(isValidFeatureFlag('audit_log')).toBe(true);
    expect(isValidFeatureFlag('ai_generation')).toBe(true);
    expect(isValidFeatureFlag('bulk_operations')).toBe(true);
  });

  it('returns false for invalid flags', () => {
    expect(isValidFeatureFlag('not_a_flag')).toBe(false);
    expect(isValidFeatureFlag('')).toBe(false);
    expect(isValidFeatureFlag('AUDIT_LOG')).toBe(false);
    expect(isValidFeatureFlag('advanced_analytics')).toBe(false);
  });
});

// resolveUserFeatures

describe('resolveUserFeatures', () => {
  it('unions account-level feature entitlements (purchased bundles)', () => {
    const features = resolveUserFeatures('developer', { accountFeatures: ['audit_log', 'not_a_flag'] });
    expect(features).toContain('audit_log'); // granted by an account bundle
    expect(features).not.toContain('not_a_flag'); // invalid flag ignored
  });

  it('a per-user override can still disable an account-entitled feature', () => {
    const features = resolveUserFeatures('developer', { overrides: { audit_log: false }, accountFeatures: ['audit_log'] });
    expect(features).not.toContain('audit_log');
  });

  it('developer tier gets no features by default', () => {
    const features = resolveUserFeatures('developer');
    expect(features).toEqual([]);
  });

  it('pro tier gets 3 features by default', () => {
    const features = resolveUserFeatures('pro');
    expect(features).toHaveLength(3);
    expect(features).toContain('priority_support');
    expect(features).toContain('ai_generation');
    expect(features).toContain('bulk_operations');
  });

  it('enterprise tier gets all features', () => {
    const features = resolveUserFeatures('enterprise');
    expect(features).toHaveLength(ALL_FEATURE_FLAGS.length);
    expect(features).toEqual([...ALL_FEATURE_FLAGS]);
  });

  it('system org always gets all features regardless of tier', () => {
    const features = resolveUserFeatures('developer', { isSuperAdmin: true });
    expect(features).toHaveLength(ALL_FEATURE_FLAGS.length);
    expect(features).toEqual([...ALL_FEATURE_FLAGS]);
  });

  it('system org ignores overrides', () => {
    const features = resolveUserFeatures('developer', { overrides: { ai_generation: false }, isSuperAdmin: true });
    expect(features).toEqual([...ALL_FEATURE_FLAGS]);
  });

  it('override true adds a feature to the tier', () => {
    const features = resolveUserFeatures('pro', { overrides: { audit_log: true } });
    expect(features).toContain('audit_log');
    expect(features).toHaveLength(4);
  });

  it('override false removes a feature from the tier', () => {
    const features = resolveUserFeatures('pro', { overrides: { priority_support: false } });
    expect(features).not.toContain('priority_support');
    expect(features).toHaveLength(2);
  });

  it('multiple overrides are applied correctly', () => {
    const features = resolveUserFeatures('pro', {
      overrides: {
        priority_support: false,
        audit_log: true,
        custom_integrations: true,
      },
    });
    expect(features).not.toContain('priority_support');
    expect(features).toContain('audit_log');
    expect(features).toContain('custom_integrations');
    expect(features).toHaveLength(4); // 3 - 1 + 2
  });

  it('invalid override keys are silently ignored', () => {
    const features = resolveUserFeatures('developer', { overrides: { not_a_flag: true } as Record<string, boolean> });
    expect(features).toEqual([]);
  });

  it('null overrides are treated as no overrides', () => {
    const features = resolveUserFeatures('pro', { overrides: null });
    expect(features).toHaveLength(3);
  });

  it('returns features in canonical order', () => {
    const features = resolveUserFeatures('developer', {
      overrides: {
        audit_log: true,
        ai_generation: true,
      },
    });
    expect(features.indexOf('ai_generation')).toBeLessThan(features.indexOf('audit_log'));
  });

  it('adding an already-included feature via override is a no-op', () => {
    const features = resolveUserFeatures('pro', { overrides: { ai_generation: true } });
    expect(features).toHaveLength(3); // unchanged
  });

  it('removing a feature not in the tier via override is a no-op', () => {
    const features = resolveUserFeatures('developer', { overrides: { audit_log: false } });
    expect(features).toEqual([]);
  });
});

// hasFeature

describe('hasFeature', () => {
  it('returns true for tier-included features', () => {
    expect(hasFeature('pro', 'ai_generation')).toBe(true);
    expect(hasFeature('enterprise', 'audit_log')).toBe(true);
  });

  it('returns false for tier-excluded features', () => {
    expect(hasFeature('developer', 'ai_generation')).toBe(false);
    expect(hasFeature('pro', 'audit_log')).toBe(false);
  });

  it('system org always returns true', () => {
    expect(hasFeature('developer', 'audit_log', undefined, true)).toBe(true);
    expect(hasFeature('developer', 'ai_generation', undefined, true)).toBe(true);
  });

  it('override true enables a feature', () => {
    expect(hasFeature('developer', 'audit_log', { audit_log: true })).toBe(true);
  });

  it('override false disables a feature', () => {
    expect(hasFeature('pro', 'ai_generation', { ai_generation: false })).toBe(false);
  });

  it('falls back to tier default when no override', () => {
    expect(hasFeature('pro', 'ai_generation', {})).toBe(true);
    expect(hasFeature('pro', 'audit_log', {})).toBe(false);
  });

  it('null overrides fall back to tier default', () => {
    expect(hasFeature('pro', 'ai_generation', null)).toBe(true);
  });
});
