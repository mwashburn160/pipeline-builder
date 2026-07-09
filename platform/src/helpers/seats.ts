// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Types, type ClientSession } from 'mongoose';
import { toOrgId } from './controller-helper.js';
import { expandOrgScope, resolveOrgLineage } from './org-hierarchy.js';
import { Invitation, Organization, UserOrganization } from '../models/index.js';

/**
 * Whether an org's account has room for `addCount` more member(s).
 *
 * Seats POOL AT THE ROOT (docs/org-team-hierarchy.md §5.2): the limit is the
 * ROOT org's `quotas.seats`, and usage is the LIVE count of **distinct active
 * humans** across the whole subtree (a person on several teams is ONE seat)
 * plus pending invites (each reserves a seat until accepted/expired). A limit
 * of `-1` means unlimited.
 *
 * Flat orgs resolve to themselves (`rootOrgId === orgId`, subtree `[self]`), so
 * this is a no-op wrapper for the vast majority of accounts.
 *
 * NOTES:
 * - Pending invites are keyed by email; a pending email that already belongs to
 *   an active member in a sibling team may be over-counted (rare — the per-org
 *   `INV_ALREADY_MEMBER` guard blocks the common case). Over-counting errs
 *   toward blocking slightly early, which is the safe direction for a cap.
 * - Read-then-write, not an atomic reservation — a small overshoot is possible
 *   under concurrent invites/adds against the same account (documented).
 */
export async function seatCapacityAvailable(
  orgId: string,
  addCount: number,
  session?: ClientSession | null,
): Promise<boolean> {
  const { rootOrgId } = await resolveOrgLineage(orgId);

  const root = await Organization.findById(toOrgId(rootOrgId))
    .select('quotas.seats').session(session ?? null).lean();
  const seatLimit = root?.quotas?.seats ?? -1;
  if (seatLimit === -1) return true;

  const scopeIds = (await expandOrgScope(rootOrgId)).map(toOrgId);
  // Invitation.organizationId is a strict ObjectId (unlike the Mixed
  // UserOrganization.organizationId), so a string-keyed scope id like the
  // 'system' org would throw a CastError. Such orgs can't have ObjectId-keyed
  // invitations anyway, so query invites over the ObjectId subset only.
  const inviteScopeIds = scopeIds.filter((id) => id instanceof Types.ObjectId);
  const [memberIds, pendingEmails] = await Promise.all([
    UserOrganization.distinct('userId', { organizationId: { $in: scopeIds }, isActive: true }).session(session ?? null),
    Invitation.distinct('email', { organizationId: { $in: inviteScopeIds }, status: 'pending' }).session(session ?? null),
  ]);

  const used = memberIds.length + pendingEmails.length;
  return used + addCount <= seatLimit;
}

/**
 * Current pooled seat usage + limit for an org's account (root). `used` =
 * distinct active members across the subtree + pending invites (same count the
 * capacity check uses). Used by the billing over-cap gate when removing a seat
 * bundle would strand members. `limit` is `-1` for unlimited.
 */
export async function pooledSeatUsage(
  orgId: string,
): Promise<{ limit: number; used: number }> {
  const { rootOrgId } = await resolveOrgLineage(orgId);
  const root = await Organization.findById(toOrgId(rootOrgId)).select('quotas.seats').lean();
  const limit = root?.quotas?.seats ?? -1;

  const scopeIds = (await expandOrgScope(rootOrgId)).map(toOrgId);
  // See seatCapacityAvailable: invites key organizationId as a strict ObjectId,
  // so exclude string-keyed scope ids (e.g. 'system') to avoid a CastError.
  const inviteScopeIds = scopeIds.filter((id) => id instanceof Types.ObjectId);
  const [memberIds, pendingEmails] = await Promise.all([
    UserOrganization.distinct('userId', { organizationId: { $in: scopeIds }, isActive: true }),
    Invitation.distinct('email', { organizationId: { $in: inviteScopeIds }, status: 'pending' }),
  ]);
  return { limit, used: memberIds.length + pendingEmails.length };
}
