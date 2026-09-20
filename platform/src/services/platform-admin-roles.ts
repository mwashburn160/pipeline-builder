// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-admin (superadmin) grant + revoke.
 *
 * Kept apart from the org-level Role surface in `roles-service.ts`: this is the
 * one pair of operations that crosses the tenant boundary entirely — it writes
 * an assignment in the SYSTEM org and flips a platform-wide flag on the user —
 * so it should not sit in the middle of the per-org helpers and be reached for
 * by accident.
 */

import { SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import type { UserId } from './role-authority.js';
import { RL_SUPERADMIN_ROLE_MISSING } from './roles-errors.js';
import { recomputeUserOrgRole } from './roles-service.js';
import { publishUserRevocation } from '../helpers/session-revocation.js';
import { Role, RoleAssignment, User } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

/**
 * Grant platform-admin by making the **system-org Super Admin Role** the source
 * of truth (single-source model): assign the user to that Role, then recompute
 * — which flips `User.isSuperAdmin` from the Role assignment and bumps
 * `tokenVersion` on a genuine change. This keeps the flag and `recomputeUserOrgRole`
 * permanently in agreement (a later recompute re-derives `isSuperAdmin=true`
 * because the assignment persists), closing the direct-flag divergence. Also
 * clears the refresh-session slots on a real change so the session can't be re-issued.
 *
 * Self-healing + idempotent: a legacy user who has the flag but no assignment
 * gets the assignment added with no session churn (`changed:false`); an already-
 * granted user is a no-op. Returns whether the effective grant changed (for the
 * caller's audit + response).
 */
export async function grantPlatformAdmin(userId: UserId): Promise<{ changed: boolean }> {
  const result = await withMongoTransaction(async (session) => {
    const role = await Role.findOne({ organizationId: SYSTEM_ORG_ID, grantsRole: 'superadmin', system: true })
      .session(session).select('_id').lean();
    if (!role) throw new Error(RL_SUPERADMIN_ROLE_MISSING);
    const before = await User.findById(userId).select('+isSuperAdmin').session(session).lean();
    const wasSuperadmin = before?.isSuperAdmin === true;

    await RoleAssignment.updateOne(
      { userId, roleId: role._id },
      { $setOnInsert: { userId, roleId: role._id, organizationId: SYSTEM_ORG_ID } },
      { upsert: true, session },
    );
    // recompute reads the Super Admin Role assignment, sets isSuperAdmin, and
    // bumps tokenVersion only on a genuine flip.
    await recomputeUserOrgRole(userId, SYSTEM_ORG_ID, session);
    if (!wasSuperadmin) {
      await User.updateOne({ _id: userId }, { $set: { refreshSessions: [] } }, { session });
    }
    return { changed: !wasSuperadmin };
  });
  // Post-commit: on a genuine flip, recompute bumped tokenVersion — publish it.
  if (result.changed) await publishUserRevocation(String(userId));
  return result;
}

/**
 * Revoke platform-admin by removing the system-org Super Admin Role assignment,
 * then recomputing (which clears `User.isSuperAdmin` + bumps `tokenVersion`).
 * Counterpart of {@link grantPlatformAdmin}; works even for a legacy user who
 * had the flag set directly but never held the Role (recompute clears the flag
 * from the now-absent assignment). Clears the refresh-session slots on a real change.
 */
export async function revokePlatformAdmin(userId: UserId): Promise<{ changed: boolean }> {
  const result = await withMongoTransaction(async (session) => {
    const role = await Role.findOne({ organizationId: SYSTEM_ORG_ID, grantsRole: 'superadmin', system: true })
      .session(session).select('_id').lean();
    if (!role) throw new Error(RL_SUPERADMIN_ROLE_MISSING);
    const before = await User.findById(userId).select('+isSuperAdmin').session(session).lean();
    const wasSuperadmin = before?.isSuperAdmin === true;

    await RoleAssignment.deleteOne({ userId, roleId: role._id }, { session });
    await recomputeUserOrgRole(userId, SYSTEM_ORG_ID, session);
    if (wasSuperadmin) {
      await User.updateOne({ _id: userId }, { $set: { refreshSessions: [] } }, { session });
    }
    return { changed: wasSuperadmin };
  });
  // Post-commit: on a genuine flip, recompute bumped tokenVersion — publish it.
  if (result.changed) await publishUserRevocation(String(userId));
  return result;
}
