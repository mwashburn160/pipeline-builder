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
  /**
   * Aggregate registry storage cap in BYTES. Counted across every repo
   * under the org's `org-{orgId}/` namespace. -1 means unlimited.
   * push-gate reads this; the image-registry rejects token issuance for
   * `push` scope when the org's measured usage exceeds the limit.
   */
  storageBytes: number;
  /** Count-quotas on the user-editable feature tables added to close per-org
   *  DoS via spam. -1 means unlimited. */
  dashboards: number;
  alertRules: number;
  alertDestinations: number;
  idpConfigs: number;
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
 * external provider cost (~$0.01$0.10/call). Developer tier allows light
 * exploration (100/period); Pro lifts to 5000; Unlimited is uncapped.
 *
 * `storageBytes` is the aggregate registry cap per org. Sized
 * around plugin-image realities: a typical plugin image is 200500 MB;
 * Developer's 5 GB holds ~10 versions × ~500 MB, Pro's 100 GB covers a
 * mature catalog. Operators can override per-org via the quota CRUD API.
 */
const GB = 1024 * 1024 * 1024;
export const QUOTA_TIERS: Record<QuotaTier, QuotaTierPreset> = {
  developer: {
    label: 'Developer',
    limits: {
      plugins: 100,
      pipelines: 10,
      apiCalls: -1,
      aiCalls: 100,
      storageBytes: 5 * GB,
      // Counts sized to "comfortably enough for one team, not a script spam":
      // 20 dashboards covers ops + per-service drill-downs, 50 alert rules
      // covers per-service alerts, 10 destinations covers Slack channels
      // per team + a webhook fallback, 1 IdP config (you only have one).
      dashboards: 20,
      alertRules: 50,
      alertDestinations: 10,
      idpConfigs: 1,
    },
  },
  pro: {
    label: 'Pro',
    limits: {
      plugins: 1000,
      pipelines: 100,
      apiCalls: -1,
      aiCalls: 5000,
      storageBytes: 100 * GB,
      dashboards: 200,
      alertRules: 500,
      alertDestinations: 50,
      idpConfigs: 5,
    },
  },
  unlimited: {
    label: 'Unlimited',
    limits: {
      plugins: -1,
      pipelines: -1,
      apiCalls: -1,
      aiCalls: -1,
      storageBytes: -1,
      dashboards: -1,
      alertRules: -1,
      alertDestinations: -1,
      idpConfigs: -1,
    },
  },
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
  return isValidTier(tier) ? QUOTA_TIERS[tier].limits: QUOTA_TIERS.developer.limits;
}
