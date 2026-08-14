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
 *                           (`requireFeature('ai_generation')`); the create
 *                           surfaces don't pre-hide, so a non-entitled org sees a
 *                           403 on submit rather than a hidden tab (see report FLAG).
 *   - `priority_support` / `custom_integrations` / `audit_log` → account-level
 *                           ENTITLEMENTS with no per-page render gate. They are NOT
 *                           dead: they drive the per-org override editor
 *                           (FeatureOverridesEditor) and the billing add-on labels
 *                           (AddonGrid), and are enforced server-side where they
 *                           apply. They are kept in the catalog because it must
 *                           mirror api-core exactly (removing one drifts the mirror
 *                           and breaks the override editor / add-on labels).
 */

export type FeatureFlag =
  | 'priority_support'
  | 'custom_integrations'
  | 'ai_generation'
  | 'bulk_operations'
  | 'audit_log'
  // DORA / advanced delivery analytics (paid tiers only).
  | 'advanced_reporting'
  // Per-team usage breakdown (Enterprise-included; add-on for Pro/Team).
  | 'team_usage_analytics';

export const ALL_FEATURE_FLAGS: ReadonlyArray<FeatureFlag> = [
  'priority_support',
  'ai_generation',
  'bulk_operations',
  'custom_integrations',
  'audit_log',
  'advanced_reporting',
  'team_usage_analytics',
];

export const FEATURE_METADATA: Record<FeatureFlag, { label: string; description: string }> = {
  priority_support: { label: 'Priority Support', description: 'Faster response times and dedicated support channels' },
  ai_generation: { label: 'AI Generation', description: 'AI-powered pipeline and plugin generation' },
  bulk_operations: { label: 'Bulk Operations', description: 'Batch create, update, and delete for pipelines and plugins' },
  custom_integrations: { label: 'Custom Integrations', description: 'Connect to external services and custom webhook endpoints' },
  audit_log: { label: 'Audit Log', description: 'Detailed audit trail of all user and system actions' },
  advanced_reporting: { label: 'Advanced Reporting', description: 'DORA / advanced delivery analytics' },
  team_usage_analytics: { label: 'Team Usage Analytics', description: 'Per-team usage breakdown across the org → team subtree' },
};
