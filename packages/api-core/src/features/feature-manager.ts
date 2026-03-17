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
