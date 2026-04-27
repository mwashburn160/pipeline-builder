// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Available quota tier identifiers. */
export type QuotaTier = 'developer' | 'pro' | 'unlimited';

/** Limit values for each quota type within a tier. */
export interface QuotaTierLimits {
  plugins: number;
  pipelines: number;
  apiCalls: number;
  aiCalls: number;
}

/** Full preset for a single tier (label + limits). */
export interface QuotaTierPreset {
  label: string;
  limits: QuotaTierLimits;
}

/**
 * Preset limits for each tier. -1 means unlimited.
 *
 * AI calls are sized much smaller than `apiCalls` because each call has
 * external provider cost (~$0.01–$0.10/call). Developer tier allows light
 * exploration (100/period); Pro lifts to 5000; Unlimited is uncapped.
 */
export const QUOTA_TIERS: Record<QuotaTier, QuotaTierPreset> = {
  developer: { label: 'Developer', limits: { plugins: 100, pipelines: 10, apiCalls: -1, aiCalls: 100 } },
  pro: { label: 'Pro', limits: { plugins: 1000, pipelines: 100, apiCalls: -1, aiCalls: 5000 } },
  unlimited: { label: 'Unlimited', limits: { plugins: -1, pipelines: -1, apiCalls: -1, aiCalls: -1 } },
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
