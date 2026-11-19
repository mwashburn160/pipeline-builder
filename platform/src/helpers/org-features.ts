// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { resolveUserFeatures, type FeatureFlag, type PlanTier } from '@pipeline-builder/api-core';
import { resolveOrgLineage } from './org-hierarchy.js';
import { toOrgId } from './org-id.js';
import { Organization } from '../models/index.js';

/**
 * An org's ORG-LEVEL feature flags: its tier defaults plus the account's feature
 * entitlements (operator grants and purchased bundles). For a parented team the
 * entitlements POOL at the account root, so they are read from the root
 * (mirrors token issuance's `accountContext`). No user's overrides apply.
 * `null` for an unknown or soft-deleted org.
 */
export async function resolveOrgFeatures(orgId: string): Promise<FeatureFlag[] | null> {
  const org = await Organization.findById(toOrgId(orgId))
    .select('tier featureEntitlements parentOrgId deletedAt').lean();
  if (!org || (org as { deletedAt?: Date | null }).deletedAt) return null;

  let accountFeatures = (org as { featureEntitlements?: string[] }).featureEntitlements ?? [];
  if ((org as { parentOrgId?: string | null }).parentOrgId) {
    try {
      const { rootOrgId } = await resolveOrgLineage(orgId);
      const root = await Organization.findById(toOrgId(rootOrgId)).select('featureEntitlements').lean();
      accountFeatures = (root as { featureEntitlements?: string[] })?.featureEntitlements ?? accountFeatures;
    } catch {
      // Degrade to the team-doc copy (same choice token issuance makes).
    }
  }
  return resolveUserFeatures((org as { tier: PlanTier }).tier, { accountFeatures });
}
