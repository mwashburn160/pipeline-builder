// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which organizations go with an account when its owner deletes it.
 *
 * Every self-signup makes the person the OWNER of a paired org, and an owner
 * can't be deleted while they own a live org (`USER_OWNER_HAS_ORGS`). For a
 * person who is the org's ONLY member there is nobody to transfer ownership to,
 * so the rule is:
 *
 *   - an owned org with NO other member is soft-deleted together with the
 *     account, through the same `softDeleteOrg` the sysadmin and team deletes
 *     use (recovery snapshot, tombstone, purge after the retention window);
 *   - an owned org with any other member (active or not) still blocks — they
 *     transfer ownership first, exactly as before;
 *   - an owned org with live TEAMS blocks (the teams must go first, the same
 *     rule `DELETE /organization/:id` enforces), and the system org always
 *     blocks.
 *
 * An owned org that is already soft-deleted neither blocks nor is deleted again.
 *
 * `planAccountDeletion` is also the read the Delete-account UI shows
 * (`GET /user/account/deletion`), so the page and the delete can never disagree.
 */

import { isSystemOrgId } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import { Organization, UserOrganization } from '../models/index.js';

/** Why an owned org stops the account from being deleted. */
export type DeletionBlockReason = 'other-members' | 'has-teams' | 'system-org';

export interface AccountDeletionPlan {
  /** True when nothing blocks — `orgsDeleted` go with the account. */
  canDelete: boolean;
  /** Owned orgs, each with no other member, that are soft-deleted with the account. */
  orgsDeleted: Array<{ orgId: string; name: string }>;
  /** Owned orgs that must be handed over (or emptied) first. */
  blockedBy: Array<{ orgId: string; name: string; reason: DeletionBlockReason; otherMembers: number }>;
}

export async function planAccountDeletion(userId: string): Promise<AccountDeletionPlan> {
  const uid = new Types.ObjectId(String(userId));
  const owned = await UserOrganization.find({ userId: uid, role: 'owner' }).select('organizationId').lean();
  const plan: AccountDeletionPlan = { canDelete: true, orgsDeleted: [], blockedBy: [] };
  if (owned.length === 0) return plan;

  const orgs = await Organization.find({ _id: { $in: owned.map((o) => o.organizationId) }, deletedAt: null })
    .select('_id name').lean();
  for (const org of orgs) {
    const orgId = String(org._id);
    const name = String((org as { name?: string }).name ?? '');
    const otherMembers = await UserOrganization.countDocuments({ organizationId: org._id, userId: { $ne: uid } });
    let reason: DeletionBlockReason | null = null;
    if (isSystemOrgId(orgId)) reason = 'system-org';
    else if (otherMembers > 0) reason = 'other-members';
    else if ((await expandOrgScope(orgId)).length > 1) reason = 'has-teams';
    if (reason) plan.blockedBy.push({ orgId, name, reason, otherMembers });
    else plan.orgsDeleted.push({ orgId, name });
  }
  plan.canDelete = plan.blockedBy.length === 0;
  return plan;
}
