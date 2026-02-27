/**
 * @module types/feature-flags
 * @description Per-user feature flag definitions and resolution logic.
 *
 * This is the single source of truth for feature flag identifiers,
 * tier-to-feature mapping, and the algorithm that resolves a user's
 * effective feature set from their org tier plus any per-user overrides.
 */

import type { QuotaTier } from './quota-tiers';

// ---------------------------------------------------------------------------
// Feature flag identifiers
// ---------------------------------------------------------------------------

/** Canonical feature flag identifiers. */
export type FeatureFlag =
  | 'advanced_analytics'
  | 'priority_support'
  | 'custom_integrations'
  | 'ai_generation'
  | 'bulk_operations'
  | 'audit_log';

/** All valid feature flags (order determines display order). */
export const ALL_FEATURE_FLAGS: readonly FeatureFlag[] = [
  'advanced_analytics',
  'priority_support',
  'ai_generation',
  'bulk_operations',
  'custom_integrations',
  'audit_log',
];

/** Check whether a string is a valid FeatureFlag. */
export function isValidFeatureFlag(value: string): value is FeatureFlag {
  return (ALL_FEATURE_FLAGS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Tier-to-feature mapping
// ---------------------------------------------------------------------------

/** Features enabled by default for each tier. */
export const TIER_FEATURES: Record<QuotaTier, readonly FeatureFlag[]> = {
  developer: [],
  pro: ['advanced_analytics', 'priority_support', 'ai_generation', 'bulk_operations'],
  unlimited: [...ALL_FEATURE_FLAGS],
};

// ---------------------------------------------------------------------------
// Feature metadata (for display)
// ---------------------------------------------------------------------------

/** Human-readable metadata for each feature flag. */
export const FEATURE_METADATA: Record<FeatureFlag, { label: string; description: string }> = {
  advanced_analytics: {
    label: 'Advanced Analytics',
    description: 'Detailed usage analytics, trends, and reporting dashboards',
  },
  priority_support: {
    label: 'Priority Support',
    description: 'Faster response times and dedicated support channels',
  },
  ai_generation: {
    label: 'AI Generation',
    description: 'AI-powered pipeline and plugin generation',
  },
  bulk_operations: {
    label: 'Bulk Operations',
    description: 'Batch create, update, and delete for pipelines and plugins',
  },
  custom_integrations: {
    label: 'Custom Integrations',
    description: 'Connect to external services and custom webhook endpoints',
  },
  audit_log: {
    label: 'Audit Log',
    description: 'Detailed audit trail of all user and system actions',
  },
};

// ---------------------------------------------------------------------------
// Resolution logic
// ---------------------------------------------------------------------------

/**
 * Resolve a user's effective feature set.
 *
 * 1. System org users always get ALL features.
 * 2. Start with the tier's default features.
 * 3. Apply per-user overrides: `true` adds a feature, `false` removes it.
 * 4. Invalid override keys are silently ignored.
 *
 * @param tier - The organization's quota tier
 * @param featureOverrides - Per-user overrides (key = feature flag, value = enabled)
 * @param isSystemOrg - Whether the user belongs to the system organization
 * @returns Sorted array of enabled feature flags
 */
export function resolveUserFeatures(
  tier: QuotaTier,
  featureOverrides?: Record<string, boolean> | null,
  isSystemOrg?: boolean,
): FeatureFlag[] {
  // System org always gets everything
  if (isSystemOrg) return [...ALL_FEATURE_FLAGS];

  // Start with tier defaults
  const features = new Set<FeatureFlag>(TIER_FEATURES[tier] ?? []);

  // Apply per-user overrides
  if (featureOverrides) {
    for (const [key, enabled] of Object.entries(featureOverrides)) {
      if (!isValidFeatureFlag(key)) continue;
      if (enabled) {
        features.add(key);
      } else {
        features.delete(key);
      }
    }
  }

  // Return in canonical order
  return ALL_FEATURE_FLAGS.filter(f => features.has(f));
}

/**
 * Check if a specific feature is enabled for a user.
 *
 * @param tier - The organization's quota tier
 * @param feature - The feature flag to check
 * @param featureOverrides - Per-user overrides
 * @param isSystemOrg - Whether the user belongs to the system organization
 * @returns true if the feature is enabled
 */
export function hasFeature(
  tier: QuotaTier,
  feature: FeatureFlag,
  featureOverrides?: Record<string, boolean> | null,
  isSystemOrg?: boolean,
): boolean {
  if (isSystemOrg) return true;

  // Check override first
  if (featureOverrides && feature in featureOverrides) {
    return featureOverrides[feature];
  }

  // Fall back to tier default
  return (TIER_FEATURES[tier] ?? []).includes(feature);
}
