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
 * (`frontend/test/route-permissions.test.ts`) that checks it against the
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

export interface FeatureGateSpec {
  enforcement: FeatureEnforcement;
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
    controls: [
      'src/components/pipeline/CreatePipelineModal.tsx',
      'src/components/plugin/CreatePluginModal.tsx',
      'src/components/ui/DashboardLayout.tsx',
    ],
    unlocks: 'generating pipelines and plugins from a prompt or a Git URL, and the Ask assistant',
  },
  bulk_operations: {
    enforcement: 'route',
    controls: ['pages/dashboard/pipelines.tsx', 'pages/dashboard/plugins.tsx'],
    unlocks: 'selecting many pipelines or plugins and updating or deleting them in one call',
  },
  advanced_reporting: {
    enforcement: 'route',
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
    controls: ['src/components/billing/TeamUsageCard.tsx'],
    unlocks: 'the per-team usage breakdown across your organization’s teams',
  },
  compliance_standard: {
    enforcement: 'handler',
    controls: ['src/components/compliance/ComplianceContentSets.tsx', 'src/components/compliance/SubscriptionManager.tsx'],
    unlocks: 'subscribing to the curated CI/CD best-practice compliance library',
    note: 'The compliance service derives the required flag from a published rule’s `set:` tag at request time (subscribe / activate / clone / preview), so it never appears in the route table.',
  },
  compliance_advanced: {
    enforcement: 'handler',
    controls: ['src/components/compliance/ComplianceContentSets.tsx', 'src/components/compliance/SubscriptionManager.tsx'],
    unlocks: 'subscribing to the curated SOC 2 / PCI-DSS / CIS compliance libraries',
    note: 'Same `set:`-tag gate as compliance_standard, and requires it.',
  },
  sso: {
    enforcement: 'handler',
    controls: ['src/lib/nav.ts', 'pages/dashboard/settings/sso.tsx'],
    unlocks: 'single sign-on and external identity-provider configuration',
    note: 'Platform’s `requireOwnOrgSso` re-checks the entitlement inside every org-facing IdP/SCIM handler (403 SSO_NOT_ENTITLED), so it never reaches the route table. The nav item carries `requiredFeature: sso` and the page renders its own upsell.',
  },
  priority_support: {
    enforcement: 'entitlement-only',
    controls: [],
    unlocks: 'faster response times and dedicated support channels',
    note: 'A support-process entitlement. No API route checks it, so no control is locked.',
  },
  custom_integrations: {
    enforcement: 'entitlement-only',
    controls: [],
    unlocks: 'connecting external services and custom webhook endpoints',
    note: 'No API route checks it today; alert destinations and webhooks are permission-gated, not entitlement-gated. Locking them client-side would remove working capability.',
  },
  audit_log: {
    enforcement: 'entitlement-only',
    controls: [],
    unlocks: 'the detailed audit trail of user and system actions',
    note: 'Sold as an add-on, but the platform audit routes are gated on org-admin only — no `requireFeature`. The UI must NOT lock the Audit Log page while every org can call the API.',
  },
};

/**
 * Deep link to the place a viewer can actually acquire the entitlement. The
 * billing page consumes `?highlight=<flag>` to scroll to / open the matching
 * add-on, so the lock copy ends somewhere useful instead of "contact sales".
 */
export function featureUpsellHref(flag: FeatureFlag): string {
  return `/dashboard/billing?highlight=${flag}`;
}
