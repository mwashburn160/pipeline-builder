// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where each feature entitlement is ENFORCED, and where the UI renders that fact.
 *
 * The catalog in `feature-flags.ts` says which flags exist. This file says what
 * each one actually does to a request, which is the only thing that justifies a
 * UI gate: gating a control the API does not gate hides capability a customer
 * already paid for, and NOT gating one the API does gate turns a click into a
 * bare 403. Both were happening — hence the registry and the parity test
 * (`frontend/test/route-permissions.test.tsx`) that checks it against the
 * generated route tables in `src/generated/route-table/`.
 *
 * `enforcement`:
 *  - `route`   — a `requireFeature(flag)` middleware sits on one or more routes,
 *                so the tables carry the flag in `features`. Every such flag MUST
 *                have a UI gate, and the test fails naming the route if a newly
 *                gated route has no control mapped to it.
 *  - `handler` — enforced INSIDE a handler (conditionally), so it never reaches
 *                the route table. Still a real 403; still needs a UI gate.
 *  - `entitlement-only` — sold/derived but enforced nowhere in the API. There is
 *                deliberately NO UI gate: a client-side lock on an unenforced
 *                entitlement would take away something the org can genuinely use
 *                and would be pure theatre. The test asserts these appear in no
 *                route's `features`, so the day a backend gate lands, this file
 *                and the UI have to be updated rather than silently 403-ing.
 */
import type { FeatureFlag } from './feature-flags';

export type FeatureEnforcement = 'route' | 'handler' | 'entitlement-only';

/**
 * How an org ACQUIRES the entitlement — which decides where a lock's CTA points.
 *
 *  - `bundle` — sold as an add-on in the billing catalog. `/dashboard/billing`
 *               consumes `?highlight=<flag>` and scrolls to the matching card,
 *               so the deep link lands on the thing the viewer must buy.
 *  - `tier`   — included from some plan upward and NOT purchasable separately.
 *               `?highlight=` would name a bundle that does not exist: AddonGrid
 *               finds no match, highlights nothing, and the viewer is dropped on
 *               an add-on grid that never mentions the feature they clicked. The
 *               lock therefore opens the **Plans** tab instead, and says which
 *               plan the feature starts at — the same destination AddonGrid's
 *               own `prerequisiteLink` uses when nothing on sale provides a
 *               prerequisite.
 */
export type FeatureAcquisition = 'bundle' | 'tier';

export interface FeatureGateSpec {
  enforcement: FeatureEnforcement;
  /** Whether the entitlement is bought à la carte or comes with a plan. */
  acquiredVia: FeatureAcquisition;
  /**
   * For `acquiredVia: 'tier'`, the customer-facing name of the LOWEST plan that
   * includes the flag ("Team"). Rendered verbatim in the lock, so it must match
   * api-core's `TIER_FEATURES` — `frontend/test/feature-gate-upsell.test.ts`
   * reads that file and fails if it drifts.
   */
  includedFrom?: string;
  /**
   * Source files that render the gate for this flag (relative to `frontend/`).
   * Empty for `entitlement-only`. The parity test reads each one and requires it
   * to mention the flag, so deleting a gate fails here rather than in production.
   */
  controls: string[];
  /** One clause naming what the entitlement buys, used in the lock copy. */
  unlocks: string;
  /** Why this flag is classified the way it is (kept short, kept honest). */
  note?: string;
}

export const FEATURE_GATES: Record<FeatureFlag, FeatureGateSpec> = {
  ai_generation: {
    enforcement: 'route',
    acquiredVia: 'tier',
    includedFrom: 'Pro',
    controls: [
      'src/components/pipeline/CreatePipelineModal.tsx',
      'src/components/plugin/CreatePluginModal.tsx',
      'src/components/ui/DashboardLayout.tsx',
    ],
    unlocks: 'generating pipelines and plugins from a prompt or a Git URL, and the Ask assistant',
  },
  bulk_operations: {
    enforcement: 'route',
    acquiredVia: 'tier',
    includedFrom: 'Pro',
    controls: ['pages/dashboard/pipelines.tsx', 'pages/dashboard/plugins.tsx'],
    unlocks: 'selecting many pipelines or plugins and updating or deleting them in one call',
  },
  advanced_reporting: {
    enforcement: 'route',
    acquiredVia: 'bundle',
    controls: [
      'src/components/reports/tabs/DoraTab.tsx',
      'src/components/reports/tabs/ScorecardTab.tsx',
      'src/components/pipeline/ScorecardCard.tsx',
      'pages/dashboard/settings/incident-reporting.tsx',
    ],
    unlocks: 'DORA metrics, the maturity scorecard, and incident-driven MTTR/change-failure reporting',
  },
  team_usage_analytics: {
    enforcement: 'route',
    acquiredVia: 'bundle',
    controls: ['src/components/billing/TeamUsageCard.tsx'],
    unlocks: 'the per-team usage breakdown across your organization’s teams',
  },
  compliance_standard: {
    enforcement: 'handler',
    acquiredVia: 'bundle',
    controls: ['src/components/compliance/ComplianceContentSets.tsx', 'src/components/compliance/SubscriptionManager.tsx'],
    unlocks: 'subscribing to the curated CI/CD best-practice compliance library',
    note: 'The compliance service derives the required flag from a published rule’s `set:` tag at request time (subscribe / activate / clone / preview), so it never appears in the route table.',
  },
  compliance_advanced: {
    enforcement: 'handler',
    acquiredVia: 'bundle',
    controls: ['src/components/compliance/ComplianceContentSets.tsx', 'src/components/compliance/SubscriptionManager.tsx'],
    unlocks: 'subscribing to the curated SOC 2 / PCI-DSS / CIS compliance libraries',
    note: 'Same `set:`-tag gate as compliance_standard, and requires it.',
  },
  sso: {
    enforcement: 'handler',
    // TIER-ONLY, and the only gated flag that is: there is no SSO add-on to
    // deep-link to. The bundle was withdrawn because it was both dominated
    // (Pro + $40 = the Team price, and Team includes SSO anyway) and broken
    // below Team — SSO needs a DNS-verified domain and domain registration is
    // itself a Team+ tier check, so a Pro buyer's non-Google IdP failed at
    // callback. See docs/billing-bundles.md.
    acquiredVia: 'tier',
    includedFrom: 'Team',
    controls: ['src/lib/nav.ts', 'pages/dashboard/settings/sso.tsx'],
    unlocks: 'single sign-on and external identity-provider configuration',
    note: 'Platform’s `requireOwnOrgSso` re-checks the entitlement inside every org-facing IdP/SCIM handler (403 SSO_NOT_ENTITLED), so it never reaches the route table. The nav item carries `requiredFeature: sso`, which renders it LOCKED (not hidden — an org off the tier still has to learn SSO exists), and the page it opens renders the upsell — which points at Plans, not at an add-on, because SSO is not sold separately.',
  },
  priority_support: {
    enforcement: 'entitlement-only',
    acquiredVia: 'tier',
    includedFrom: 'Pro',
    controls: [],
    unlocks: 'faster response times and dedicated support channels',
    note: 'A support-process entitlement. No API route checks it, so no control is locked.',
  },
  verified_publisher: {
    enforcement: 'entitlement-only',
    acquiredVia: 'tier',
    includedFrom: 'Team',
    controls: [],
    unlocks: 'applying for the Verified badge on your plugin-ecosystem publisher',
    note: 'Eligibility only, and not yet checked by any route: the ecosystem publisher routes will gate the Verified application on it. Reclassify to `handler`/`route` and add the control when they land.',
  },
  custom_integrations: {
    enforcement: 'entitlement-only',
    acquiredVia: 'tier',
    includedFrom: 'Enterprise',
    controls: [],
    unlocks: 'connecting external services and custom webhook endpoints',
    note: 'No API route checks it today; alert destinations and webhooks are permission-gated, not entitlement-gated. Locking them client-side would remove working capability.',
  },
};

/**
 * Deep link to the place a viewer can actually acquire the entitlement, which
 * depends on {@link FeatureGateSpec.acquiredVia}: the add-on card for a bundle
 * feature (`?highlight=` scrolls to it), the Plans tab for a tier feature. The
 * distinction matters — highlighting an add-on that doesn't exist silently
 * degrades to "here is the add-on grid, good luck".
 *
 * Only offer it to a viewer who can OPEN that page — see {@link featureUpsellAdvice}.
 */
export function featureUpsellHref(flag: FeatureFlag): string {
  return FEATURE_GATES[flag].acquiredVia === 'tier'
    ? '/dashboard/billing?tab=plans'
    : `/dashboard/billing?highlight=${flag}`;
}

/** Link text for the upsell CTA, matching where {@link featureUpsellHref} goes. */
export function featureUpsellCta(flag: FeatureFlag): string {
  return FEATURE_GATES[flag].acquiredVia === 'tier' ? 'Compare plans' : 'See it in Billing';
}

/**
 * The clause that FOLLOWS the CTA link. A tier feature is acquired by changing
 * plan, so "add it to your plan" would be a lie — there is nothing to add. Which
 * plan it starts at is said BEFORE the link instead (see {@link FeatureLock}), so
 * that a viewer who can't open billing still learns it; the trailer just ends the
 * sentence rather than repeating it.
 */
export function featureUpsellTrailer(flag: FeatureFlag): string {
  return FEATURE_GATES[flag].acquiredVia === 'tier' ? '.' : ' to add it to your plan.';
}

/**
 * What a lock says instead of the billing deep link when the viewer can't use
 * it: `/dashboard/billing` needs `billing:read` (a developer doesn't hold it)
 * and disappears entirely when the deployment runs with billing off. Sending
 * them there anyway swaps the upsell for a full-screen AccessDenied — a worse
 * dead end than the lock they just clicked.
 */
export const FEATURE_UPSELL_ADVICE = 'Ask an organization owner or admin to add it to your plan.';

/** The same advice for a TIER feature, where there is nothing to "add". */
export const FEATURE_UPGRADE_ADVICE = 'Ask an organization owner or admin about upgrading the plan.';

/** Whichever of the two advice lines fits how this flag is acquired. */
export function featureUpsellAdvice(flag: FeatureFlag): string {
  return FEATURE_GATES[flag].acquiredVia === 'tier' ? FEATURE_UPGRADE_ADVICE : FEATURE_UPSELL_ADVICE;
}
