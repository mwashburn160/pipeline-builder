// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The BUILT-IN Role lifecycle: seeding a new org's Roles, keeping the cached
 * coarse `UserOrganization.role` in step with the Roles a user actually holds,
 * and the Member / Admin floor that every membership path relies on.
 *
 * This file is the base of the RBAC service surface; the rest of it lives in
 * siblings that build on these:
 *   - `role-authority.ts`        — what a grant confers + the actor ceilings;
 *   - `role-crud.ts`             — custom-Role CRUD and Role membership;
 *   - `platform-admin-roles.ts`  — the cross-tenant superadmin grant/revoke;
 *   - `mapped-roles.ts`          — directory-driven grants (IdP groups, SCIM);
 *   - `service-account-roles.ts` — the same Role model for machine principals.
 * They import from here, never the other way round, so there is no cycle.
 */

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { assertActorMayAssignRole, builtinRolePermissions } from './role-authority.js';
import type { OrgId, RoleAssignmentActor, UserId } from './role-authority.js';
import { Role, RoleAssignment, User, UserOrganization } from '../models/index.js';
import type { RoleGrant, RoleSeedBundle } from '../models/index.js';

const logger = createLogger('roles-service');

/** A Role with its current members, for the management UI. */
export interface RoleWithMembers {
  id: string;
  name: string;
  description?: string;
  grantsRole: RoleGrant;
  /** Fine-grained permissions this Role grants (empty for role-only Roles). */
  permissions: string[];
  system: boolean;
  members: Array<{ id: string; username: string; email: string }>;
}

/** A built-in Role to seed. `seedBundle` names a bundle that replaces the
 *  `grantsRole` one (see `builtinRolePermissions`). */
interface BuiltinRoleSpec { name: string; grantsRole: RoleGrant; seedBundle?: RoleSeedBundle }

/** Default Roles seeded into every new org. The system org also gets the
 *  Super Admin Role (prepended) and the Ecosystem Manager Role (appended) —
 *  see {@link seedDefaultRoles}. */
const DEFAULT_ROLES: BuiltinRoleSpec[] = [
  { name: 'Admin', grantsRole: 'admin' },
  { name: 'Member', grantsRole: 'member' },
];
const SUPERADMINS_ROLE: BuiltinRoleSpec = { name: 'Super Admin', grantsRole: 'superadmin' };
/** The system org's ecosystem-governance Role (docs/permissions.md): the coarse `member` grant (no admin over the system org, never
 *  `isSuperAdmin`) plus api-core `ECOSYSTEM_MANAGER_PERMISSIONS`. Assignable
 *  only by a platform superadmin; the org creator is NOT added to it. */
export const ECOSYSTEM_MANAGER_ROLE_NAME = 'Ecosystem Manager';
const ECOSYSTEM_MANAGER_ROLE: BuiltinRoleSpec = {
  name: ECOSYSTEM_MANAGER_ROLE_NAME,
  grantsRole: 'member',
  seedBundle: 'ecosystem_manager',
};

/**
 * Seed the default permission Roles for a freshly-created org and assign the
 * creator the right Role(s). For a normal org: Admin + Member,
 * creator → Admin. For the **system** org: also Super Admin and Ecosystem
 * Manager (never seeded anywhere else), and the creator joins
 * **Super Admin + Admin** (not Ecosystem Manager) and is flagged
 * `User.isSuperAdmin` (this is how the bootstrap user becomes a platform admin
 * via Roles). The creator's `UserOrganization.role` stays `owner` — owner
 * ranks above any Role-granted role.
 */
export async function seedDefaultRoles(
  organizationId: OrgId,
  creatorUserId: UserId,
  opts: { isSystemOrg?: boolean } = {},
  session?: mongoose.ClientSession,
): Promise<void> {
  const specs = opts.isSystemOrg
    ? [SUPERADMINS_ROLE, ...DEFAULT_ROLES, ECOSYSTEM_MANAGER_ROLE]
    : DEFAULT_ROLES;

  const created = await Role.create(
    // Each built-in Role is seeded WITH its own explicit permission bundle
    // (Admin/Super Admin → admin bundle, Member → member bundle, Ecosystem
    // Manager → its named bundle) so a fresh org's Roles are self-describing —
    // the runtime resolver reads a Role's own `permissions[]`, never a
    // role-derived baseline.
    specs.map((s) => ({
      organizationId,
      name: s.name,
      grantsRole: s.grantsRole,
      permissions: builtinRolePermissions(s),
      system: true,
      ...(s.seedBundle ? { seedBundle: s.seedBundle } : {}),
    })),
    { session, ordered: true },
  );
  // Key built-in Roles by their stable `grantsRole` (not the display name) so the
  // creator-join logic is independent of the human-facing Role names. Named-bundle
  // Roles (Ecosystem Manager) are excluded: the creator never joins them, and
  // they share `grantsRole: 'member'` with the Member Role.
  const byGrant = new Map(created.filter((g) => !g.seedBundle).map((g) => [g.grantsRole, g]));

  const joinGrants: RoleGrant[] = opts.isSystemOrg ? ['superadmin', 'admin'] : ['admin'];
  const assignments = joinGrants
    .map((gr) => byGrant.get(gr))
    .filter((g): g is NonNullable<typeof g> => !!g)
    .map((g) => ({ userId: creatorUserId, roleId: g._id, organizationId }));
  if (assignments.length > 0) await RoleAssignment.create(assignments, { session, ordered: true });

  // The Super Admin assignment confers the platform-wide flag.
  if (opts.isSystemOrg) {
    await User.updateOne({ _id: creatorUserId }, { $set: { isSuperAdmin: true } }, { session });
  }

  logger.info('Seeded default Roles', {
    organizationId: String(organizationId),
    roles: specs.map((s) => s.name),
  });
}

/**
 * Recompute the cached `UserOrganization.role` for a user from their Role
 * assignments in an org — called after Role assignment changes so the rest of
 * the authz path (JWT role, requireRole, canAdministerOrg) keeps reading a
 * single role string. `owner` is preserved (it outranks any Role grant). A
 * `superadmin`-granting Role also sets `User.isSuperAdmin`.
 */
export async function recomputeUserOrgRole(
  userId: UserId,
  organizationId: OrgId,
  session?: mongoose.ClientSession,
): Promise<void> {
  const assignments = await RoleAssignment.find({ userId, organizationId })
    .session(session ?? null).select('roleId').lean();
  const roleIds = assignments.map((m) => m.roleId);
  const roles = roleIds.length > 0
    ? await Role.find({ _id: { $in: roleIds } }).session(session ?? null).select('grantsRole').lean()
    : [];
  const grants = new Set(roles.map((g) => g.grantsRole));
  const isSuperadmin = grants.has('superadmin');
  const roleGrant: 'admin' | 'member' = (isSuperadmin || grants.has('admin')) ? 'admin' : 'member';

  // Track whether this recompute actually flips an effective privilege, so we
  // only invalidate the user's tokens when something real changed.
  let privilegeChanged = false;

  const membership = await UserOrganization.findOne({ userId, organizationId }).session(session ?? null);
  if (membership && membership.role !== 'owner' && membership.role !== roleGrant) {
    membership.role = roleGrant;
    await membership.save({ session });
    privilegeChanged = true;
  }

  // isSuperAdmin is authoritative only within an org that defines a superadmin
  // Role (i.e. the system org). There, Role assignment both GRANTS and REVOKES
  // the platform flag (removed from Super Admin → demoted). Orgs with no such
  // Role never touch the flag. Read the current value first so we write (and
  // count it as a change) only on a genuine flip.
  const orgHasSuperadminRole = await Role.exists({ organizationId, grantsRole: 'superadmin' }).session(session ?? null);
  if (orgHasSuperadminRole) {
    const current = await User.findById(userId).select('+isSuperAdmin').session(session ?? null);
    if (current && (current.isSuperAdmin === true) !== isSuperadmin) {
      await User.updateOne({ _id: userId }, { $set: { isSuperAdmin: isSuperadmin } }, { session });
      privilegeChanged = true;
    }
  }

  // A real privilege change must take effect immediately, not at token
  // expiry. Bumping claimsVersion makes every service reject the user's existing
  // ACCESS tokens; their refresh token stays valid (it carries only the hard
  // tokenVersion), so the next refresh reissues a JWT carrying the new
  // role/flag — no sign-in. (A removal/deactivation is different: that bumps
  // tokenVersion and drops the slots — the session ENDS.) No bump when nothing
  // flipped (e.g. assigned a member-only Role, or a no-op re-assign).
  if (privilegeChanged) {
    await User.updateOne({ _id: userId }, { $inc: { claimsVersion: 1 } }, { session });
  }
}

/**
 * Ensure a user holds the org's built-in **Member** Role, then recompute their
 * cached org role.
 *
 * Single-source model: a user's effective permissions are EXACTLY the union of
 * the Roles assigned to them — there is no role-derived baseline. So a plain
 * member with no Role would resolve to ZERO permissions. Every path that creates
 * a new plain-member org membership calls this to make the Member floor explicit.
 *
 * The built-in Member Role is located by its stable `grantsRole: 'member'` (not
 * its display name), so renaming Roles never breaks this; `seedBundle: null`
 * excludes the system org's Ecosystem Manager, which shares that grant. Idempotent: the
 * assignment is upserted (`$setOnInsert`), so re-invocation is a no-op. Holding
 * the Member Role alongside a higher Role (Admin) is fine — {@link recomputeUserOrgRole}
 * still derives the highest `grantsRole`, so a user in both keeps `admin`. No-op
 * (with a warning) if the org has no built-in Member Role, which should never
 * happen (every org is seeded with it).
 */
export async function ensureBaselineRole(
  userId: UserId,
  organizationId: OrgId,
  session?: mongoose.ClientSession,
): Promise<void> {
  const memberRole = await Role.findOne({ organizationId, grantsRole: 'member', system: true, seedBundle: null })
    .session(session ?? null).select('_id').lean();
  if (!memberRole) {
    logger.warn('ensureBaselineRole: org has no built-in Member Role; baseline Role not applied', {
      organizationId: String(organizationId),
    });
    return;
  }
  await RoleAssignment.updateOne(
    { userId, roleId: memberRole._id },
    { $setOnInsert: { userId, roleId: memberRole._id, organizationId } },
    { upsert: true, session },
  );
  await recomputeUserOrgRole(userId, organizationId, session);
}

/**
 * Idempotently assign an org's built-in **Admin** Role to a user (upsert). Used
 * by the admin-facing create/update paths to grant coarse-admin THROUGH a Role
 * assignment rather than by setting `UserOrganization.role` directly — under
 * single-source RBAC the cached coarse role is DERIVED from assigned Roles, so a
 * direct `role='admin'` gives coarse-admin with zero permissions and is reverted
 * by the next {@link recomputeUserOrgRole}.
 *
 * The Admin Role is located by its stable `grantsRole: 'admin', system: true`
 * (name-independent). Does NOT recompute — the caller recomputes once after any
 * companion Role changes (e.g. the Member floor). No-op (with a warning, returns
 * false) if the org has no built-in Admin Role, which should never happen.
 */
export async function assignBuiltinAdminRole(
  userId: UserId,
  organizationId: OrgId,
  session?: mongoose.ClientSession,
): Promise<boolean> {
  const adminRole = await Role.findOne({ organizationId, grantsRole: 'admin', system: true })
    .session(session ?? null).select('_id').lean();
  if (!adminRole) {
    logger.warn('assignBuiltinAdminRole: org has no built-in Admin Role; admin Role not applied', {
      organizationId: String(organizationId),
    });
    return false;
  }
  await RoleAssignment.updateOne(
    { userId, roleId: adminRole._id },
    { $setOnInsert: { userId, roleId: adminRole._id, organizationId } },
    { upsert: true, session },
  );
  return true;
}

/**
 * Assignment ceiling for granting or revoking an org's built-in Admin Role
 * outside the Role-membership API (e.g. `PUT /users/:id { role }`): a caller who
 * is neither a platform superadmin nor an admin/owner of the org must hold every
 * permission the Admin Role grants — otherwise a delegate holding only
 * `members:manage` could promote anyone, themselves included, to Admin. Throws
 * `RL_ASSIGN_EXCEEDS_CEILING`.
 */
export async function assertActorMayAssignBuiltinAdmin(
  organizationId: OrgId,
  actor: RoleAssignmentActor,
  session?: mongoose.ClientSession,
): Promise<void> {
  if (actor.isSuperAdmin || actor.isOrgAdmin) return;
  const adminRole = await Role.findOne({ organizationId, grantsRole: 'admin', system: true })
    .session(session ?? null).select('permissions').lean();
  assertActorMayAssignRole(adminRole?.permissions as string[] | undefined, actor);
}

/**
 * Idempotently REMOVE an org's built-in **Admin** Role assignment from a user
 * (the demote counterpart of {@link assignBuiltinAdminRole}). Does NOT recompute
 * — the caller recomputes once (typically after re-asserting the Member floor).
 * No-op if the org has no built-in Admin Role or the user never held it.
 */
export async function removeBuiltinAdminRole(
  userId: UserId,
  organizationId: OrgId,
  session?: mongoose.ClientSession,
): Promise<void> {
  const adminRole = await Role.findOne({ organizationId, grantsRole: 'admin', system: true })
    .session(session ?? null).select('_id').lean();
  if (!adminRole) return;
  await RoleAssignment.deleteOne({ userId, roleId: adminRole._id }, { session });
}
