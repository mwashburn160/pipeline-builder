// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared "active-org info for response shaping" lookup.
 *
 * `user-admin-service.updateUserById/updateFeatures` and
 * `user-profile-service.updateProfile` each ran the same parallel
 * `Organization.findById + UserOrganization.findOne` against the user's
 * `lastActiveOrgId` to enrich the response with the org name + caller
 * role. `tier` is also fetched because at least one caller surfaces it;
 * the extra select is one column and saves a second round-trip.
 */

import mongoose from 'mongoose';
import { Organization, UserOrganization } from '../models';

export interface ActiveOrgInfo {
  organizationName: string | null;
  activeOrgRole?: string;
  tier?: string;
}

/**
 * Resolve the org name + caller's role in the user's last-active org. Returns
 * `{ organizationName: null }` when the user has no active org — callers should
 * treat that as "user belongs to no org".
 */
export async function loadActiveOrgInfo(
  userId: string | mongoose.Types.ObjectId,
  activeOrgId: string | undefined,
): Promise<ActiveOrgInfo> {
  if (!activeOrgId) return { organizationName: null };

  const [org, membership] = await Promise.all([
    Organization.findById(activeOrgId).select('name tier').lean(),
    UserOrganization.findOne({ userId, organizationId: activeOrgId, isActive: true }).lean(),
  ]);

  return {
    organizationName: org?.name || null,
    activeOrgRole: membership?.role,
    tier: org?.tier,
  };
}
