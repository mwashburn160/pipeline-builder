// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';

import {
  COMPLIANCE_CONTENT_SETS,
  complianceFeatureForTags,
  complianceSetsForFeatures,
  ALL_FEATURE_FLAGS,
  TIER_FEATURES,
  FEATURE_METADATA,
  isValidFeatureFlag,
  resolveUserFeatures,
  SUPPORT_FEATURE_FLAGS,
} from '../src/types/feature-flags.js';

// ALL_FEATURE_FLAGS

describe('ALL_FEATURE_FLAGS', () => {
  it('should contain all 13 feature flags', () => {
    expect(ALL_FEATURE_FLAGS).toHaveLength(13);
    // `priority_support` was RETIRED: it marketed "faster response times" while
    // no support product existed to be faster. Replaced by one flag per
    // response-time rung, each sold per contact and included in no tier.
    expect(ALL_FEATURE_FLAGS).not.toContain('priority_support');
    expect(ALL_FEATURE_FLAGS).toContain('support_standard');
    expect(ALL_FEATURE_FLAGS).toContain('support_priority');
    expect(ALL_FEATURE_FLAGS).toContain('support_premium');
    expect(ALL_FEATURE_FLAGS).toContain('ai_generation');
    expect(ALL_FEATURE_FLAGS).toContain('bulk_operations');
    expect(ALL_FEATURE_FLAGS).toContain('custom_integrations');
    expect(ALL_FEATURE_FLAGS).toContain('sso');
    expect(ALL_FEATURE_FLAGS).toContain('advanced_reporting');
    expect(ALL_FEATURE_FLAGS).toContain('team_usage_analytics');
    expect(ALL_FEATURE_FLAGS).toContain('compliance_standard');
    expect(ALL_FEATURE_FLAGS).toContain('compliance_advanced');
    // Scheduled manager-facing reports. On-demand dashboards stay free under
    // `reports:read`; this gates saving, scheduling and publishing.
    expect(ALL_FEATURE_FLAGS).toContain('stakeholder_reports');
    expect(ALL_FEATURE_FLAGS).toContain('verified_publisher');
  });
});

describe('verified_publisher (plugin ecosystem, docs/plugin-publishing.md)', () => {
  it('is included from Team up (team, enterprise, unlimited) and nowhere below', () => {
    expect(TIER_FEATURES.developer).not.toContain('verified_publisher');
    expect(TIER_FEATURES.pro).not.toContain('verified_publisher');
    for (const tier of ['team', 'enterprise', 'unlimited'] as const) {
      expect(TIER_FEATURES[tier]).toContain('verified_publisher');
    }
    expect(FEATURE_METADATA.verified_publisher.label).toBeTruthy();
  });
});

// TIER_FEATURES

describe('TIER_FEATURES', () => {
  it('developer tier has no features', () => {
    expect(TIER_FEATURES.developer).toEqual([]);
  });

  it('pro tier has 2 features', () => {
    expect(TIER_FEATURES.pro).toHaveLength(2);
    expect(TIER_FEATURES.pro).toContain('ai_generation');
    expect(TIER_FEATURES.pro).toContain('bulk_operations');
  });

  it('pro tier does NOT include custom_integrations or sso', () => {
    expect(TIER_FEATURES.pro).not.toContain('custom_integrations');
    expect(TIER_FEATURES.pro).not.toContain('sso');
  });

  it('team tier includes sso but not custom_integrations', () => {
    expect(TIER_FEATURES.team).toContain('sso');
    expect(TIER_FEATURES.team).toContain('ai_generation');
    expect(TIER_FEATURES.team).not.toContain('custom_integrations');
  });

  it('advanced_reporting is Enterprise-only as a tier feature (add-on bundle elsewhere)', () => {
    expect(TIER_FEATURES.enterprise).toContain('advanced_reporting');
    expect(TIER_FEATURES.team).not.toContain('advanced_reporting');
    expect(TIER_FEATURES.pro).not.toContain('advanced_reporting');
    expect(TIER_FEATURES.developer).not.toContain('advanced_reporting');
  });

  it('team_usage_analytics is Enterprise-only as a tier feature (Pro/Team add-on bundle)', () => {
    expect(TIER_FEATURES.enterprise).toContain('team_usage_analytics');
    expect(TIER_FEATURES.team).not.toContain('team_usage_analytics');
    expect(TIER_FEATURES.pro).not.toContain('team_usage_analytics');
    expect(TIER_FEATURES.developer).not.toContain('team_usage_analytics');
  });

  it('enterprise tier has every feature except the add-on-only support levels', () => {
    const expected = ALL_FEATURE_FLAGS.filter((f) => !SUPPORT_FEATURE_FLAGS.includes(f));
    expect(TIER_FEATURES.enterprise).toEqual(expect.arrayContaining([...expected]));
    expect(TIER_FEATURES.enterprise).toHaveLength(expected.length);
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
    expect(isValidFeatureFlag('custom_integrations')).toBe(true);
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
    const features = resolveUserFeatures('developer', { accountFeatures: ['custom_integrations', 'not_a_flag'] });
    expect(features).toContain('custom_integrations'); // granted by an account bundle
    expect(features).not.toContain('not_a_flag'); // invalid flag ignored
  });

  it('a per-user override can still disable an account-entitled feature', () => {
    const features = resolveUserFeatures('developer', { overrides: { custom_integrations: false }, accountFeatures: ['custom_integrations'] });
    expect(features).not.toContain('custom_integrations');
  });

  it('developer tier gets no features by default', () => {
    const features = resolveUserFeatures('developer');
    expect(features).toEqual([]);
  });

  it('pro tier gets 2 features by default', () => {
    const features = resolveUserFeatures('pro');
    expect(features).toHaveLength(2);
    expect(features).toContain('ai_generation');
    expect(features).toContain('bulk_operations');
  });

  it('enterprise gets every feature EXCEPT support, which is an add-on at every tier', () => {
    // The guard that matters: `TIER_FEATURES.enterprise` is derived by FILTERING
    // `ALL_FEATURE_FLAGS`, not spreading it. A future flag added to the spread
    // would silently grant enterprise the support product it is meant to buy.
    const features = resolveUserFeatures('enterprise');
    expect(features).toEqual(ALL_FEATURE_FLAGS.filter((f) => !SUPPORT_FEATURE_FLAGS.includes(f)));
    for (const f of SUPPORT_FEATURE_FLAGS) expect(features).not.toContain(f);
    expect(features).toHaveLength(ALL_FEATURE_FLAGS.length - SUPPORT_FEATURE_FLAGS.length);
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
    const features = resolveUserFeatures('pro', { overrides: { custom_integrations: true } });
    expect(features).toContain('custom_integrations');
    expect(features).toHaveLength(3);
  });

  it('override false removes a feature from the tier', () => {
    const features = resolveUserFeatures('pro', { overrides: { ai_generation: false } });
    expect(features).not.toContain('ai_generation');
    expect(features).toHaveLength(1);
  });

  it('multiple overrides are applied correctly', () => {
    const features = resolveUserFeatures('pro', {
      overrides: {
        ai_generation: false,
        custom_integrations: true,
        sso: true,
      },
    });
    expect(features).not.toContain('ai_generation');
    expect(features).toContain('custom_integrations');
    expect(features).toContain('sso');
    expect(features).toHaveLength(3); // 2 - 1 + 2
  });

  it('invalid override keys are silently ignored', () => {
    const features = resolveUserFeatures('developer', { overrides: { not_a_flag: true } as Record<string, boolean> });
    expect(features).toEqual([]);
  });

  it('null overrides are treated as no overrides', () => {
    const features = resolveUserFeatures('pro', { overrides: null });
    expect(features).toHaveLength(2);
  });

  it('returns features in canonical order', () => {
    const features = resolveUserFeatures('developer', {
      overrides: {
        custom_integrations: true,
        ai_generation: true,
      },
    });
    expect(features.indexOf('ai_generation')).toBeLessThan(features.indexOf('custom_integrations'));
  });

  it('adding an already-included feature via override is a no-op', () => {
    const features = resolveUserFeatures('pro', { overrides: { ai_generation: true } });
    expect(features).toHaveLength(2); // unchanged
  });

  it('removing a feature not in the tier via override is a no-op', () => {
    const features = resolveUserFeatures('developer', { overrides: { custom_integrations: false } });
    expect(features).toEqual([]);
  });
});

describe('compliance content sets', () => {
  it('derives the entitled sets from a feature set, lowest first', () => {
    expect(complianceSetsForFeatures(['compliance_advanced', 'compliance_standard'])).toEqual(['standard', 'advanced']);
    expect(complianceSetsForFeatures(['sso'])).toEqual([]);
  });
  it('resolves the feature a rule\'s set tags require (highest wins)', () => {
    expect(complianceFeatureForTags(['set:standard'])).toBe('compliance_standard');
    expect(complianceFeatureForTags(['set:standard', 'set:advanced'])).toBe('compliance_advanced');
    expect(complianceFeatureForTags(['other'])).toBeNull();
    expect(complianceFeatureForTags(null)).toBeNull();
    expect(COMPLIANCE_CONTENT_SETS).toEqual(['standard', 'advanced']);
  });
});
