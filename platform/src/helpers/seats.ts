// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ClientSession } from 'mongoose';
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
 *   under concurrent invites/adds against the same account. This is the PRE-write
 *   check; the write paths pair it with a post-write re-check
 *   ({@link seatCapacityStillWithinCap}) inside the same transaction to shrink the
 *   window. See that function's note for the residual limitation.
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

  // Every org-id field is now a plain ObjectId, and `.map(toOrgId)` casts the
  // 24-hex scope ids accordingly, so the same id set feeds both the membership
  // and (strict-ObjectId) Invitation queries directly.
  const scopeIds = (await expandOrgScope(rootOrgId)).map(toOrgId);
  const [memberIds, pendingEmails] = await Promise.all([
    UserOrganization.distinct('userId', { organizationId: { $in: scopeIds }, isActive: true }).session(session ?? null),
    Invitation.distinct('email', { organizationId: { $in: scopeIds }, status: 'pending' }).session(session ?? null),
  ]);

  const used = memberIds.length + pendingEmails.length;
  return used + addCount <= seatLimit;
}

/**
 * Post-write seat re-check for the transactional reservation pattern (G5).
 *
 * Call this AFTER inserting the membership / pending-invite row, still inside the
 * SAME `withMongoTransaction` and threading the same `session`. It recounts pooled
 * usage — now INCLUDING the row this transaction just wrote (a transaction's own
 * uncommitted writes are visible to its later reads) — and returns `false` if the
 * account is now OVER its seat cap. The caller must then `throw` so the surrounding
 * transaction aborts and rolls the write back.
 *
 * Effectively this is `seatCapacityAvailable(orgId, 0, session)`: `used` already
 * counts the just-written seat, so the `+0` comparison asserts the POST-write
 * invariant `used <= seatLimit`. Distinct-human semantics still hold — a user who
 * already held a seat elsewhere doesn't raise the distinct count, so re-adding them
 * can't trip this.
 *
 * WHY (and the residual window): the pre-write check + this post-write re-check are
 * BOTH read-then-compare against a MongoDB snapshot. Two transactions that INSERT
 * DISTINCT documents (different member ids / invite emails) do NOT write-conflict
 * under WiredTiger, so neither sees the other's still-uncommitted row and both
 * post-write re-checks can pass — leaving a bounded overshoot possible. This
 * re-check DOES close the common cases (a later transaction whose snapshot already
 * reflects the other's commit; a same-document retry). Fully closing the race would
 * need a single serialization point every writer contends on — e.g. a per-account
 * seat-counter document bumped in each transaction so concurrent writers
 * write-conflict and one retries — i.e. a schema change, deliberately left out of
 * scope here (see project memory: no risky schema redesign). Consistent with the
 * documented "over-count errs toward blocking early" stance, the residual error is
 * a small overshoot, not a hard failure.
 */
export async function seatCapacityStillWithinCap(
  orgId: string,
  session?: ClientSession | null,
): Promise<boolean> {
  return seatCapacityAvailable(orgId, 0, session);
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

  // Org-id fields are plain ObjectId now (see seatCapacityAvailable): the cast
  // scope id set feeds both queries directly.
  const scopeIds = (await expandOrgScope(rootOrgId)).map(toOrgId);
  const [memberIds, pendingEmails] = await Promise.all([
    UserOrganization.distinct('userId', { organizationId: { $in: scopeIds }, isActive: true }),
    Invitation.distinct('email', { organizationId: { $in: scopeIds }, status: 'pending' }),
  ]);
  return { limit, used: memberIds.length + pendingEmails.length };
}
