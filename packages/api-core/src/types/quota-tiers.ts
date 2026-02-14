/**
 * @module types/quota-tiers
 * @description Canonical quota tier definitions.
 *
 * This is the single source of truth for tier names, labels, and default limits.
 * All services (quota, platform, frontend) should derive their tier data from here.
 */

/** Available quota tier identifiers. */
export type QuotaTier = 'developer' | 'pro' | 'unlimited';

/** Limit values for each quota type within a tier. */
export interface QuotaTierLimits {
  plugins: number;
  pipelines: number;
  apiCalls: number;
}

/** Full preset for a single tier (label + limits). */
export interface QuotaTierPreset {
  label: string;
  limits: QuotaTierLimits;
}

/** Preset limits for each tier. */
export const QUOTA_TIERS: Record<QuotaTier, QuotaTierPreset> = {
  developer: { label: 'Developer', limits: { plugins: 100, pipelines: 10, apiCalls: -1 } },
  pro: { label: 'Pro', limits: { plugins: 1000, pipelines: 100, apiCalls: -1 } },
  unlimited: { label: 'Unlimited', limits: { plugins: -1, pipelines: -1, apiCalls: -1 } },
};

/** All valid tier names. */
export const VALID_TIERS: readonly QuotaTier[] = Object.keys(QUOTA_TIERS) as QuotaTier[];

/** Default tier assigned to new organizations. */
export const DEFAULT_TIER: QuotaTier = 'developer';

/** Check whether a string is a valid QuotaTier. */
export function isValidTier(value: string): value is QuotaTier {
  return value in QUOTA_TIERS;
}

/** Get the default limits for a given tier (falls back to developer). */
export function getTierLimits(tier: string): QuotaTierLimits {
  return isValidTier(tier) ? QUOTA_TIERS[tier].limits : QUOTA_TIERS.developer.limits;
}
