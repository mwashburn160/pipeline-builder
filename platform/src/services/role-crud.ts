// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom-Role CRUD and Role MEMBERSHIP.
 *
 * Everything a person does to a Role through the management UI: list them with
 * their members, read a user's resolved permissions, create / update / delete a
 * custom Role, and add or remove a member. Every write here runs the actor
 * ceiling from `role-authority.ts` first, and every membership change ends in
 * `recomputeUserOrgRole` so the cached coarse role can't drift from the Roles
 * actually assigned.
 *
 * Split out of `roles-service.ts`, which keeps the built-in Role lifecycle
 * (seeding, the Member floor, the built-in Admin grant) that these build on.
 */

import { createLogger, isValidPermission } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import {
  assertActorMayAssignRole,
  assertSystemOrgOnlyRoleInSystemOrg,
  carriesSystemOrgOnlyPermission,
  sanitizePermissions,
} from './role-authority.js';
import type { ActorPermissionCeiling, OrgId, RoleAssignmentActor, UserId } from './role-authority.js';
import {
  RL_CANNOT_REMOVE_SELF,
  RL_LAST_PRIVILEGED_MEMBER,
  RL_NAME_TAKEN,
  RL_NOT_ORG_MEMBER,
  RL_REQUIRES_SUPERADMIN,
  RL_ROLE_NOT_FOUND,
  RL_SYSTEM_IMMUTABLE,
  RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN,
  RL_USER_NOT_FOUND,
} from './roles-errors.js';
import { recomputeUserOrgRole } from './roles-service.js';
import type { RoleWithMembers } from './roles-service.js';
import { toOrgId } from '../helpers/org-id.js';
import { publishUserRevocation, publishUsersRevocation } from '../helpers/session-revocation.js';
import { Role, RoleAssignment, User, UserOrganization } from '../models/index.js';
import type { RoleGrant } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('role-crud');

/**
 * List an org's Roles, each with its current members (for the management UI).
 *
 * `page` pages the ROLES (stable order: built-in grant level, then name) and
 * only the members of that page's Roles are loaded. Without `page` every Role
 * is returned — the pickers (service-account roles, group mappings, member
 * role editors) need the whole set to offer a choice. `total` always counts
 * every Role in the org.
 */
export async function listRolesWithMembers(
  orgId: string,
  page?: { limit: number; offset: number },
): Promise<{ roles: RoleWithMembers[]; total: number }> {
  const oid = toOrgId(orgId);
  let query = Role.find({ organizationId: oid }).sort({ grantsRole: 1, name: 1 });
  if (page) query = query.skip(page.offset).limit(page.limit);
  const [roles, total] = await Promise.all([
    query.lean(),
    Role.countDocuments({ organizationId: oid }),
  ]);
  if (roles.length === 0) return { roles: [], total };
  const assignments = await RoleAssignment.find({ organizationId: oid, roleId: { $in: roles.map((r) => r._id) } })
    .populate<{ userId: { _id: mongoose.Types.ObjectId; username: string; email: string } }>(
      { path: 'userId', select: '_id username email' },
    )
    .lean();

  const byRole = new Map<string, RoleWithMembers['members']>();
  for (const m of assignments) {
    const u = m.userId as unknown as { _id: mongoose.Types.ObjectId; username: string; email: string } | null;
    if (!u || !u._id) continue; // assignment for a deleted user — skip
    const key = String(m.roleId);
    const list = byRole.get(key) ?? [];
    list.push({ id: String(u._id), username: u.username, email: u.email });
    byRole.set(key, list);
  }

  return {
    roles: roles.map((g) => ({
      id: String(g._id),
      name: g.name,
      ...(g.description ? { description: g.description as string } : {}),
      grantsRole: g.grantsRole as RoleGrant,
      permissions: (g.permissions as string[]) ?? [],
      system: !!g.system,
      members: byRole.get(String(g._id)) ?? [],
    })),
    total,
  };
}

/**
 * Flattened, deduped fine-grained permissions granted to a user by the Roles
 * they hold in an org/team. Single-source model: this union IS the user's
 * effective permission set at token-issue time (`resolveUserPermissions` in
 * api-core; superadmin ⇒ all) — there is no role-derived baseline.
 * Invalid/stale permission strings are dropped.
 */
export async function getUserRolePermissions(
  userId: UserId,
  organizationId: OrgId,
  session?: mongoose.ClientSession,
): Promise<string[]> {
  const assignments = await RoleAssignment.find({ userId, organizationId })
    .session(session ?? null).select('roleId').lean();
  const roleIds = assignments.map((m) => m.roleId);
  if (roleIds.length === 0) return [];
  const roles = await Role.find({ _id: { $in: roleIds } })
    .session(session ?? null).select('permissions').lean();
  const perms = new Set<string>();
  for (const g of roles) {
    for (const p of ((g.permissions as string[]) ?? [])) {
      if (isValidPermission(p)) perms.add(p);
    }
  }
  return [...perms];
}

/**
 * Create a custom, user-defined permission Role in an org/team. Custom Roles
 * never confer a base role (`grantsRole` stays `'member'`) — they only ADD
 * fine-grained permissions. Names are unique per org.
 *
 * `actor` is the caller's permission ceiling: a non-superadmin may only grant
 * permissions they themselves hold (prevents self-escalation via a delegated
 * `roles:manage`). Superadmins bypass the ceiling.
 * Throws `RL_NAME_TAKEN`, `RL_INVALID_PERMISSION`, `RL_PERMISSION_NOT_ASSIGNABLE`,
 * `RL_PERMISSION_EXCEEDS_CEILING`.
 */
export async function createRole(
  orgId: string,
  input: { name: string; description?: string; permissions?: string[] },
  actor: ActorPermissionCeiling,
): Promise<RoleWithMembers> {
  const oid = toOrgId(orgId);
  const name = input.name.trim();
  const permissions = sanitizePermissions(input.permissions ?? [], actor);

  const existing = await Role.findOne({ organizationId: oid, name }).select('_id').lean();
  if (existing) throw new Error(RL_NAME_TAKEN);

  const role = await Role.create({
    organizationId: oid,
    name,
    ...(input.description ? { description: input.description.trim() } : {}),
    grantsRole: 'member',
    permissions,
    system: false,
  });
  logger.info('Created custom Role', { organizationId: orgId, roleId: String(role._id), name, permissions });
  return {
    id: String(role._id),
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    grantsRole: role.grantsRole as RoleGrant,
    permissions,
    system: false,
    members: [],
  };
}

/**
 * Update a custom Role's name/description/permissions. Seeded (`system`)
 * Roles are immutable here. Bumps `tokenVersion` for every current member when
 * permissions change so the new grants take effect on their next token refresh.
 *
 * `actor` is the caller's permission ceiling, applied in BOTH directions:
 * - the INCOMING set must be within the permissions the actor holds, so a
 *   delegate can't grant themselves something they lack (`sanitizePermissions`);
 * - the role's EXISTING set must also be within it, so a delegate can't STRIP a
 *   capability they don't hold from every member (`assertActorMayAssignRole`).
 *
 * The second direction is the one `deleteRole` documents: without it, the same
 * griefing vector is simply reachable through update instead of delete — a
 * `roles:manage` holder could rewrite a `billing:manage` role down to
 * `roles:manage` and revoke that capability org-wide.
 *
 * Throws `RL_ROLE_NOT_FOUND`, `RL_SYSTEM_IMMUTABLE`, `RL_NAME_TAKEN`,
 * `RL_INVALID_PERMISSION`, `RL_PERMISSION_NOT_ASSIGNABLE`,
 * `RL_PERMISSION_EXCEEDS_CEILING`, `RL_ASSIGN_EXCEEDS_CEILING`.
 */
export async function updateRole(
  orgId: string,
  roleId: string,
  input: { name?: string; description?: string; permissions?: string[] },
  actor: RoleAssignmentActor,
): Promise<RoleWithMembers> {
  const oid = toOrgId(orgId);
  const role = await Role.findOne({ _id: roleId, organizationId: oid });
  if (!role) throw new Error(RL_ROLE_NOT_FOUND);
  if (role.system) throw new Error(RL_SYSTEM_IMMUTABLE);
  // Ceiling against what the role ALREADY grants — checked before any mutation
  // so a refused edit leaves the role untouched.
  assertActorMayAssignRole(role.permissions as string[] | undefined, actor);

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name !== role.name) {
      const clash = await Role.findOne({ organizationId: oid, name, _id: { $ne: role._id } }).select('_id').lean();
      if (clash) throw new Error(RL_NAME_TAKEN);
      role.name = name;
    }
  }
  if (input.description !== undefined) role.description = input.description.trim() || undefined;

  let permsChanged = false;
  if (input.permissions !== undefined) {
    role.permissions = sanitizePermissions(input.permissions, actor);
    permsChanged = true;
  }

  // Atomic: the Role edit and the members' tokenVersion bump must commit
  // together. A crash between them would otherwise persist the new permissions
  // while leaving members' JWTs carrying the OLD grants until token expiry — a
  // stale-permission window. Mirrors how `deleteRole` already threads a session.
  let bumpedMemberIds: mongoose.Types.ObjectId[] = [];
  await withMongoTransaction(async (session) => {
    await role.save({ session });
    // Permission change must reach members' JWTs — invalidate their access tokens.
    if (permsChanged) {
      // USERS only: a service account assigned to this Role holds no session and
      // no `tokenVersion` — its next exchange (≤5 minutes) re-derives the new
      // permissions, so there is nothing to invalidate for it.
      bumpedMemberIds = (await RoleAssignment.find({ roleId, userId: { $ne: null } }).session(session).select('userId').lean())
        .map((m) => m.userId)
        .filter((id): id is mongoose.Types.ObjectId => !!id);
      if (bumpedMemberIds.length > 0) {
        await User.updateMany({ _id: { $in: bumpedMemberIds } }, { $inc: { tokenVersion: 1 } }, { session });
      }
    }
  });
  // Post-commit: publish the members' now-current tokenVersion so the stateless
  // services reject their in-flight tokens immediately (best-effort).
  await publishUsersRevocation(bumpedMemberIds);

  logger.info('Updated custom Role', { organizationId: orgId, roleId, permsChanged });
  return {
    id: String(role._id),
    name: role.name,
    ...(role.description ? { description: role.description } : {}),
    grantsRole: role.grantsRole as RoleGrant,
    permissions: role.permissions ?? [],
    system: !!role.system,
    members: [],
  };
}

/**
 * Delete a custom Role and all its assignments, bumping `tokenVersion` for each
 * affected member. Seeded (`system`) Roles can't be deleted.
 * Throws `RL_ROLE_NOT_FOUND`, `RL_SYSTEM_IMMUTABLE`.
 */
export async function deleteRole(orgId: string, roleId: string, actor: RoleAssignmentActor): Promise<void> {
  const oid = toOrgId(orgId);
  const role = await Role.findOne({ _id: roleId, organizationId: oid }).select('system permissions');
  if (!role) throw new Error(RL_ROLE_NOT_FOUND);
  if (role.system) throw new Error(RL_SYSTEM_IMMUTABLE);
  // Apply the same actor ceiling as add/remove-member and create/update: a
  // delegated non-admin (e.g. a custom `roles:manage` holder) must not delete a
  // Role granting permissions beyond their own set — otherwise they could strip
  // capabilities they don't hold (e.g. billing:manage) from every member, a
  // griefing/privilege vector the symmetric remove-member path already blocks.
  // Superadmins and org admins/owners bypass (they hold the full bundle).
  assertActorMayAssignRole(role.permissions as string[] | undefined, actor);

  let bumpedMemberIds: mongoose.Types.ObjectId[] = [];
  await withMongoTransaction(async (session) => {
    // Users only — see the note in `updateRole`; a service account's exchange
    // re-derives its (now absent) permissions on its own.
    bumpedMemberIds = (await RoleAssignment.find({ roleId, userId: { $ne: null } }).session(session).select('userId').lean())
      .map((m) => m.userId)
      .filter((id): id is mongoose.Types.ObjectId => !!id);
    await RoleAssignment.deleteMany({ roleId }, { session });
    await Role.deleteOne({ _id: roleId }, { session });
    if (bumpedMemberIds.length > 0) {
      await User.updateMany({ _id: { $in: bumpedMemberIds } }, { $inc: { tokenVersion: 1 } }, { session });
    }
  });
  // Post-commit: publish the affected members' now-current tokenVersion.
  await publishUsersRevocation(bumpedMemberIds);
  logger.info('Deleted custom Role', { organizationId: orgId, roleId });
}

/**
 * Assign an existing org member to a Role (idempotent), then recompute their
 * cached org role. The user must already be a member of the org — Roles grant
 * capabilities within an org, they don't create org membership.
 *
 * `actor` is the caller's assignment context: their platform-superadmin status,
 * org admin/owner status, and resolved fine-grained permissions. Two ceilings
 * are enforced from it:
 *   - The `superadmin`-granting Role (the Super Admin Role in the system org)
 *     may only be assigned by a platform superadmin — otherwise any org
 *     admin/owner of the system org could assign themselves Super Admin and have
 *     `recomputeUserOrgRole` flip `User.isSuperAdmin` (platform escalation).
 *   - Every OTHER Role is subject to the permission ceiling (see
 *     {@link assertActorMayAssignRole}): a non-admin delegate holding only
 *     `roles:manage` may assign a Role ONLY if the Role's granted permissions
 *     are all within the actor's own set — closing the within-tenant escalation
 *     of assigning the built-in Admin Role (full `ADMIN_PERMISSIONS`) to gain
 *     capabilities the actor lacks. Admin/owner and superadmin bypass it.
 *   - A Role carrying a system-org-only permission (the system org's Ecosystem
 *     Manager) may only be assigned by a platform superadmin
 *     (`RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN`, inside the ceiling) and only
 *     inside the system org (`RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG`).
 *
 * Throws `RL_ROLE_NOT_FOUND` / `RL_USER_NOT_FOUND` / `RL_NOT_ORG_MEMBER` /
 * `RL_REQUIRES_SUPERADMIN` / `RL_ASSIGN_EXCEEDS_CEILING` /
 * `RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN` / `RL_SYSTEM_ORG_ROLE_OUTSIDE_SYSTEM_ORG`.
 */
export async function addUserToRole(
  orgId: string,
  roleId: string,
  target: { userId?: string; email?: string },
  actor: RoleAssignmentActor,
): Promise<{ userId: string }> {
  const oid = toOrgId(orgId);

  const role = await Role.findOne({ _id: roleId, organizationId: oid });
  if (!role) throw new Error(RL_ROLE_NOT_FOUND);

  // Role-ceiling: granting a superadmin-conferring Role requires the actor to
  // already be a platform superadmin. (Admin-granting Roles stay delegated to
  // org admins — that's in-org delegation, not platform escalation.)
  if (role.grantsRole === 'superadmin' && !actor.isSuperAdmin) {
    throw new Error(RL_REQUIRES_SUPERADMIN);
  }

  // Permission ceiling: a non-admin delegate can't ASSIGN a Role granting
  // capabilities beyond their own effective set (mirror of the create/update
  // ceiling `sanitizePermissions` enforces). Prevents a `roles:manage` holder
  // from self-granting Admin's `members:manage`/`org:settings`/`billing:manage`.
  // Also refuses a non-superadmin on an ecosystem (system-org-only) Role.
  assertActorMayAssignRole(role.permissions as string[] | undefined, actor);
  assertSystemOrgOnlyRoleInSystemOrg(role.permissions as string[] | undefined, oid);

  const user = target.userId
    ? await User.findById(target.userId).select('_id')
    : await User.findOne({ email: target.email?.toLowerCase() }).select('_id');
  if (!user) throw new Error(RL_USER_NOT_FOUND);

  const member = await UserOrganization.findOne({ userId: user._id, organizationId: oid }).select('_id');
  if (!member) throw new Error(RL_NOT_ORG_MEMBER);

  // Atomic: the assignment write and the cached-role/isSuperAdmin recompute must
  // commit together. A crash between them would otherwise leave the assignment
  // added but the effective role/flag stale (a silent privilege change).
  await withMongoTransaction(async (session) => {
    // `source: 'manual'` is $set, not $setOnInsert: an admin explicitly granting
    // a Role the IdP happened to map TAKES OVER the row, so a later group sync
    // can no longer take it away (the "manual Roles are never removed by a sync"
    // guarantee — see models/role-assignment.ts).
    await RoleAssignment.updateOne(
      { userId: user._id, roleId },
      {
        $setOnInsert: { userId: user._id, roleId, organizationId: oid },
        $set: { source: 'manual' },
      },
      { upsert: true, session },
    );
    await recomputeUserOrgRole(user._id, oid, session);
    // An assignment change alters the user's effective PERMISSIONS (carried in the
    // JWT), even when the cached role doesn't flip (custom permission-only Role).
    // Bump tokenVersion so a refresh reissues a token with the new grants.
    await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } }, { session });
  });
  // Post-commit: publish the user's now-current tokenVersion.
  await publishUserRevocation(String(user._id));

  logger.info('Assigned user to Role', { organizationId: orgId, roleId, userId: String(user._id) });
  return { userId: String(user._id) };
}

/**
 * The name of `roleId` in `orgId` when it is an ecosystem-governance Role (one
 * carrying a system-org-only permission — the system org's "Ecosystem
 * Manager"), else `undefined`. Membership changes to such a Role are audited
 * with `details.role` (docs/plans/plugin-ecosystem.md §5c) and announced as N23.
 */
export async function ecosystemRoleName(orgId: string, roleId: string): Promise<string | undefined> {
  const role = await Role.findOne({ _id: roleId, organizationId: toOrgId(orgId) }).select('name permissions').lean();
  if (!role || !carriesSystemOrgOnlyPermission(role.permissions as string[] | undefined)) return undefined;
  return role.name as string;
}

/**
 * Lockout guard: throw `RL_LAST_PRIVILEGED_MEMBER` if removing `userId` from a
 * privilege-granting (admin/superadmin) Role would leave that Role with no
 * members — deleting the sole Super Admin, or an org's last Admin, locks
 * everyone out. Checks the user's assignment to `roleId`, or to EVERY Role they
 * hold when `roleId` is omitted (account deletion). Member-only Roles are
 * unguarded — losing them revokes nothing.
 *
 * Runs inside the caller's transaction so it reads a snapshot consistent with
 * the removal. Three queries regardless of how many Roles the user holds.
 * (Residual: distinct-doc deletes don't write-conflict under WiredTiger, so a
 * fully concurrent removal of both members of a two-member Role can still slip
 * through; the in-transaction read closes the common window.)
 */
export async function assertNotLastPrivilegedMember(
  session: mongoose.ClientSession,
  userId: UserId,
  roleId?: string | mongoose.Types.ObjectId,
): Promise<void> {
  const held = await RoleAssignment.find(roleId === undefined ? { userId } : { userId, roleId })
    .select('roleId').session(session).lean();
  if (held.length === 0) return;
  const privileged = await Role.find({ _id: { $in: held.map((a) => a.roleId) }, grantsRole: { $ne: 'member' } })
    .select('_id').session(session).lean();
  if (privileged.length === 0) return;
  const counts = await RoleAssignment.aggregate<{ _id: unknown; members: number }>([
    { $match: { roleId: { $in: privileged.map((r) => r._id) } } },
    { $group: { _id: '$roleId', members: { $sum: 1 } } },
  ]).session(session);
  if (counts.some((c) => c.members <= 1)) throw new Error(RL_LAST_PRIVILEGED_MEMBER);
}

/**
 * Remove a user from a Role, then recompute their cached org role. Within the
 * system org, removing the last `superadmin`-granting assignment also clears
 * `User.isSuperAdmin` (handled by {@link recomputeUserOrgRole}).
 *
 * Lockout guards on privilege-granting Roles (Admin / Super Admin):
 *   - G2: you can't remove YOURSELF from one (`actorUserId` === target).
 *   - G3: you can't remove the LAST member of one (would leave it empty).
 * Member-only Roles (the built-in Member Role) are unguarded — losing them revokes nothing.
 *
 * Removing a member of a `superadmin`-granting Role requires the caller to be
 * a platform superadmin (`opts.actorIsSuperAdmin`) — otherwise a system-org
 * admin could strip `User.isSuperAdmin` from real superadmins via the recompute.
 *
 * Permission ceiling (symmetry with {@link addUserToRole}): a non-admin delegate
 * (holding only `roles:manage`) may only change membership of a Role whose
 * granted permissions are all within their own set — they can't strip protection
 * from, or grief the membership of, a Role carrying capabilities they lack (e.g.
 * the built-in Admin Role). Admin/owner (`opts.actorIsOrgAdmin`) and superadmin
 * bypass it. When the actor context is not supplied (`actorPermissions` omitted)
 * the ceiling is not evaluated — internal callers that already gate authority
 * upstream (e.g. `revokePlatformAdmin`) keep working.
 *
 * Throws `RL_ROLE_NOT_FOUND`, `RL_REQUIRES_SUPERADMIN`,
 * `RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN`, `RL_ASSIGN_EXCEEDS_CEILING`,
 * `RL_CANNOT_REMOVE_SELF`, `RL_LAST_PRIVILEGED_MEMBER`.
 */
export async function removeUserFromRole(
  orgId: string,
  roleId: string,
  userId: string,
  opts: {
    actorUserId?: string;
    actorIsSuperAdmin?: boolean;
    actorIsOrgAdmin?: boolean;
    actorPermissions?: readonly string[];
  } = {},
): Promise<void> {
  const oid = toOrgId(orgId);

  const role = await Role.findOne({ _id: roleId, organizationId: oid }).select('grantsRole name permissions');
  if (!role) throw new Error(RL_ROLE_NOT_FOUND);

  // Role-ceiling: only a platform superadmin may change assignment of a
  // superadmin-granting Role (mirror of the gate in addUserToRole).
  if (role.grantsRole === 'superadmin' && !opts.actorIsSuperAdmin) {
    throw new Error(RL_REQUIRES_SUPERADMIN);
  }
  // Unassigning an ecosystem (system-org-only) Role is superadmin-only too —
  // checked unconditionally, not only when the actor context is supplied.
  if (carriesSystemOrgOnlyPermission(role.permissions as string[] | undefined) && !opts.actorIsSuperAdmin) {
    throw new Error(RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN);
  }

  // Permission ceiling (symmetry with addUserToRole): a delegate can't touch
  // membership of a Role granting permissions beyond their own. Evaluated only
  // when the caller supplies the actor's permission context.
  if (opts.actorPermissions !== undefined) {
    assertActorMayAssignRole(role.permissions as string[] | undefined, {
      isSuperAdmin: opts.actorIsSuperAdmin === true,
      isOrgAdmin: opts.actorIsOrgAdmin === true,
      permissions: opts.actorPermissions,
    });
  }

  // Atomic: the lockout guards, the assignment delete and the role/isSuperAdmin
  // recompute run in one transaction, so the guards read a snapshot consistent
  // with the delete and a crash can't leave the user removed from the Role but
  // still carrying the Role's cached role or platform-admin flag.
  await withMongoTransaction(async (session) => {
    // Only meaningful if the user actually holds a privilege-granting Role — a
    // no-op remove of a non-member must not trip the guards.
    if (role.grantsRole !== 'member' && await RoleAssignment.exists({ userId, roleId }).session(session)) {
      // G2: self-removal from a Role granting your own admin/superadmin.
      if (opts.actorUserId && String(opts.actorUserId) === String(userId)) {
        throw new Error(RL_CANNOT_REMOVE_SELF);
      }
      // G3: never empty an admin/superadmin-granting Role.
      await assertNotLastPrivilegedMember(session, userId, roleId);
    }
    await RoleAssignment.deleteOne({ userId, roleId }, { session });
    await recomputeUserOrgRole(userId, oid, session);
    // Assignment change alters effective permissions (JWT) — force a reissue.
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }, { session });
  });
  // Post-commit: publish the user's now-current tokenVersion.
  await publishUserRevocation(String(userId));

  logger.info('Removed user from Role', { organizationId: orgId, roleId, userId });
}
