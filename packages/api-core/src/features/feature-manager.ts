/**
 * @module features/feature-manager
 * @description Unified feature management that merges service-level toggles
 * (billing, email, OAuth) with per-user feature flags into a single API.
 */

import { resolveUserFeatures, ALL_FEATURE_FLAGS, type FeatureFlag } from '../types/feature-flags';
import type { QuotaTier } from '../types/quota-tiers';

/** Service-level features controlled by environment variables. */
export type ServiceFeature = 'billing' | 'email' | 'oauth';

/** All service feature identifiers. */
export const ALL_SERVICE_FEATURES: readonly ServiceFeature[] = ['billing', 'email', 'oauth'];

/** Union of service features and per-user feature flags. */
export type Feature = ServiceFeature | FeatureFlag;

/** Context needed to resolve a user's complete feature set. */
export interface FeatureContext {
  /** Organization's quota tier. */
  tier: QuotaTier;
  /** Whether the user belongs to the system organization. */
  isSystemOrg: boolean;
  /** Per-user feature flag overrides (from user record). */
  userOverrides?: Record<string, boolean> | null;
  /** Service-level feature toggles (from platform config). */
  serviceFlags: Record<ServiceFeature, boolean>;
}

/**
 * Resolves and provides a unified view of all enabled features.
 *
 * Merges service-level toggles (billing, email, OAuth) with per-user
 * feature flags (ai_generation, bulk_operations, etc.) into one set.
 *
 * System org users get all per-user features but billing is excluded
 * (system org manages billing for others, not itself).
 */
export class FeatureManager {
  private readonly features: ReadonlySet<Feature>;

  constructor(context: FeatureContext) {
    const enabled = new Set<Feature>();

    // Service-level features
    for (const key of ALL_SERVICE_FEATURES) {
      if (context.serviceFlags[key]) {
        enabled.add(key);
      }
    }

    // System org: exclude billing (they manage billing for others)
    if (context.isSystemOrg) {
      enabled.delete('billing');
    }

    // Per-user features (system org gets all via resolveUserFeatures)
    for (const flag of resolveUserFeatures(context.tier, context.userOverrides, context.isSystemOrg)) {
      enabled.add(flag);
    }

    this.features = enabled;
  }

  /** Check if a specific feature is enabled. */
  isEnabled(feature: Feature): boolean {
    return this.features.has(feature);
  }

  /** Get all enabled features as an array. */
  getEnabled(): Feature[] {
    return [...this.features];
  }

  /** Get a map of all features with their enabled/disabled state. */
  toMap(): Record<string, boolean> {
    const map: Record<string, boolean> = {};
    for (const f of ALL_SERVICE_FEATURES) {
      map[f] = this.features.has(f);
    }
    for (const f of ALL_FEATURE_FLAGS) {
      map[f] = this.features.has(f);
    }
    return map;
  }
}
