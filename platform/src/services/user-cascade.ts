// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { assertNotLastPrivilegedMember } from './roles-service.js';
import { USER_OWNER_HAS_ORGS } from './user-errors.js';
import { JoinRequest, PersonalAccessToken, RoleAssignment, User, UserOrganization, UserPreferences } from '../models/index.js';

/**
 * Delete a user account and everything keyed to it, inside the caller's
 * transaction — the one cascade behind both self-serve account deletion and
 * admin user deletion.
 *
 * Guards (read inside the transaction, so they see a snapshot consistent with
 * the delete):
 *   - `USER_OWNER_HAS_ORGS` when the user owns an organization (transfer first);
 *   - `RL_LAST_PRIVILEGED_MEMBER` when they are the last member of an
 *     admin/superadmin-granting Role.
 *
 * Removes the user, their memberships, Role assignments, PATs, preferences and
 * domain-join requests. A leftover join request would otherwise let an admin
 * approve it later and mint a membership for a user who no longer exists — an
 * orphan row that still counts toward the org's seats.
 *
 * Returns the deleted user's `tokenVersion` (for post-commit revocation
 * publishing), or `null` when the user did not exist.
 */
export async function deleteUserCascade(
  session: ClientSession,
  userId: string | Types.ObjectId,
): Promise<{ tokenVersion: number } | null> {
  const uid = new Types.ObjectId(String(userId));

  if (await UserOrganization.countDocuments({ userId: uid, role: 'owner' }).session(session) > 0) {
    throw new Error(USER_OWNER_HAS_ORGS);
  }
  await assertNotLastPrivilegedMember(session, uid);

  const deleted = await User.findByIdAndDelete(uid, { session }).select('+tokenVersion');
  if (!deleted) return null;

  await UserOrganization.deleteMany({ userId: uid }, { session });
  await RoleAssignment.deleteMany({ userId: uid }, { session });
  await PersonalAccessToken.deleteMany({ userId: uid }, { session });
  await UserPreferences.deleteMany({ userId: uid }, { session });
  await JoinRequest.deleteMany({ userId: uid }, { session });
  return { tokenVersion: deleted.tokenVersion ?? 0 };
}
