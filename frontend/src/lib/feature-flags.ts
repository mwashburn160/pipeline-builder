// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The feature-flag catalog, straight from api-core's dependency-free
 * `./feature-flags` subpath — the same list the backend validates override keys
 * against, so the override editor, add-on labels and render gates can't drift.
 *
 * How the catalog is consumed in the UI:
 *   - `bulk_operations`   → gates the bulk-select toolbar on the pipelines &
 *                           plugins pages (the bulk routes `requireFeature` it).
 *   - `advanced_reporting`/`team_usage_analytics` → gate the DORA scorecard and
 *                           per-team usage card respectively.
 *   - `ai_generation`     → server-enforced on the AI generate routes; the create
 *                           modal also pre-gates the two AI tabs (Git URL / From
 *                           prompt) with an upsell so a non-entitled org sees why
 *                           instead of a 403 on submit.
 *   - `sso`               → gates the SSO / IdP settings.
 *   - `compliance_standard` / `compliance_advanced` → gate the curated
 *                           content-set section on the compliance page: a set the
 *                           org doesn't hold shows an upsell deep-linking to the
 *                           billing add-on. Subscribing is server-enforced; the
 *                           page itself stays open (compliance:read).
 *   - `support_standard` / `support_priority` / `support_premium` → the support
 *                           levels. Holding ANY of them shows the Support nav
 *                           entry (`requiredAnyFeature` in nav.ts); they also
 *                           drive the per-org override editor and the billing
 *                           add-on labels. Support is an add-on at every tier,
 *                           priced per contact, and the real gate is the
 *                           `supportContacts` quota.
 *   - `custom_integrations` → an account-level entitlement no API route checks;
 *                           it gates nothing in the UI (locking a control the
 *                           API serves would take away capability the org has).
 *   - `verified_publisher` → eligibility to apply for the Verified publisher badge.
 *
 * Which flags are enforced WHERE — and therefore which ones need a UI gate —
 * lives in `feature-gates.ts`, checked against the generated route tables by
 * `test/route-permissions.test.tsx`.
 */

import {
  complianceFeatureForTags,
  type COMPLIANCE_SET_FEATURES,
  type ComplianceContentSet,
} from '@pipeline-builder/api-core/feature-flags';

export { ALL_FEATURE_FLAGS, SUPPORT_FEATURE_FLAGS, FEATURE_METADATA, type FeatureFlag } from '@pipeline-builder/api-core/feature-flags';

/**
 * The feature flags that gate curated compliance content sets — derived from
 * api-core's set → feature catalog, so a new set is a new flag here too. Shared
 * by the compliance content-set section (ComplianceContentSets) and the catalog
 * set-tag gating (SubscriptionManager).
 */
export type ComplianceSetFlag = (typeof COMPLIANCE_SET_FEATURES)[ComplianceContentSet];

/**
 * The set feature a rule's `set:<x>` tags require (highest entitlement wins), or
 * null for a baseline rule. api-core's resolver returns the wider `FeatureFlag`
 * type, but only ever one of `COMPLIANCE_SET_FEATURES`' values.
 */
export function complianceSetFlagForTags(tags: unknown): ComplianceSetFlag | null {
  return complianceFeatureForTags(tags) as ComplianceSetFlag | null;
}
