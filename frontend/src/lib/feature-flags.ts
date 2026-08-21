// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mirror of the canonical feature-flag catalog in
 * `packages/api-core/src/types/feature-flags.ts`. The frontend doesn't
 * depend on api-core directly (that package carries Express types we
 * don't want bundled), so we restate the catalog here. Adding a flag
 * means updating both files — the backend validator will reject an
 * unknown override key, so a missed update fails loudly in the UI.
 *
 * How the catalog is consumed in the UI:
 *   - `bulk_operations`   → gates the bulk-select toolbar on the pipelines &
 *                           plugins pages (backend attaches
 *                           `requireFeature('bulk_operations')` to the bulk routes).
 *   - `advanced_reporting`/`team_usage_analytics` → gate the DORA scorecard and
 *                           per-team usage card respectively.
 *   - `ai_generation`     → SERVER-enforced on the AI generate routes
 *                           (`requireFeature('ai_generation')`); the create modal
 *                           now ALSO pre-gates the two AI tabs (Git URL / From
 *                           prompt) with an upsell (see CreatePipelineModal
 *                           `AiUpsell`) so a non-entitled org sees why instead of a
 *                           403 dead-end on submit. The server gate stays the
 *                           source of truth.
 *   - `priority_support` / `custom_integrations` / `audit_log` → account-level
 *                           ENTITLEMENTS with no per-page render gate. They are NOT
 *                           dead: they drive the per-org override editor
 *                           (FeatureOverridesEditor) and the billing add-on labels
 *                           (AddonGrid), and are enforced server-side where they
 *                           apply. They are kept in the catalog because it must
 *                           mirror api-core exactly (removing one drifts the mirror
 *                           and breaks the override editor / add-on labels).
 *   - `compliance_standard` / `compliance_advanced` → curated compliance rule
 *                           libraries sold as add-on bundles. They gate the
 *                           curated-content-set section on the compliance page
 *                           (ComplianceContentSets): a set the org doesn't hold
 *                           shows an upsell deep-linking to the billing add-on.
 *                           Subscribing to a set's system-org published rules is
 *                           server-enforced on these flags; the page itself stays
 *                           open (compliance:read). `compliance_advanced` requires
 *                           `compliance_standard` (enforced billing-side).
 */

export type FeatureFlag =
  | 'priority_support'
  | 'custom_integrations'
  | 'ai_generation'
  | 'bulk_operations'
  | 'audit_log'
  // Single sign-on / external IdP configs (INCLUDED in Team, add-on for others).
  | 'sso'
  // DORA / advanced delivery analytics (paid tiers only).
  | 'advanced_reporting'
  // Per-team usage breakdown (Enterprise-included; add-on for Pro/Team).
  | 'team_usage_analytics'
  // Curated compliance rule libraries sold as add-on bundles. `compliance_standard`
  // = CI/CD best-practice set; `compliance_advanced` = SOC2/PCI/CIS framework
  // libraries (requires Standard). INCLUDED in Enterprise/Unlimited.
  | 'compliance_standard'
  | 'compliance_advanced';

/**
 * The feature flags that gate curated compliance content sets. Derived from the
 * catalog (not re-typed) so it can't drift from `FeatureFlag`. Shared by the
 * compliance content-set section (ComplianceContentSets) and the catalog
 * set-tag gating (SubscriptionManager).
 */
export type ComplianceSetFlag = Extract<FeatureFlag, 'compliance_standard' | 'compliance_advanced'>;

export const ALL_FEATURE_FLAGS: ReadonlyArray<FeatureFlag> = [
  'priority_support',
  'ai_generation',
  'bulk_operations',
  'custom_integrations',
  'audit_log',
  'sso',
  'advanced_reporting',
  'team_usage_analytics',
  'compliance_standard',
  'compliance_advanced',
];

export const FEATURE_METADATA: Record<FeatureFlag, { label: string; description: string }> = {
  priority_support: { label: 'Priority Support', description: 'Faster response times and dedicated support channels' },
  ai_generation: { label: 'AI Generation', description: 'AI-powered pipeline and plugin generation' },
  bulk_operations: { label: 'Bulk Operations', description: 'Batch create, update, and delete for pipelines and plugins' },
  custom_integrations: { label: 'Custom Integrations', description: 'Connect to external services and custom webhook endpoints' },
  audit_log: { label: 'Audit Log', description: 'Detailed audit trail of all user and system actions' },
  sso: { label: 'SSO / IdP', description: 'Single sign-on and external identity-provider configurations' },
  advanced_reporting: { label: 'Advanced Reporting', description: 'DORA / advanced delivery analytics' },
  team_usage_analytics: { label: 'Team Usage Analytics', description: 'Per-team usage breakdown across the org → team subtree' },
  compliance_standard: { label: 'Standard Compliance', description: 'Curated CI/CD best-practice compliance rule library' },
  compliance_advanced: { label: 'Advanced Compliance', description: 'Curated framework compliance libraries (SOC2 / PCI-DSS / CIS)' },
};
