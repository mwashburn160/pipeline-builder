// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, isOrgAssignablePermission, isValidPermission, ROLE_PERMISSIONS, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { toOrgId } from '../helpers/controller-helper.js';
import { publishUserRevocation, publishUsersRevocation } from '../helpers/session-revocation.js';
import { Role, RoleAssignment, User, UserOrganization } from '../models/index.js';
import type { RoleGrant } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('roles-service');

export const RL_ROLE_NOT_FOUND = 'RL_ROLE_NOT_FOUND';
export const RL_USER_NOT_FOUND = 'RL_USER_NOT_FOUND';
export const RL_NOT_ORG_MEMBER = 'RL_NOT_ORG_MEMBER';
/** You can't remove yourself from a Role that grants your own admin/superadmin. */
export const RL_CANNOT_REMOVE_SELF = 'RL_CANNOT_REMOVE_SELF';
/** Removing this user would leave a privilege-granting Role with no members. */
export const RL_LAST_PRIVILEGED_MEMBER = 'RL_LAST_PRIVILEGED_MEMBER';
/** Only a platform superadmin may add/remove members of a `superadmin`-granting
 *  Role — otherwise a mere org admin of the system org could mint or strip
 *  platform superadmins via `recomputeUserOrgRole`. */
export const RL_REQUIRES_SUPERADMIN = 'RL_REQUIRES_SUPERADMIN';
/** Seeded (`system`) Roles can't be renamed/edited/deleted via the CRUD API. */
export const RL_SYSTEM_IMMUTABLE = 'RL_SYSTEM_IMMUTABLE';
/** Another Role in the org already uses this name. */
export const RL_NAME_TAKEN = 'RL_NAME_TAKEN';
/** A supplied permission string isn't in the api-core catalog. */
export const RL_INVALID_PERMISSION = 'RL_INVALID_PERMISSION';
/** A supplied permission is valid but NOT assignable through a user-authored
 *  custom Role — it's superadmin-only (the shared image registry:
 *  `registry:read`/`registry:write`). Built-in Role seeds are exempt (they carry
 *  it legitimately); this guards only custom-Role create/update. */
export const RL_PERMISSION_NOT_ASSIGNABLE = 'RL_PERMISSION_NOT_ASSIGNABLE';
/** The system org has no seeded Super Admin Role — platform-admin can't be
 *  granted/revoked via Role assignment (should never happen post-seed). */
export const RL_SUPERADMIN_ROLE_MISSING = 'RL_SUPERADMIN_ROLE_MISSING';

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

type OrgId = string | mongoose.Types.ObjectId;
type UserId = string | mongoose.Types.ObjectId;

/** Default Roles seeded into every new org. The system org also gets the
 *  Super Admin Role (prepended) — see {@link seedDefaultRoles}. */
const DEFAULT_ROLES: Array<{ name: string; grantsRole: RoleGrant }> = [
  { name: 'Admin', grantsRole: 'admin' },
  { name: 'Member', grantsRole: 'member' },
];
const SUPERADMINS_ROLE = { name: 'Super Admin', grantsRole: 'superadmin' as RoleGrant };

/** The built-in Role's own `permissions[]` bundle for a coarse `grantsRole`.
 *  Single-source model: a built-in Role carries its permissions EXPLICITLY
 *  (seeded from api-core `ROLE_PERMISSIONS`), so it is self-describing and the
 *  runtime resolver reads only the Role's own list. `superadmin` and `owner`
 *  both map to the full `admin` bundle. */
export function permissionsForGrantsRole(role: RoleGrant): string[] {
  return role === 'member' ? [...ROLE_PERMISSIONS.member] : [...ROLE_PERMISSIONS.admin];
}

/**
 * Seed the default permission Roles for a freshly-created org and assign the
 * creator the right Role(s). For a normal org: Admin + Member,
 * creator → Admin. For the **system** org: also Super Admin, and the
 * creator joins **Super Admin + Admin** and is flagged
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
  const specs = opts.isSystemOrg ? [SUPERADMINS_ROLE, ...DEFAULT_ROLES] : DEFAULT_ROLES;

  const created = await Role.create(
    // Each built-in Role is seeded WITH its own explicit permission bundle
    // (Admin/Super Admin → admin bundle, Member → member bundle) so a fresh org's
    // Roles are self-describing — the runtime resolver reads a Role's own
    // `permissions[]`, never a role-derived baseline.
    specs.map((s) => ({
      organizationId,
      name: s.name,
      grantsRole: s.grantsRole,
      permissions: permissionsForGrantsRole(s.grantsRole),
      system: true,
    })),
    { session, ordered: true },
  );
  // Key built-in Roles by their stable `grantsRole` (not the display name) so the
  // creator-join logic is independent of the human-facing Role names.
  const byGrant = new Map(created.map((g) => [g.grantsRole, g]));

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
  // only invalidate the user's tokens when something real changed (G1).
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

  // G1: a real privilege change must take effect immediately, not at token
  // expiry. Bumping tokenVersion makes `requireAuth` reject the user's existing
  // access tokens; a refresh then reissues a JWT carrying the new role/flag.
  // Mirrors org-members-service.updateRole/removeMember, which already do this
  // for direct edits. No bump when nothing flipped (e.g. assigned a member-only
  // Role, or a no-op re-assign).
  if (privilegeChanged) {
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }, { session });
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
 * its display name), so renaming Roles never breaks this. Idempotent: the
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
  const memberRole = await Role.findOne({ organizationId, grantsRole: 'member', system: true })
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

/**
 * Grant platform-admin by making the **system-org Super Admin Role** the source
 * of truth (single-source model): assign the user to that Role, then recompute
 * — which flips `User.isSuperAdmin` from the Role assignment and bumps
 * `tokenVersion` on a genuine change. This keeps the flag and `recomputeUserOrgRole`
 * permanently in agreement (a later recompute re-derives `isSuperAdmin=true`
 * because the assignment persists), closing the direct-flag divergence. Also
 * drops the refresh token on a real change so the session can't be re-issued.
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
      await User.updateOne({ _id: userId }, { $unset: { refreshToken: '' } }, { session });
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
 * from the now-absent assignment). Drops the refresh token on a real change.
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
      await User.updateOne({ _id: userId }, { $unset: { refreshToken: '' } }, { session });
    }
    return { changed: wasSuperadmin };
  });
  // Post-commit: on a genuine flip, recompute bumped tokenVersion — publish it.
  if (result.changed) await publishUserRevocation(String(userId));
  return result;
}

/** List an org's Roles, each with its current members (for the management UI). */
export async function listRolesWithMembers(orgId: string): Promise<RoleWithMembers[]> {
  const oid = toOrgId(orgId);
  const roles = await Role.find({ organizationId: oid }).sort({ grantsRole: 1, name: 1 }).lean();
  const assignments = await RoleAssignment.find({ organizationId: oid })
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

  return roles.map((g) => ({
    id: String(g._id),
    name: g.name,
    ...(g.description ? { description: g.description as string } : {}),
    grantsRole: g.grantsRole as RoleGrant,
    permissions: (g.permissions as string[]) ?? [],
    system: !!g.system,
    members: byRole.get(String(g._id)) ?? [],
  }));
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
 * Validate + normalize a permission list for a user-authored CUSTOM Role.
 *
 * Two gates: (1) every entry must be a known api-core permission
 * (`RL_INVALID_PERMISSION`), and (2) it must be ORG-ASSIGNABLE — the
 * superadmin-only registry permissions (`registry:read`/`registry:write`) are
 * REJECTED (`RL_PERMISSION_NOT_ASSIGNABLE`) so an org admin can't mint a Role
 * that grants a platform-operator capability. Built-in Role seeds bypass this
 * entirely (they're created directly from `ROLE_PERMISSIONS`, never through here).
 */
function sanitizePermissions(permissions: unknown): string[] {
  if (!Array.isArray(permissions)) return [];
  const out = new Set<string>();
  for (const p of permissions) {
    if (typeof p !== 'string' || !isValidPermission(p)) throw new Error(RL_INVALID_PERMISSION);
    if (!isOrgAssignablePermission(p)) throw new Error(RL_PERMISSION_NOT_ASSIGNABLE);
    out.add(p);
  }
  return [...out];
}

/**
 * Create a custom, user-defined permission Role in an org/team. Custom Roles
 * never confer a base role (`grantsRole` stays `'member'`) — they only ADD
 * fine-grained permissions. Names are unique per org.
 * Throws `RL_NAME_TAKEN`, `RL_INVALID_PERMISSION`, `RL_PERMISSION_NOT_ASSIGNABLE`.
 */
export async function createRole(
  orgId: string,
  input: { name: string; description?: string; permissions?: string[] },
): Promise<RoleWithMembers> {
  const oid = toOrgId(orgId);
  const name = input.name.trim();
  const permissions = sanitizePermissions(input.permissions ?? []);

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
 * Throws `RL_ROLE_NOT_FOUND`, `RL_SYSTEM_IMMUTABLE`, `RL_NAME_TAKEN`,
 * `RL_INVALID_PERMISSION`, `RL_PERMISSION_NOT_ASSIGNABLE`.
 */
export async function updateRole(
  orgId: string,
  roleId: string,
  input: { name?: string; description?: string; permissions?: string[] },
): Promise<RoleWithMembers> {
  const oid = toOrgId(orgId);
  const role = await Role.findOne({ _id: roleId, organizationId: oid });
  if (!role) throw new Error(RL_ROLE_NOT_FOUND);
  if (role.system) throw new Error(RL_SYSTEM_IMMUTABLE);

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
    role.permissions = sanitizePermissions(input.permissions);
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
      bumpedMemberIds = (await RoleAssignment.find({ roleId }).session(session).select('userId').lean()).map((m) => m.userId);
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
export async function deleteRole(orgId: string, roleId: string): Promise<void> {
  const oid = toOrgId(orgId);
  const role = await Role.findOne({ _id: roleId, organizationId: oid }).select('system');
  if (!role) throw new Error(RL_ROLE_NOT_FOUND);
  if (role.system) throw new Error(RL_SYSTEM_IMMUTABLE);

  let bumpedMemberIds: mongoose.Types.ObjectId[] = [];
  await withMongoTransaction(async (session) => {
    bumpedMemberIds = (await RoleAssignment.find({ roleId }).session(session).select('userId').lean()).map((m) => m.userId);
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
 * `actorIsSuperAdmin` is the caller's verified platform-superadmin status; it
 * gates assignment changes to `superadmin`-granting Roles (the Super Admin
 * Role in the system org). Without this, any org admin/owner of the system
 * org could assign themselves Super Admin and have `recomputeUserOrgRole`
 * flip `User.isSuperAdmin` — a privilege escalation to platform admin.
 *
 * Throws `RL_ROLE_NOT_FOUND` / `RL_USER_NOT_FOUND` / `RL_NOT_ORG_MEMBER` /
 * `RL_REQUIRES_SUPERADMIN`.
 */
export async function addUserToRole(
  orgId: string,
  roleId: string,
  target: { userId?: string; email?: string },
  actorIsSuperAdmin: boolean,
): Promise<{ userId: string }> {
  const oid = toOrgId(orgId);

  const role = await Role.findOne({ _id: roleId, organizationId: oid });
  if (!role) throw new Error(RL_ROLE_NOT_FOUND);

  // Role-ceiling: granting a superadmin-conferring Role requires the actor to
  // already be a platform superadmin. (Admin-granting Roles stay delegated to
  // org admins — that's in-org delegation, not platform escalation.)
  if (role.grantsRole === 'superadmin' && !actorIsSuperAdmin) {
    throw new Error(RL_REQUIRES_SUPERADMIN);
  }

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
    await RoleAssignment.updateOne(
      { userId: user._id, roleId },
      { $setOnInsert: { userId: user._id, roleId, organizationId: oid } },
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
 * Throws `RL_ROLE_NOT_FOUND`, `RL_REQUIRES_SUPERADMIN`,
 * `RL_CANNOT_REMOVE_SELF`, `RL_LAST_PRIVILEGED_MEMBER`.
 */
export async function removeUserFromRole(
  orgId: string,
  roleId: string,
  userId: string,
  opts: { actorUserId?: string; actorIsSuperAdmin?: boolean } = {},
): Promise<void> {
  const oid = toOrgId(orgId);

  const role = await Role.findOne({ _id: roleId, organizationId: oid }).select('grantsRole name');
  if (!role) throw new Error(RL_ROLE_NOT_FOUND);

  // Role-ceiling: only a platform superadmin may change assignment of a
  // superadmin-granting Role (mirror of the gate in addUserToRole).
  if (role.grantsRole === 'superadmin' && !opts.actorIsSuperAdmin) {
    throw new Error(RL_REQUIRES_SUPERADMIN);
  }

  if (role.grantsRole !== 'member') {
    // Only meaningful if the user actually holds the Role — a no-op remove of a
    // non-member must not trip the "last member" guard.
    const isMember = await RoleAssignment.exists({ userId, roleId });
    if (isMember) {
      // G2: self-removal from a Role granting your own admin/superadmin.
      if (opts.actorUserId && String(opts.actorUserId) === String(userId)) {
        throw new Error(RL_CANNOT_REMOVE_SELF);
      }
      // G3: never empty an admin/superadmin-granting Role.
      const memberCount = await RoleAssignment.countDocuments({ roleId });
      if (memberCount <= 1) throw new Error(RL_LAST_PRIVILEGED_MEMBER);
    }
  }

  // Atomic: assignment delete + role/isSuperAdmin recompute commit together so a
  // crash can't leave the user removed from the Role but still carrying the
  // Role's cached role or platform-admin flag.
  await withMongoTransaction(async (session) => {
    await RoleAssignment.deleteOne({ userId, roleId }, { session });
    await recomputeUserOrgRole(userId, oid, session);
    // Assignment change alters effective permissions (JWT) — force a reissue.
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }, { session });
  });
  // Post-commit: publish the user's now-current tokenVersion.
  await publishUserRevocation(String(userId));

  logger.info('Removed user from Role', { organizationId: orgId, roleId, userId });
}
