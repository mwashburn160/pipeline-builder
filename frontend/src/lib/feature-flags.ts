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
 *   - `priority_support` / `custom_integrations` → account-level entitlements no
 *                           API route checks. They gate nothing in the UI (locking
 *                           a control the API serves would take away capability
 *                           the org has); they still drive the per-org override
 *                           editor and the billing add-on labels.
 *   - `verified_publisher` → eligibility to apply for the Verified publisher badge.
 *
 * Which flags are enforced WHERE — and therefore which ones need a UI gate —
 * lives in `feature-gates.ts`, checked against the generated route tables by
 * `test/route-permissions.test.tsx`.
 */

import type { FeatureFlag } from '@pipeline-builder/api-core/feature-flags';

export { ALL_FEATURE_FLAGS, FEATURE_METADATA, type FeatureFlag } from '@pipeline-builder/api-core/feature-flags';

/**
 * The feature flags that gate curated compliance content sets. Shared by the
 * compliance content-set section (ComplianceContentSets) and the catalog
 * set-tag gating (SubscriptionManager).
 */
export type ComplianceSetFlag = Extract<FeatureFlag, 'compliance_standard' | 'compliance_advanced'>;
