// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { Types } from 'mongoose';
import { RL_ROLE_NOT_FOUND, assignBuiltinAdminRole, ensureBaselineRole, recomputeUserOrgRole, removeBuiltinAdminRole } from './roles-service.js';
import { loadActiveOrgInfo } from '../helpers/active-org-info.js';
import { toOrgId } from '../helpers/controller-helper.js';
import { seatCapacityAvailable } from '../helpers/seats.js';
import { publishUserRevocation } from '../helpers/session-revocation.js';
import { User, Organization, UserOrganization, Role, RoleAssignment, type OrgMemberRole } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';
import { escapeRegex } from '../utils/regex.js';

const logger = createLogger('user-admin-service');

export const UA_USER_NOT_FOUND = 'UA_USER_NOT_FOUND';
export const UA_USERNAME_TAKEN = 'UA_USERNAME_TAKEN';
export const UA_EMAIL_TAKEN = 'UA_EMAIL_TAKEN';
export const UA_OWNER_HAS_ORGS = 'UA_OWNER_HAS_ORGS';
export const UA_ORG_NOT_FOUND = 'UA_ORG_NOT_FOUND';
/** Refused an attempt to change the role of an org OWNER's membership. The owner
 *  role can only move via `transferOwnership` (which atomically re-homes it);
 *  a plain role edit would demote/orphan the org. */
export const UA_CANNOT_CHANGE_OWNER = 'UA_CANNOT_CHANGE_OWNER';
/** Target org is at its seat cap (`org.quotas.seats`) — assigning this user
 *  would exceed it. Same limit the invite/add paths enforce. */
export const UA_SEAT_LIMIT = 'UA_SEAT_LIMIT';
/** Role assignment was requested without an organization. Roles are
 *  org-scoped, so `createUser` can't attach them to an org-less user. */
export const UA_ROLES_NEED_ORG = 'UA_ROLES_NEED_ORG';

interface ListFilter {
  /** Restrict to a specific org (system-admin only); narrows the userId set. */
  scopedOrgId?: string;
  /** Optional role filter — applied within the org scope. */
  role?: string;
  /** Free-text search on username/email. */
  search?: string;
}

interface ListResult {
  users: Array<Record<string, unknown>>;
  total: number;
  /** Per-user memberships, indexed by userId-string. */
  membershipsByUser: Map<string, Array<{ organizationId: Types.ObjectId | string; role: string }>>;
  /** Org-id → name for response shaping. */
  orgNameMap: Map<string, string>;
}

class UserAdminService {
  /**
   * Resolve user IDs that are members of an org. Used by the admin list to
   * compute the org-scope filter; org-admin callers always pass their own
   * org, system-admins pass an arbitrary one or omit.
   */
  async getUserIdsInOrg(orgId: string): Promise<Types.ObjectId[]> {
    const ids = await UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true }).distinct('userId');
    return ids as Types.ObjectId[];
  }

  /** User IDs that hold a specific role within an org — for the role filter. */
  async getUserIdsByRoleInOrg(orgId: string, role: string): Promise<Types.ObjectId[]> {
    // role is validated against MEMBER_ROLES by the caller; cast to satisfy
    // mongoose's strict filter typing for the enum-backed role field.
    const ids = await UserOrganization.find({ organizationId: toOrgId(orgId), role: role as OrgMemberRole, isActive: true }).distinct('userId');
    return ids as Types.ObjectId[];
  }

  /**
   * Run the listing query + fetch all per-user memberships + resolve org
   * names — three DB calls, returns the materials for the controller's
   * response shaping. Caller already computed the user-id scope.
   */
  async list(scopedUserIds: Types.ObjectId[] | null, filter: ListFilter, offset: number, limit: number): Promise<ListResult> {
    const mongoFilter: Record<string, unknown> = {};
    if (scopedUserIds !== null) mongoFilter._id = { $in: scopedUserIds };
    if (filter.search) {
      // Escape regex metacharacters — a search of `.*` shouldn't match
      // everything, and `(` shouldn't be a syntax error that fails the
      // query. Treat the search string as a literal substring.
      const safe = escapeRegex(filter.search);
      mongoFilter.$or = [
        { username: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(mongoFilter)
        .select('_id username email isEmailVerified lastActiveOrgId createdAt updatedAt')
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      User.countDocuments(mongoFilter),
    ]);

    const userIds = users.map(u => u._id);
    const allMemberships = userIds.length > 0
      ? await UserOrganization.find({ userId: { $in: userIds } }).lean()
      : [];

    const membershipsByUser = new Map<string, Array<{ organizationId: Types.ObjectId | string; role: string }>>();
    for (const m of allMemberships) {
      const uid = m.userId.toString();
      if (!membershipsByUser.has(uid)) membershipsByUser.set(uid, []);
      membershipsByUser.get(uid)!.push(m);
    }

    const allOrgIds = [...new Set(allMemberships.map(m => m.organizationId.toString()))];
    const orgs = allOrgIds.length > 0
      // The `.toString()` dedup above flattened the ObjectId org ids to strings;
      // cast them back to ObjectId (24-hex → ObjectId) so the `_id` filter
      // matches the stored ObjectId values.
      ? await Organization.find({ _id: { $in: allOrgIds.map(id => toOrgId(id)) } }).select('_id name').lean()
      : [];
    const orgNameMap = new Map(orgs.map(o => [o._id.toString(), o.name]));

    return { users: users as unknown as Array<Record<string, unknown>>, total, membershipsByUser, orgNameMap };
  }

  /**
   * Return the full user record (for org-admin selection of fields callers
   * may need) plus their memberships and org map for response shaping.
   * Throws UA_USER_NOT_FOUND if the user is gone.
   */
  async getByIdWithOrgs(id: string) {
    // Include `isSuperAdmin` so admin-facing UIs reflect the actual flag
    // (the schema field defaults to `select: false` to keep it out of
    // ordinary queries).
    const user = await User.findById(id)
      .select('_id username email isEmailVerified isSuperAdmin lastActiveOrgId featureOverrides createdAt updatedAt')
      .lean();
    if (!user) throw new Error(UA_USER_NOT_FOUND);

    const memberships = await UserOrganization.find({ userId: user._id }).lean();
    const orgIds = memberships.map(m => m.organizationId);
    const orgs = orgIds.length > 0
      ? await Organization.find({ _id: { $in: orgIds } }).select('_id name slug tier').lean()
      : [];
    const orgMap = new Map(orgs.map(o => [o._id.toString(), o]));

    return { user, memberships, orgMap };
  }

  /**
   * Verify a user is an active member of an org — used for org-admin auth
   * checks ("can this org-admin see this user?"). Returns true on match.
   */
  async hasMembershipInOrg(userId: string | Types.ObjectId, orgId: string): Promise<boolean> {
    const m = await UserOrganization.findOne({
      userId, organizationId: toOrgId(orgId), isActive: true,
    });
    return !!m;
  }

  /**
   * Best-effort lookup of a user's "primary" org for audit attribution.
   * Used by sysadmin-impersonation paths (e.g. `admin.user.delete`) to fill
   * the `affectedOrgId` audit field — answering "which org was hit?" when a
   * sysadmin acts on a user whose own org differs from the sysadmin's own.
   *
   * Preference: `lastActiveOrgId` if set; otherwise the first active
   * membership we find. Returns undefined if the user has no memberships.
   */
  async lookupPrimaryOrgId(userId: string | Types.ObjectId): Promise<string | undefined> {
    const user = await User.findById(userId).select('lastActiveOrgId').lean();
    if (user?.lastActiveOrgId) return user.lastActiveOrgId.toString();
    const membership = await UserOrganization.findOne({ userId, isActive: true })
      .select('organizationId').lean();
    return membership?.organizationId.toString();
  }

  /**
   * Create a new user (system-admin only). Mirrors auth-service.register()'s
   * transaction + user-construction pattern, but skips org creation: an admin
   * either leaves the user org-less or assigns them to an EXISTING org. The
   * account is created pre-verified (`isEmailVerified: true`) — admin-created
   * users skip the email round-trip.
   *
   * The password is hashed by the User model's `pre('save')` hook (same as
   * register()); NEVER hash here. Uniqueness is checked per-field so the 409
   * tells the admin which field collided. Throws UA_USERNAME_TAKEN /
   * UA_EMAIL_TAKEN / UA_ORG_NOT_FOUND.
   */
  async createUser(input: {
    username: string;
    email: string;
    password: string;
    isSuperAdmin?: boolean;
    organizationId?: string;
    role?: OrgMemberRole;
    roleIds?: string[];
  }): Promise<{ id: string; username: string; email: string; isSuperAdmin: boolean; isEmailVerified: boolean; organizationId?: string; role?: OrgMemberRole }> {
    const username = input.username.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();

    // Roles are org-scoped — there's no org to attach them to when the user is
    // created org-less. Fail fast before any DB work. (The zod schema enforces
    // the same rule; this guards direct service callers.)
    if (input.roleIds?.length && !input.organizationId) throw new Error(UA_ROLES_NEED_ORG);

    // User + (optional) membership + role assignments are written together so a
    // failed insert (e.g. bad org/role) can't leave an orphaned user behind.
    // Mirrors register().
    const created = await withMongoTransaction(async (session) => {
      // Separate existence checks — a combined `$or` can't tell the caller
      // WHICH field is taken, and the two collisions map to distinct 409s.
      if (await User.exists({ username }).session(session)) throw new Error(UA_USERNAME_TAKEN);
      if (await User.exists({ email }).session(session)) throw new Error(UA_EMAIL_TAKEN);

      const user = new User({
        username,
        email,
        password: input.password,
        isSuperAdmin: !!input.isSuperAdmin,
        isEmailVerified: true,
      });

      let orgObjectId: Types.ObjectId | undefined;
      if (input.organizationId) {
        const org = await Organization.findById(toOrgId(input.organizationId)).session(session);
        if (!org) throw new Error(UA_ORG_NOT_FOUND);
        await UserOrganization.create(
          [{ userId: user._id, organizationId: org._id, role: input.role ?? 'member' }],
          { session },
        );
        user.lastActiveOrgId = String(org._id);
        orgObjectId = org._id;
      }

      // Persist the user before group assignment so recomputeUserOrgRole can
      // read/flip its `isSuperAdmin` + tokenVersion (it queries the User doc).
      await user.save({ session });

      // Optional role assignment. Guarded above to require an org; each role
      // must belong to that org. Mirrors addUserToRole's upsert + recompute.
      if (input.roleIds?.length && orgObjectId) {
        for (const roleId of input.roleIds) {
          const role = await Role.findOne({ _id: roleId, organizationId: orgObjectId }).session(session);
          if (!role) throw new Error(RL_ROLE_NOT_FOUND);
          // Superadmin role-ceiling (addUserToRole's RL_REQUIRES_SUPERADMIN) is
          // already satisfied: this endpoint is hard-gated to platform superadmins
          // in the controller, so no extra actor check is needed here.
          await RoleAssignment.updateOne(
            { userId: user._id, roleId },
            { $setOnInsert: { userId: user._id, roleId, organizationId: orgObjectId } },
            { upsert: true, session },
          );
        }
        // Derives the cached UserOrganization.role, flips User.isSuperAdmin for a
        // Super Admin role, and bumps tokenVersion once — do NOT set the role
        // manually or double-bump tokenVersion for this path.
        await recomputeUserOrgRole(user._id, orgObjectId, session);
      } else if (orgObjectId) {
        // No explicit Roles supplied. Single-source RBAC: a role-less membership
        // resolves to ZERO permissions, so give EVERY membership the built-in
        // Member Role floor. An admin/owner ALSO gets the built-in Admin Role so
        // their effective PERMISSIONS match the coarse role — setting
        // `membership.role='admin'` alone yields coarse-admin/zero-perms and is
        // reverted by the next recomputeUserOrgRole. We assign Roles and let
        // recompute DERIVE the cached role (it preserves the 'owner' label).
        await ensureBaselineRole(user._id, orgObjectId, session);
        if (input.role === 'admin' || input.role === 'owner') {
          await assignBuiltinAdminRole(user._id, orgObjectId, session);
          await recomputeUserOrgRole(user._id, orgObjectId, session);
        }
      }

      return {
        id: String(user._id),
        username: user.username,
        email: user.email,
        isSuperAdmin: user.isSuperAdmin ?? false,
        isEmailVerified: user.isEmailVerified,
        organizationId: input.organizationId,
        role: input.organizationId ? (input.role ?? 'member') : undefined,
      };
    });
    // Post-commit: a role assignment (via recomputeUserOrgRole) may have bumped
    // the new user's tokenVersion — publish the now-current value (best-effort).
    await publishUserRevocation(created.id);
    return created;
  }

  /**
   * Mutating update of a user record: username, email, password, role-in-org,
   * and (system-admin only) organization assignment. Returns the saved
   * user + the change list. Validation errors throw UA_USERNAME_TAKEN /
   * UA_EMAIL_TAKEN / UA_USER_NOT_FOUND / UA_ORG_NOT_FOUND.
   */
  async updateUserById(
    id: string,
    body: {
      username?: string;
      email?: string;
      role?: string;
      organizationId?: string | null;
      password?: string;
    },
    options: {
      isOrgAdmin: boolean;
      adminOrgId?: string;
      passwordMinLength: number;
    },
  ) {
    const changes: string[] = [];

    // The reads + writes below interleave across User + UserOrganization +
    // Organization, so run them in a single transaction: a partial apply (e.g.
    // role updated but the seat-capped org assignment then throws) would leave
    // the user record inconsistent otherwise.
    const updatedUser = await withMongoTransaction(async (session) => {
      const user = await User.findById(id).select('+password +tokenVersion').session(session);
      if (!user) throw new Error(UA_USER_NOT_FOUND);

      if (body.username !== undefined) {
        const exists = await User.findOne({
          username: body.username.trim().toLowerCase(),
          _id: { $ne: new Types.ObjectId(id) },
        }).session(session);
        if (exists) throw new Error(UA_USERNAME_TAKEN);
        user.username = body.username.trim().toLowerCase();
        changes.push('username');
      }

      if (body.email !== undefined) {
        const exists = await User.findOne({
          email: body.email.trim().toLowerCase(),
          _id: { $ne: new Types.ObjectId(id) },
        }).session(session);
        if (exists) throw new Error(UA_EMAIL_TAKEN);
        user.email = body.email.trim().toLowerCase();
        user.isEmailVerified = false;
        changes.push('email');
      }

      // Role applies to the user's membership in a specific org. Org-admins
      // change the role in their own org; system-admins target the supplied
      // organizationId or fall back to the user's last-active org.
      if (body.role !== undefined && ['owner', 'admin', 'member'].includes(body.role)) {
        const targetOrgId = options.isOrgAdmin
          ? options.adminOrgId
          : (body.organizationId || user.lastActiveOrgId?.toString());
        if (targetOrgId) {
          const oid = toOrgId(targetOrgId);
          const membership = await UserOrganization.findOne({
            userId: user._id, organizationId: oid,
          }).session(session);
          if (membership) {
            // Owner guard: refuse to change the role of an org OWNER's membership
            // (mirrors org-members-service.updateRole). The controller only blocks
            // SETTING role:'owner' — without this an admin could DEMOTE the owner
            // here and orphan the org.
            if (membership.role === 'owner') throw new Error(UA_CANNOT_CHANGE_OWNER);
            if (membership.role !== body.role) {
              // Single-source RBAC: route the coarse-role change THROUGH Role
              // assignment rather than setting `membership.role` directly (a
              // split-brain we retired in updateMemberRole — a direct set gives
              // coarse-admin with member-level perms and is reverted by the next
              // recompute). Promote → grant the built-in Admin Role; demote →
              // strip it. The Member floor is always re-asserted so a demoted
              // user still resolves to the member bundle. recomputeUserOrgRole
              // (run inside ensureBaselineRole) then DERIVES the cached coarse
              // role AND bumps tokenVersion on the privilege change — so we set
              // neither manually here (leaving user.tokenVersion untouched also
              // keeps user.save() from clobbering that $inc).
              if (body.role === 'admin') {
                await assignBuiltinAdminRole(user._id, oid, session);
              } else if (body.role === 'member') {
                await removeBuiltinAdminRole(user._id, oid, session);
              }
              await ensureBaselineRole(user._id, oid, session);
              changes.push('role');
            }
          }
        }
      }

      if (body.password !== undefined) {
        if (typeof body.password !== 'string' || body.password.length < options.passwordMinLength) {
          throw new Error(`Password must be at least ${options.passwordMinLength} characters`);
        }
        user.password = body.password;
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        changes.push('password');
      }

      // Organization assignment is system-admin-only. Empty string or null
      // removes the user from every org; otherwise we ensure a membership
      // exists in the target org and update lastActiveOrgId.
      if (!options.isOrgAdmin && body.organizationId !== undefined) {
        if (body.organizationId === null || body.organizationId === '') {
          await UserOrganization.deleteMany({ userId: user._id }).session(session);
          user.lastActiveOrgId = undefined;
          changes.push('organizationId (removed)');
        } else {
          const newOrg = await Organization.findById(toOrgId(body.organizationId)).session(session);
          if (!newOrg) throw new Error(UA_ORG_NOT_FOUND);
          const existingMembership = await UserOrganization.findOne({
            userId: user._id, organizationId: toOrgId(body.organizationId),
          }).session(session);
          if (!existingMembership) {
            // Enforce the account's pooled seat cap even for a sysadmin assignment
            // (resolved at the root by the helper).
            if (!(await seatCapacityAvailable(String(body.organizationId), 1, session))) {
              throw new Error(UA_SEAT_LIMIT);
            }
            await UserOrganization.create(
              [{ userId: user._id, organizationId: toOrgId(body.organizationId), role: 'member' }],
              { session },
            );
            // Single-source RBAC: give the newly-assigned plain member the
            // built-in Member Role floor.
            await ensureBaselineRole(user._id, toOrgId(body.organizationId), session);
          }
          user.lastActiveOrgId = String(body.organizationId);
          changes.push('organizationId');
        }
      }

      await user.save({ session });
      return user;
    });

    // Post-commit: a password reset or role change (via recompute) bumps
    // tokenVersion — publish the now-current value so the stateless services see
    // it immediately. Unconditional + idempotent (best-effort): a no-bump edit
    // just re-publishes the unchanged version.
    await publishUserRevocation(String(updatedUser._id));

    const { organizationName, activeOrgRole } = await loadActiveOrgInfo(updatedUser._id, updatedUser.lastActiveOrgId?.toString());
    return { user: updatedUser, changes, organizationName, activeOrgRole };
  }

  /**
   * Delete a user + their memberships. Refuses if the user is an org owner
   * (transfer first). Throws UA_USER_NOT_FOUND or UA_OWNER_HAS_ORGS.
   * Caller is responsible for the self-delete check.
   */
  async deleteUserById(id: string): Promise<void> {
    const user = await User.findById(id);
    if (!user) throw new Error(UA_USER_NOT_FOUND);

    const ownerCount = await UserOrganization.countDocuments({ userId: user._id, role: 'owner' });
    if (ownerCount > 0) throw new Error(UA_OWNER_HAS_ORGS);

    // Delete memberships + role assignments + the user atomically so a partial
    // failure can't leave orphaned RoleAssignment docs behind (which would
    // corrupt the last-privileged-member guard).
    await withMongoTransaction(async (session) => {
      await UserOrganization.deleteMany({ userId: user._id }, { session });
      await RoleAssignment.deleteMany({ userId: user._id }, { session });
      await User.findByIdAndDelete(id, { session });
    });
    logger.info('User deleted by admin', { userId: id });
  }

  /**
   * Update a user's `featureOverrides` Map and return the saved user +
   * active-org info needed to compute resolved features for the response.
   * Throws UA_USER_NOT_FOUND.
   */
  async updateFeatures(id: string, overrides: Record<string, boolean>) {
    // `+isSuperAdmin` (schema is `select: false`) is required because the
    // caller resolves feature flags with a sysadmin-bypass branch.
    const user = await User.findById(id).select('_id username email isEmailVerified isSuperAdmin lastActiveOrgId featureOverrides');
    if (!user) throw new Error(UA_USER_NOT_FOUND);

    user.featureOverrides = new Map(Object.entries(overrides));
    await user.save();

    const { organizationName, activeOrgRole, tier } = await loadActiveOrgInfo(user._id, user.lastActiveOrgId?.toString());
    return { user, organizationName, activeOrgRole, tier };
  }
}

export const userAdminService = new UserAdminService();
