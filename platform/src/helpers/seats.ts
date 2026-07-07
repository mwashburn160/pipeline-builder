// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ClientSession } from 'mongoose';
import { toOrgId } from './controller-helper.js';
import { Invitation, UserOrganization } from '../models/index.js';

/**
 * Whether an org has room for `addCount` more member(s).
 *
 * `seats` is a tier LIMIT (`org.quotas.seats`), NOT a usage-tracked counter —
 * its "usage" is computed LIVE as active memberships + pending invites (each
 * pending invite reserves a seat until it is accepted or expires). A limit of
 * `-1` means unlimited.
 *
 * Active members only (`isActive: true`) so the enforced count matches the
 * member count the dashboard displays; a deactivated member does not hold a
 * seat. Pass the transaction `session` so the count reflects rows created
 * earlier in the same transaction (e.g. sequential bulk adds).
 *
 * NOTE: this is a read-then-write check, not an atomic reservation — under
 * highly concurrent invites/adds against the same org the cap can be
 * overshot by a small amount. Enforcement is best-effort by design; the
 * authoritative cap is re-checked on every add.
 */
export async function seatCapacityAvailable(
  orgId: string,
  seatLimit: number,
  addCount: number,
  session?: ClientSession | null,
): Promise<boolean> {
  if (seatLimit === -1) return true;
  const organizationId = toOrgId(orgId);
  const [memberCount, pendingCount] = await Promise.all([
    UserOrganization.countDocuments({ organizationId, isActive: true }).session(session ?? null),
    Invitation.countDocuments({ organizationId, status: 'pending' }).session(session ?? null),
  ]);
  return memberCount + pendingCount + addCount <= seatLimit;
}
