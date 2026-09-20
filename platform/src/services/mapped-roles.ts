// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Directory-driven Role grants: the Role set a user holds because of what an
 * identity provider says about them, rather than because someone clicked.
 *
 * Shared by IdP group mapping (3a) and SCIM group membership (3b) so both agree
 * on which Roles an automated grant may name and on how the resulting set is
 * reconciled. Split out of `roles-service.ts`: these two functions are the only
 * ones whose caller is a directory rather than a person, and they carry their
 * own (stricter) rules about what may be granted.
 */

import mongoose from 'mongoose';
import { IGM_FORBIDDEN_GRANT } from './idp-mapping-errors.js';
import { assertActorMayAssignRole } from './role-authority.js';
import type { OrgId, RoleAssignmentActor, UserId } from './role-authority.js';
import { RL_ROLE_NOT_FOUND } from './roles-errors.js';
import { toOrgId } from '../helpers/org-id.js';
import { Role, RoleAssignment } from '../models/index.js';
import type { RoleGrant } from '../models/index.js';

/** A Role as the mapping surfaces report it. */
export interface MappableRole {
  id: string;
  name: string;
  grantsRole: RoleGrant;
}

/**
 * Validate a Role-id set for an AUTOMATED grant — an IdP group mapping today,
 * a SCIM group tomorrow — and return the Roles it names.
 *
 * Three gates, in the order a reviewer would ask about them:
 *   1. every id must be a Role OF `orgId` (`RL_ROLE_NOT_FOUND`), so a mapping can
 *      never reach into another tenant's Roles;
 *   2. no Role may confer authority that an in-org admin cannot take back —
 *      `grantsRole: 'superadmin'` is refused for EVERYONE, platform superadmins
 *      included (`IGM_FORBIDDEN_GRANT`). Org ownership is not expressible as a
 *      Role at all, and the provisioning path never writes `role: 'owner'`, so
 *      "a mapping can never grant owner" holds on both sides;
 *   3. the actor's own ceiling, exactly as a direct assignment enforces it
 *      (`RL_ASSIGN_EXCEEDS_CEILING`): a delegate holding only `roles:manage`
 *      cannot author a rule that grants capabilities they lack themselves.
 *
 * Gate 2 is stricter than {@link addUserToRole} on purpose: a direct assignment
 * is one deliberate act by a named admin, while a mapping keeps granting for as
 * long as an external directory says so.
 */
export async function assertMappableRoleSet(
  orgId: string,
  roleIds: readonly string[],
  actor: RoleAssignmentActor,
  session?: mongoose.ClientSession,
): Promise<MappableRole[]> {
  const oid = toOrgId(orgId);
  const requested = [...new Set(roleIds)];
  if (requested.length === 0) return [];

  const roles = await Role.find({ _id: { $in: requested }, organizationId: oid })
    .session(session ?? null).select('name grantsRole permissions').lean();
  if (roles.length !== requested.length) throw new Error(RL_ROLE_NOT_FOUND);

  for (const role of roles) {
    if (role.grantsRole === 'superadmin') throw new Error(IGM_FORBIDDEN_GRANT);
    assertActorMayAssignRole(role.permissions as string[] | undefined, actor);
  }
  return roles.map((r) => ({ id: String(r._id), name: r.name, grantsRole: r.grantsRole as RoleGrant }));
}

/**
 * Reconcile a user's DIRECTORY-DERIVED Role assignments in one org against
 * `mappedRoleIds`, leaving everything a human granted alone.
 *
 * Only rows carrying `source: 'jit'` are candidates for removal. A row an admin
 * created by hand (`source: 'manual'`, which is also how every pre-existing row
 * reads — the field is absent, and `$ne: 'jit'` therefore excludes it) survives
 * every sync, even when the Role has dropped out of the mapping. Conversely an
 * already-manual row that IS mapped stays manual: `$setOnInsert` only stamps
 * `jit` on a row this sync actually creates, so a sync can never demote a
 * hand-granted Role into one it may later delete.
 *
 * Runs inside the CALLER's transaction (the membership write and this must
 * commit together) and does NOT recompute the cached org role or bump
 * `tokenVersion` — the caller does that once, after the membership is settled.
 * Returns the Role ids added/removed, for the audit trail.
 */
export async function syncMappedRoles(
  organizationId: OrgId,
  userId: UserId,
  mappedRoleIds: readonly string[],
  session: mongoose.ClientSession,
): Promise<{ added: string[]; removed: string[] }> {
  const oid = toOrgId(String(organizationId));
  const wanted = new Set(mappedRoleIds.map(String));

  const held = await RoleAssignment.find({ userId, organizationId: oid })
    .session(session).select('roleId source').lean();
  const heldByRole = new Map(held.map((a) => [String(a.roleId), (a as { source?: string }).source]));

  const added: string[] = [];
  for (const roleId of wanted) {
    if (heldByRole.has(roleId)) continue; // already held (manual or jit) — leave it
    await RoleAssignment.updateOne(
      { userId, roleId },
      { $setOnInsert: { userId, roleId, organizationId: oid, source: 'jit' } },
      { upsert: true, session },
    );
    added.push(roleId);
  }

  // Removals: JIT-owned rows the mapping no longer names. Manual rows and the
  // built-in Member floor (granted by ensureBaselineRole, hence manual) stay.
  const stale = held
    .filter((a) => (a as { source?: string }).source === 'jit' && !wanted.has(String(a.roleId)))
    .map((a) => a.roleId);
  if (stale.length > 0) {
    await RoleAssignment.deleteMany({ userId, organizationId: oid, roleId: { $in: stale }, source: 'jit' }, { session });
  }

  return { added, removed: stale.map(String) };
}
