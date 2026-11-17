// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Inviter exit — revoke the pending invitations a person sent into an org when
 * they leave it.
 *
 * Shared by every path that takes a person out of an org: an admin removing or
 * deactivating them (`org-members-service`) and the directory deprovisioning
 * them over SCIM (`scim-users`). Kept in its own small module so the SCIM
 * service does not pull the whole member-management service into its graph.
 */

import type mongoose from 'mongoose';
import { toOrgId } from '../helpers/org-id.js';
import { Invitation } from '../models/index.js';

/** A pending invitation withdrawn because its sender left the org — the
 *  secret-free facts the controller audits as `invitation.revoke`. */
export interface RevokedInvitation {
  invitationId: string;
  organizationId: string;
  email: string;
  role: string;
}

/**
 * Revoke every PENDING invitation `userId` sent into `orgId`, in the caller's
 * transaction.
 *
 * An invitation is the sender's authority to admit someone, parked until the
 * invitee clicks. Once the sender is removed, deactivated or deprovisioned that
 * authority is gone, so the invitations they left pending go with it —
 * otherwise a departed admin's outstanding links keep onboarding people into the
 * org they no longer belong to. Same status the manual revoke
 * (`invitationService.revoke`) writes, so the listing, the preview and
 * acceptance all already treat them as dead. Acceptance also re-checks the
 * inviter (`processAcceptance`) as a backstop.
 */
export async function revokePendingInvitationsSentBy(
  userId: string,
  orgId: string,
  session: mongoose.ClientSession,
): Promise<RevokedInvitation[]> {
  const pending = await Invitation.find({ invitedBy: userId, organizationId: toOrgId(orgId), status: 'pending' })
    .select('_id organizationId email role').session(session).lean();
  if (pending.length === 0) return [];
  await Invitation.updateMany(
    { _id: { $in: pending.map((inv) => inv._id) }, status: 'pending' },
    { $set: { status: 'revoked' } },
    { session },
  );
  return pending.map((inv) => ({
    invitationId: String(inv._id),
    organizationId: String(inv.organizationId),
    email: inv.email,
    role: inv.role,
  }));
}
