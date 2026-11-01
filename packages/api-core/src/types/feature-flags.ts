// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QuotaTier } from './quota-tiers.js';

// Feature flag identifiers

/** Canonical feature flag identifiers. */
export type FeatureFlag =
  // `custom_integrations` is an ENTERPRISE-EXCLUSIVE marketing/entitlement flag:
  // granted only by the enterprise tier (no add-on bundle sells it to a lower
  // tier — intentional, it anchors the Enterprise plan) and not currently
  // `requireFeature`-gated on any route. This is by design, not dead code — do
  // not "fix" by wiring a bundle without a pricing decision. Contrast
  // `sso`/`advanced_reporting`, which ARE sold as add-on bundles and gated (see
  // billing-config `loadBundles` + `requireFeature`).
  | 'custom_integrations'
  // Support level, one per response-time rung. Sold ONLY as per-contact add-on
  // bundles (`support_standard` / `support_priority` / `support_premium`) and
  // included in NO tier — not even enterprise, which is why `TIER_FEATURES`
  // cannot simply spread `ALL_FEATURE_FLAGS` for it any more. These REPLACE the
  // former `priority_support` tier perk, which marketed "faster response times"
  // while no support product existed to be faster. Mutually exclusive: an
  // account holds at most one (enforced in `effectiveEntitlements`).
  | 'support_standard'
  | 'support_priority'
  | 'support_premium'
  | 'ai_generation'
  | 'bulk_operations'
  | 'sso'
  // DORA / advanced delivery analytics (paid tiers only).
  | 'advanced_reporting'
  // Per-team usage breakdown across the org→team subtree. INCLUDED in Enterprise;
  // sold as an add-on bundle to Pro/Team (see billing-config `team_usage_analytics`).
  | 'team_usage_analytics'
  // Curated compliance rule libraries sold as add-on bundles. `compliance_standard`
  // = CI/CD best-practice set; `compliance_advanced` = SOC2/PCI/CIS framework
  // libraries (requires Standard). These gate SUBSCRIBING to the set's system-org
  // published rules; INCLUDED in Enterprise/Unlimited (via ALL_FEATURE_FLAGS),
  // sold to Developer/Pro/Team (see billing-config `compliance_standard/advanced`).
  | 'compliance_standard'
  | 'compliance_advanced'
  // Scheduled, manager-facing reports: saved definitions, frozen snapshots,
  // review-and-publish, PDF/email delivery and share links. INCLUDED in
  // Enterprise/Unlimited; sold as an add-on bundle to Pro/Team (see
  // billing-config `stakeholder_reports`). On-demand dashboards stay FREE under
  // `reports:read` — this gates saving, scheduling and publishing, not looking.
  | 'stakeholder_reports'
  // Plugin ecosystem: the org's publisher is ELIGIBLE to apply for Verified
  // status (docs/plugin-publishing.md). Eligibility only — the badge
  // is awarded (and withdrawn) by system-org review, never bought. Team and up;
  // no add-on bundle sells it.
  | 'verified_publisher';

/** All valid feature flags (order determines display order). */
export const ALL_FEATURE_FLAGS: readonly FeatureFlag[] = [
  'ai_generation',
  'bulk_operations',
  'custom_integrations',
  'sso',
  'advanced_reporting',
  'team_usage_analytics',
  'compliance_standard',
  'compliance_advanced',
  'stakeholder_reports',
  'verified_publisher',
  'support_standard',
  'support_priority',
  'support_premium',
];

/**
 * The support-level flags, which are add-on-ONLY at every tier.
 *
 * Needed as its own list because `TIER_FEATURES.enterprise` spreads
 * `ALL_FEATURE_FLAGS`: without excluding these, adding a support flag would
 * silently grant enterprise the support product it is supposed to buy, which is
 * exactly the "included in no tier" decision it would break.
 */
export const SUPPORT_FEATURE_FLAGS: readonly FeatureFlag[] = [
  'support_standard',
  'support_priority',
  'support_premium',
];

/**
 * The FIRST-RESPONSE TARGET sold at each support level — the canonical wording.
 *
 * One place, because this string is a commitment: it is shown on the case, in
 * the add-on catalog, on the pricing page and in the alert that fires when the
 * desk misses it, and those four must never disagree. A level absent from this
 * map has no stated target and callers must omit the phrase rather than borrow
 * another level's promise.
 *
 * WHY THESE UNITS. An earlier ladder read "48 business hours / 24 business
 * hours / no stated number", which was wrong twice over. The business-hours
 * unit flattered the targets by roughly three times — 48 business hours is six
 * working days, so a case raised on a Friday evening had its target expire the
 * *following Monday* — and the top level, the one that costs the most, was the
 * only one with no number at all, so the ladder went blank on the single axis a
 * buyer compares. The targets below are stated in units the customer actually
 * experiences and improve monotonically on one clock: two business days, then
 * one, then eight hours on a clock that does not stop for nights or weekends.
 *
 * Premium's "any day" is the whole of its 24×7 coverage claim, and it is
 * deliberately NOT a severity-dependent one-hour promise. Eight hours is what a
 * rota can be held to: it leaves room for the per-case sweep to page two hours
 * ahead of the deadline (see docs/oncall-paging.md) and for a woken human to
 * read the case and answer it. An hour-scale commitment would spend that margin
 * before anyone picked up the phone.
 */
export const SUPPORT_RESPONSE_TARGETS: Readonly<Record<string, string>> = {
  support_standard: '2 business days',
  support_priority: 'next business day',
  support_premium: '8 hours, any day',
};

/**
 * Support levels whose contacts may declare `urgent` severity when opening.
 *
 * Premium only, and this is a PRICING decision rather than a permission detail.
 * The tenant chooses severity at open and severity decides which target applies,
 * so a level that can declare `urgent` is a level that can help itself to the
 * fastest response on offer. Admitting it only at premium is what makes the top
 * rung a capability — "you can declare an emergency" — instead of nothing but a
 * faster clock, which is the whole reason the priority-to-premium step is worth
 * its price.
 *
 * Staff re-ranking (`support.case.severity`, system-admin only) stays the escape
 * hatch: a genuine emergency raised on a lower level is OURS to promote, which
 * is the same governance split that keeps the tenant from re-ranking after open.
 */
export const URGENT_SEVERITY_LEVELS: readonly FeatureFlag[] = ['support_premium'];

/**
 * The severity a case may actually be opened at.
 *
 * Returns the requested severity unchanged, or the highest one the level admits.
 * `urgent` asked for below premium becomes `high` — a DOWNGRADE, never a
 * refusal: declining to send a support message because the sender over-stated
 * its severity would deny support over a label, and the message itself is never
 * the thing being gated. The caller tells the sender it happened.
 *
 * A null `level` means no case is being opened (no entitlement, or the
 * entitlement read was unavailable), and then there is no commitment to protect,
 * so the requested value passes through untouched rather than being demoted for
 * no reason during an outage of ours.
 */
export function admitCaseSeverity(
  requested: string,
  level: string | null,
): { severity: string; downgraded: boolean } {
  if (requested !== 'urgent' || level === null) return { severity: requested, downgraded: false };
  if ((URGENT_SEVERITY_LEVELS as readonly string[]).includes(level)) {
    return { severity: requested, downgraded: false };
  }
  return { severity: 'high', downgraded: true };
}

/** Check whether a string is a valid FeatureFlag. */
export function isValidFeatureFlag(value: string): value is FeatureFlag {
  return (ALL_FEATURE_FLAGS as readonly string[]).includes(value);
}

// Tier-to-feature mapping

/** Features enabled by default for each tier. */
export const TIER_FEATURES: Record<QuotaTier, readonly FeatureFlag[]> = {
  developer: [],
  pro: ['ai_generation', 'bulk_operations'],
  // Team adds sso (SSO/IdP is INCLUDED in Team, not an add-on). advanced_reporting
  // (DORA) is NOT a Team tier feature — it's INCLUDED only in Enterprise and sold
  // as an add-on bundle to every other tier (see billing-config
  // `advanced_reporting`). Enterprise unlocks all.
  // `verified_publisher` (eligibility to apply for Verified) starts at Team.
  team: ['ai_generation', 'bulk_operations', 'sso', 'verified_publisher'],
  // Business is Team plus advanced_reporting (DORA): the analytics surface is
  // what a 8-seat org is usually buying, and bundling it is most of why the tier
  // is worth $249 over Team + the add-on. Enterprise keeps custom_integrations,
  // team_usage_analytics, the compliance libraries and stakeholder_reports as
  // its own differentiators.
  business: ['ai_generation', 'bulk_operations', 'sso', 'verified_publisher', 'advanced_reporting'],
  // Enterprise is an EXPLICIT list, deliberately not `[...ALL_FEATURE_FLAGS]`.
  //
  // Spreading every flag here is how a new paid add-on silently becomes an
  // Enterprise inclusion: adding `support_premium` to the catalog would have
  // granted enterprise the 24×7 support it is supposed to BUY, with nothing
  // failing. Listing the flags forces the question "does Enterprise include
  // this?" to be answered per flag, which is the decision this record exists to
  // carry. A filter expression would do the same job but cannot be read by the
  // source-parsing parity tests (`frontend/test/feature-gate-upsell.test.ts`
  // extracts an array literal), so an explicit list it is.
  //
  // Support is absent on purpose: it is an add-on at EVERY tier, included in none.
  enterprise: [
    'ai_generation',
    'bulk_operations',
    'custom_integrations',
    'sso',
    'advanced_reporting',
    'team_usage_analytics',
    'compliance_standard',
    'compliance_advanced',
    'stakeholder_reports',
    'verified_publisher',
  ],
  // Unlimited includes every feature / add-on bundle (billing-disabled default).
  // Support included here on purpose: `unlimited` is the billing-OFF tier, where
  // nothing is purchasable, and its `supportContacts` limit is -1 to match.
  unlimited: [...ALL_FEATURE_FLAGS],
};

// Feature metadata (for display)

/** Human-readable metadata for each feature flag. */
export const FEATURE_METADATA: Record<FeatureFlag, { label: string; description: string }> = {
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
  sso: {
    label: 'SSO / IdP',
    description: 'Single sign-on and external identity-provider configurations',
  },
  advanced_reporting: {
    label: 'Advanced Reporting',
    description: 'DORA / advanced delivery analytics',
  },
  team_usage_analytics: {
    label: 'Team Usage Analytics',
    description: 'Per-team usage breakdown across the org → team subtree',
  },
  compliance_standard: {
    label: 'Standard Compliance',
    description: 'Curated CI/CD best-practice compliance rule library',
  },
  compliance_advanced: {
    label: 'Advanced Compliance',
    description: 'Curated framework compliance libraries (SOC2 / PCI-DSS / CIS)',
  },
  stakeholder_reports: {
    label: 'Stakeholder Reports',
    description: 'Scheduled team reports for managers — snapshots, review and publish, PDF/email delivery and share links',
  },
  support_standard: {
    label: 'Standard Support',
    description: `Support cases with a first response within ${SUPPORT_RESPONSE_TARGETS.support_standard}, business hours`,
  },
  support_priority: {
    label: 'Priority Support',
    description: `Support cases with a first response by the ${SUPPORT_RESPONSE_TARGETS.support_priority}, business hours`,
  },
  support_premium: {
    label: 'Premium Support',
    description: `24×7 support cases — first response within ${SUPPORT_RESPONSE_TARGETS.support_premium} of the week, and the only level that may declare urgent severity`,
  },
  verified_publisher: {
    label: 'Verified Publisher Eligibility',
    description: 'Apply for the Verified badge on your plugin-ecosystem publisher (awarded by system-org review)',
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

  // Account-level entitlements (purchased feature bundles — e.g. audit_log, sso,
  // advanced_reporting, team_usage_analytics, compliance_standard/advanced).
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
 * Curated compliance content sets and the feature flag each one is sold under.
 * A set `x` is the published rules tagged `set:<x>`; an org holding the flag is
 * entitled to them. Ordered from the lowest entitlement to the highest.
 */
export const COMPLIANCE_SET_FEATURES = {
  standard: 'compliance_standard',
  advanced: 'compliance_advanced',
} as const satisfies Record<string, FeatureFlag>;

export type ComplianceContentSet = keyof typeof COMPLIANCE_SET_FEATURES;

/** Every curated set name, lowest entitlement first. */
export const COMPLIANCE_CONTENT_SETS = Object.keys(COMPLIANCE_SET_FEATURES) as ComplianceContentSet[];

/** The curated sets an effective feature set entitles (stable order). */
export function complianceSetsForFeatures(features: readonly string[]): ComplianceContentSet[] {
  return COMPLIANCE_CONTENT_SETS.filter((set) => features.includes(COMPLIANCE_SET_FEATURES[set]));
}

/**
 * The feature a published rule's `set:<x>` tags require, or `null` for an
 * untagged (baseline) rule. The highest entitlement wins when a rule carries
 * several. Accepts a raw jsonb `tags` value.
 */
export function complianceFeatureForTags(tags: unknown): FeatureFlag | null {
  const t = Array.isArray(tags) ? tags : [];
  for (const set of [...COMPLIANCE_CONTENT_SETS].reverse()) {
    if (t.includes(`set:${set}`)) return COMPLIANCE_SET_FEATURES[set];
  }
  return null;
}
