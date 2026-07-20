// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QuotaTier } from './quota-tiers.js';

// Feature flag identifiers

/** Canonical feature flag identifiers. */
export type FeatureFlag =
  | 'priority_support'
  | 'custom_integrations'
  | 'ai_generation'
  | 'bulk_operations'
  | 'audit_log'
  | 'sso';

/** All valid feature flags (order determines display order). */
export const ALL_FEATURE_FLAGS: readonly FeatureFlag[] = [
  'priority_support',
  'ai_generation',
  'bulk_operations',
  'custom_integrations',
  'audit_log',
  'sso',
];

/** Check whether a string is a valid FeatureFlag. */
export function isValidFeatureFlag(value: string): value is FeatureFlag {
  return (ALL_FEATURE_FLAGS as readonly string[]).includes(value);
}

// Tier-to-feature mapping

/** Features enabled by default for each tier. */
export const TIER_FEATURES: Record<QuotaTier, readonly FeatureFlag[]> = {
  developer: [],
  pro: ['priority_support', 'ai_generation', 'bulk_operations'],
  // Team adds audit_log (collaboration/governance) and sso (SSO/IdP is INCLUDED
  // in Team, not an add-on); Enterprise unlocks all, incl. custom_integrations.
  team: ['priority_support', 'ai_generation', 'bulk_operations', 'audit_log', 'sso'],
  enterprise: [...ALL_FEATURE_FLAGS],
};

// Feature metadata (for display)

/** Human-readable metadata for each feature flag. */
export const FEATURE_METADATA: Record<FeatureFlag, { label: string; description: string }> = {
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
  sso: {
    label: 'SSO / IdP',
    description: 'Single sign-on and external identity-provider configurations',
  },
};

// Resolution logic

/**
 * Resolve a user's effective feature set.
 *
 * 1. Sysadmins (isSuperAdmin) always get ALL features.
 * 2. Start with the tier's default features.
 * 3. Apply per-user overrides: `true` adds a feature, `false` removes it.
 * 4. Invalid override keys are silently ignored.
 *
 * @param tier - The organization's quota tier
 * @param opts - Resolution options:
 *   - `overrides`: per-user overrides (key = feature flag, value = enabled)
 *   - `isSuperAdmin`: whether the user has the global super-admin flag
 *   - `accountFeatures`: account-level entitlements (e.g. purchased add-on
 *     bundles). A NAMED field so it can never be silently dropped by a caller
 *     that omits a trailing positional arg.
 * @returns Sorted array of enabled feature flags
 */
export function resolveUserFeatures(
  tier: QuotaTier,
  opts?: {
    overrides?: Record<string, boolean> | null;
    isSuperAdmin?: boolean;
    accountFeatures?: readonly string[] | null;
  },
): FeatureFlag[] {
  const { overrides: featureOverrides, isSuperAdmin, accountFeatures } = opts ?? {};

  // Sysadmins get everything regardless of tier.
  if (isSuperAdmin) return [...ALL_FEATURE_FLAGS];

  // Start with tier defaults
  const features = new Set<FeatureFlag>(TIER_FEATURES[tier] ?? []);

  // Account-level entitlements (purchased feature bundles — audit_log/sso).
  // Applied before per-user overrides so an explicit user override still wins.
  if (accountFeatures) {
    for (const key of accountFeatures) {
      if (isValidFeatureFlag(key)) features.add(key);
    }
  }

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
 * Check if a specific feature is enabled for a user. Delegates to
 * {@link resolveUserFeatures} so it stays in lockstep — including account-level
 * entitlements purchased via add-on bundles (`accountFeatures`).
 *
 * @param tier - The organization's quota tier
 * @param feature - The feature flag to check
 * @param featureOverrides - Per-user overrides
 * @param isSuperAdmin - Whether the user has the global super-admin flag
 * @param accountFeatures - Account-level entitlements (e.g. bundle-granted)
 * @returns true if the feature is enabled
 */
export function hasFeature(
  tier: QuotaTier,
  feature: FeatureFlag,
  featureOverrides?: Record<string, boolean> | null,
  isSuperAdmin?: boolean,
  accountFeatures?: readonly string[] | null,
): boolean {
  return resolveUserFeatures(tier, { overrides: featureOverrides, isSuperAdmin, accountFeatures }).includes(feature);
}
