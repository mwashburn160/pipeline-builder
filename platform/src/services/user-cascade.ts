// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import { assertNotLastPrivilegedMember } from './role-crud.js';
import { USER_OWNER_HAS_ORGS } from './user-errors.js';
import { JoinRequest, MfaRecoveryCodes, MfaResetRequest, PersonalAccessToken, RoleAssignment, User, UserOrganization, UserPreferences, UserTotp, WebAuthnCredential } from '../models/index.js';
import SamlSession from '../models/saml-session.js';

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
 * Removes the user, their memberships, Role assignments, PATs, passkeys, TOTP
 * enrolment, preferences, SAML SLO sessions and domain-join requests. A leftover join request would otherwise let an admin
 * approve it later and mint a membership for a user who no longer exists — an
 * orphan row that still counts toward the org's seats.
 *
 * NOT removed: the SERVICE ACCOUNTS this user created (#2). They belong to the
 * ORG, not to the person — `ServiceAccount.createdBy`/`createdByEmail` are an
 * attribution snapshot that deliberately outlives the user, so automation does
 * not break when an engineer leaves. Every delete here filters on `userId`, and
 * a service account's keys and Role assignments carry `serviceAccountId`
 * instead, so none of these statements can reach them. The org purge is what
 * deletes accounts (see `org-cascade-service`).
 *
 * Returns the deleted user's ACCESS-token version (`tokenVersion` +
 * `claimsVersion`, for post-commit revocation publishing), or `null` when the
 * user did not exist.
 */
export async function deleteUserCascade(
  session: ClientSession,
  userId: string | Types.ObjectId,
): Promise<{ accessVersion: number } | null> {
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
  // Passkeys are credentials for THIS person only. Left behind they would keep a
  // unique `credentialId` reserved, so re-registering the same authenticator on a
  // re-created account would fail with a duplicate key.
  await WebAuthnCredential.deleteMany({ userId: uid }, { session });
  // The authenticator-app enrolment (an encrypted secret) and the account's
  // recovery-code hashes, both meaningless once the account is gone — and their
  // `userId` unique indexes would block a re-created account from enrolling.
  await UserTotp.deleteMany({ userId: uid }, { session });
  await MfaRecoveryCodes.deleteMany({ userId: uid }, { session });
  // Pending MFA resets naming this account can no longer be carried out. The
  // audit trail keeps what happened to them.
  await MfaResetRequest.deleteMany({ targetUserId: uid }, { session });
  await UserPreferences.deleteMany({ userId: uid }, { session });
  await JoinRequest.deleteMany({ userId: uid }, { session });
  // SAML SLO bookkeeping for the person's sessions (NameID / SessionIndex per
  // platform session). Left behind, an IdP-initiated logout could still match a
  // deleted account's rows until their TTL lapsed. `userId` is stored as a string.
  await SamlSession.deleteMany({ userId: String(uid) }, { session });
  return { accessVersion: (deleted.tokenVersion ?? 0) + (deleted.claimsVersion ?? 0) };
}
