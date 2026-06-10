// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { toOrgId } from '../helpers/controller-helper.js';
import { Group, GroupMembership, User, UserOrganization } from '../models/index.js';
import type { GroupRole } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('groups-service');

export const GRP_GROUP_NOT_FOUND = 'GRP_GROUP_NOT_FOUND';
export const GRP_USER_NOT_FOUND = 'GRP_USER_NOT_FOUND';
export const GRP_NOT_ORG_MEMBER = 'GRP_NOT_ORG_MEMBER';
/** You can't remove yourself from a group that grants your own admin/superadmin. */
export const GRP_CANNOT_REMOVE_SELF = 'GRP_CANNOT_REMOVE_SELF';
/** Removing this user would leave a privilege-granting group with no members. */
export const GRP_LAST_PRIVILEGED_MEMBER = 'GRP_LAST_PRIVILEGED_MEMBER';
/** Only a platform superadmin may add/remove members of a `superadmin`-granting
 *  group — otherwise a mere org admin of the system org could mint or strip
 *  platform superadmins via `recomputeUserOrgRole`. */
export const GRP_REQUIRES_SUPERADMIN = 'GRP_REQUIRES_SUPERADMIN';

/** A group with its current members, for the management UI. */
export interface GroupWithMembers {
  id: string;
  name: string;
  grantsRole: GroupRole;
  system: boolean;
  members: Array<{ id: string; username: string; email: string }>;
}

type OrgId = string | mongoose.Types.ObjectId;
type UserId = string | mongoose.Types.ObjectId;

/** Default groups seeded into every new org. The system org also gets the
 *  Superadmins group (prepended) — see {@link seedDefaultGroups}. */
const DEFAULT_GROUPS: Array<{ name: string; grantsRole: GroupRole }> = [
  { name: 'Administrators', grantsRole: 'admin' },
  { name: 'Developers', grantsRole: 'member' },
];
const SUPERADMINS_GROUP = { name: 'Superadmins', grantsRole: 'superadmin' as GroupRole };

/**
 * Seed the default permission groups for a freshly-created org and place the
 * creator in the right group(s). For a normal org: Administrators + Developers,
 * creator → Administrators. For the **system** org: also Superadmins, and the
 * creator joins **Superadmins + Administrators** and is flagged
 * `User.isSuperAdmin` (this is how the bootstrap user becomes a platform admin
 * via groups). The creator's `UserOrganization.role` stays `owner` — owner
 * ranks above any group-granted role.
 */
export async function seedDefaultGroups(
  organizationId: OrgId,
  creatorUserId: UserId,
  opts: { isSystemOrg?: boolean } = {},
  session?: mongoose.ClientSession,
): Promise<void> {
  const specs = opts.isSystemOrg ? [SUPERADMINS_GROUP, ...DEFAULT_GROUPS] : DEFAULT_GROUPS;

  const created = await Group.create(
    specs.map((s) => ({ organizationId, name: s.name, grantsRole: s.grantsRole, system: true })),
    { session, ordered: true },
  );
  const byName = new Map(created.map((g) => [g.name, g]));

  const joinNames = opts.isSystemOrg ? ['Superadmins', 'Administrators'] : ['Administrators'];
  const memberships = joinNames
    .map((n) => byName.get(n))
    .filter((g): g is NonNullable<typeof g> => !!g)
    .map((g) => ({ userId: creatorUserId, groupId: g._id, organizationId }));
  if (memberships.length > 0) await GroupMembership.create(memberships, { session, ordered: true });

  // Superadmins membership confers the platform-wide flag.
  if (opts.isSystemOrg) {
    await User.updateOne({ _id: creatorUserId }, { $set: { isSuperAdmin: true } }, { session });
  }

  logger.info('Seeded default groups', {
    organizationId: String(organizationId),
    groups: specs.map((s) => s.name),
  });
}

/**
 * Recompute the cached `UserOrganization.role` for a user from their group
 * memberships in an org — called after group membership changes so the rest of
 * the authz path (JWT role, requireRole, canAdministerOrg) keeps reading a
 * single role string. `owner` is preserved (it outranks any group role). A
 * `superadmin`-granting group also sets `User.isSuperAdmin`.
 */
export async function recomputeUserOrgRole(
  userId: UserId,
  organizationId: OrgId,
  session?: mongoose.ClientSession,
): Promise<void> {
  const memberships = await GroupMembership.find({ userId, organizationId })
    .session(session ?? null).select('groupId').lean();
  const groupIds = memberships.map((m) => m.groupId);
  const groups = groupIds.length > 0
    ? await Group.find({ _id: { $in: groupIds } }).session(session ?? null).select('grantsRole').lean()
    : [];
  const roles = new Set(groups.map((g) => g.grantsRole));
  const isSuperadmin = roles.has('superadmin');
  const groupRole: 'admin' | 'member' = (isSuperadmin || roles.has('admin')) ? 'admin' : 'member';

  // Track whether this recompute actually flips an effective privilege, so we
  // only invalidate the user's tokens when something real changed (G1).
  let privilegeChanged = false;

  const membership = await UserOrganization.findOne({ userId, organizationId }).session(session ?? null);
  if (membership && membership.role !== 'owner' && membership.role !== groupRole) {
    membership.role = groupRole;
    await membership.save({ session });
    privilegeChanged = true;
  }

  // isSuperAdmin is authoritative only within an org that defines a superadmin
  // group (i.e. the system org). There, group membership both GRANTS and
  // REVOKES the platform flag (removed from Superadmins → demoted). Orgs with no
  // such group never touch the flag. Read the current value first so we write
  // (and count it as a change) only on a genuine flip.
  const orgHasSuperadminGroup = await Group.exists({ organizationId, grantsRole: 'superadmin' }).session(session ?? null);
  if (orgHasSuperadminGroup) {
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
  // for direct edits. No bump when nothing flipped (e.g. added to a member-only
  // group, or a no-op re-add).
  if (privilegeChanged) {
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }, { session });
  }
}

/** List an org's groups, each with its current members (for the management UI). */
export async function listGroupsWithMembers(orgId: string): Promise<GroupWithMembers[]> {
  const oid = toOrgId(orgId);
  const groups = await Group.find({ organizationId: oid }).sort({ grantsRole: 1, name: 1 }).lean();
  const memberships = await GroupMembership.find({ organizationId: oid })
    .populate<{ userId: { _id: mongoose.Types.ObjectId; username: string; email: string } }>(
      { path: 'userId', select: '_id username email' },
    )
    .lean();

  const byGroup = new Map<string, GroupWithMembers['members']>();
  for (const m of memberships) {
    const u = m.userId as unknown as { _id: mongoose.Types.ObjectId; username: string; email: string } | null;
    if (!u || !u._id) continue; // membership for a deleted user — skip
    const key = String(m.groupId);
    const list = byGroup.get(key) ?? [];
    list.push({ id: String(u._id), username: u.username, email: u.email });
    byGroup.set(key, list);
  }

  return groups.map((g) => ({
    id: String(g._id),
    name: g.name,
    grantsRole: g.grantsRole as GroupRole,
    system: !!g.system,
    members: byGroup.get(String(g._id)) ?? [],
  }));
}

/**
 * Add an existing org member to a group (idempotent), then recompute their
 * cached org role. The user must already be a member of the org — groups grant
 * roles within an org, they don't create org membership.
 *
 * `actorIsSuperAdmin` is the caller's verified platform-superadmin status; it
 * gates membership changes to `superadmin`-granting groups (the Superadmins
 * group in the system org). Without this, any org admin/owner of the system
 * org could add themselves to Superadmins and have `recomputeUserOrgRole`
 * flip `User.isSuperAdmin` — a privilege escalation to platform admin.
 *
 * Throws `GRP_GROUP_NOT_FOUND` / `GRP_USER_NOT_FOUND` / `GRP_NOT_ORG_MEMBER` /
 * `GRP_REQUIRES_SUPERADMIN`.
 */
export async function addUserToGroup(
  orgId: string,
  groupId: string,
  target: { userId?: string; email?: string },
  actorIsSuperAdmin: boolean,
): Promise<{ userId: string }> {
  const oid = toOrgId(orgId);

  const group = await Group.findOne({ _id: groupId, organizationId: oid });
  if (!group) throw new Error(GRP_GROUP_NOT_FOUND);

  // Role-ceiling: granting a superadmin-conferring group requires the actor to
  // already be a platform superadmin. (Admin-granting groups stay delegated to
  // org admins — that's in-org delegation, not platform escalation.)
  if (group.grantsRole === 'superadmin' && !actorIsSuperAdmin) {
    throw new Error(GRP_REQUIRES_SUPERADMIN);
  }

  const user = target.userId
    ? await User.findById(target.userId).select('_id')
    : await User.findOne({ email: target.email?.toLowerCase() }).select('_id');
  if (!user) throw new Error(GRP_USER_NOT_FOUND);

  const member = await UserOrganization.findOne({ userId: user._id, organizationId: oid }).select('_id');
  if (!member) throw new Error(GRP_NOT_ORG_MEMBER);

  // Atomic: the membership write and the cached-role/isSuperAdmin recompute must
  // commit together. A crash between them would otherwise leave the membership
  // added but the effective role/flag stale (a silent privilege change).
  await withMongoTransaction(async (session) => {
    await GroupMembership.updateOne(
      { userId: user._id, groupId },
      { $setOnInsert: { userId: user._id, groupId, organizationId: oid } },
      { upsert: true, session },
    );
    await recomputeUserOrgRole(user._id, oid, session);
  });

  logger.info('Added user to group', { organizationId: orgId, groupId, userId: String(user._id) });
  return { userId: String(user._id) };
}

/**
 * Remove a user from a group, then recompute their cached org role. Within the
 * system org, removing the last `superadmin`-granting membership also clears
 * `User.isSuperAdmin` (handled by {@link recomputeUserOrgRole}).
 *
 * Lockout guards on privilege-granting groups (Administrators / Superadmins):
 *   - G2: you can't remove YOURSELF from one (`actorUserId` === target).
 *   - G3: you can't remove the LAST member of one (would leave it empty).
 * Member-only groups (Developers) are unguarded — losing them revokes nothing.
 *
 * Removing a member of a `superadmin`-granting group requires the caller to be
 * a platform superadmin (`opts.actorIsSuperAdmin`) — otherwise a system-org
 * admin could strip `User.isSuperAdmin` from real superadmins via the recompute.
 *
 * Throws `GRP_GROUP_NOT_FOUND`, `GRP_REQUIRES_SUPERADMIN`,
 * `GRP_CANNOT_REMOVE_SELF`, `GRP_LAST_PRIVILEGED_MEMBER`.
 */
export async function removeUserFromGroup(
  orgId: string,
  groupId: string,
  userId: string,
  opts: { actorUserId?: string; actorIsSuperAdmin?: boolean } = {},
): Promise<void> {
  const oid = toOrgId(orgId);

  const group = await Group.findOne({ _id: groupId, organizationId: oid }).select('grantsRole name');
  if (!group) throw new Error(GRP_GROUP_NOT_FOUND);

  // Role-ceiling: only a platform superadmin may change membership of a
  // superadmin-granting group (mirror of the gate in addUserToGroup).
  if (group.grantsRole === 'superadmin' && !opts.actorIsSuperAdmin) {
    throw new Error(GRP_REQUIRES_SUPERADMIN);
  }

  if (group.grantsRole !== 'member') {
    // Only meaningful if the user is actually in the group — a no-op remove of a
    // non-member must not trip the "last member" guard.
    const isMember = await GroupMembership.exists({ userId, groupId });
    if (isMember) {
      // G2: self-removal from a group granting your own admin/superadmin.
      if (opts.actorUserId && String(opts.actorUserId) === String(userId)) {
        throw new Error(GRP_CANNOT_REMOVE_SELF);
      }
      // G3: never empty an admin/superadmin-granting group.
      const memberCount = await GroupMembership.countDocuments({ groupId });
      if (memberCount <= 1) throw new Error(GRP_LAST_PRIVILEGED_MEMBER);
    }
  }

  // Atomic: membership delete + role/isSuperAdmin recompute commit together so a
  // crash can't leave the user removed from the group but still carrying the
  // group's cached role or platform-admin flag.
  await withMongoTransaction(async (session) => {
    await GroupMembership.deleteOne({ userId, groupId }, { session });
    await recomputeUserOrgRole(userId, oid, session);
  });

  logger.info('Removed user from group', { organizationId: orgId, groupId, userId });
}
