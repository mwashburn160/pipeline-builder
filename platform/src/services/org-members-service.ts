// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { ensureBaselineRole } from './roles-service.js';
import { toOrgId } from '../helpers/controller-helper.js';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import { seatCapacityAvailable, seatCapacityStillWithinCap } from '../helpers/seats.js';
import { publishUserRevocation, publishUsersRevocation } from '../helpers/session-revocation.js';
import { Organization, RoleAssignment, User, UserOrganization } from '../models/index.js';
import type { OrgMemberRole } from '../models/user-organization.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';
import { escapeRegex } from '../utils/regex.js';

const logger = createLogger('org-members-service');

/** Default member-roster page size when the caller omits a limit. */
const MEMBER_LIST_DEFAULT_LIMIT = 25;
/** Hard cap on a single member-roster page (bounds a hostile ?limit). */
const MEMBER_LIST_MAX_LIMIT = 200;

export const OM_ORG_NOT_FOUND = 'OM_ORG_NOT_FOUND';
export const OM_USER_NOT_FOUND = 'OM_USER_NOT_FOUND';
export const OM_ALREADY_MEMBER = 'OM_ALREADY_MEMBER';
export const OM_NOT_A_MEMBER = 'OM_NOT_A_MEMBER';
export const OM_CANNOT_REMOVE_OWNER = 'OM_CANNOT_REMOVE_OWNER';
export const OM_OWNER_MEMBERSHIP_NOT_FOUND = 'OM_OWNER_MEMBERSHIP_NOT_FOUND';
export const OM_NEW_OWNER_MUST_BE_MEMBER = 'OM_NEW_OWNER_MUST_BE_MEMBER';
export const OM_MEMBERSHIP_NOT_FOUND = 'OM_MEMBERSHIP_NOT_FOUND';
export const OM_ALREADY_INACTIVE = 'OM_ALREADY_INACTIVE';
export const OM_ALREADY_ACTIVE = 'OM_ALREADY_ACTIVE';
/** A bulk-add target org is outside the context org's subtree (a parent admin
 *  may only place members on teams they administer, i.e. descendants). */
export const OM_TARGETS_OUT_OF_SCOPE = 'OM_TARGETS_OUT_OF_SCOPE';
/** The org is at its seat cap (`org.quotas.seats`); adding this member would
 *  exceed it. Mirrors the seat check enforced at invite time. */
export const OM_SEAT_LIMIT = 'OM_SEAT_LIMIT';

/** One descendant team annotated with the target member's membership state. */
export interface MemberTeam {
  orgId: string;
  orgName: string;
  /** Present when the team is nested (always set for a descendant). */
  parentOrgId?: string;
  /** True when the member already belongs to this team. */
  isMember: boolean;
  /** The member's role on the team, when a member. */
  role?: string;
  /** The membership's active flag, when a member. */
  isActive?: boolean;
}

/** Outcome of a single team in a bulk-add operation. `seat_limit` = the team
 *  was at its seat cap and the member was NOT added (non-fatal; other teams
 *  still process). */
export interface BulkAddResult {
  orgId: string;
  status: 'added' | 'already_member' | 'seat_limit';
}

/** A descendant team of a context org (roster, no per-member annotation). */
export interface TeamSummary {
  orgId: string;
  orgName: string;
  parentOrgId?: string;
}

interface MemberSummary {
  id: string;
  username: string;
  email: string;
  role: string;
  isEmailVerified: boolean;
  /** Membership active flag — powers the Active/Inactive status badge and the
   *  deactivate/reactivate toggle. */
  isActive: boolean;
  isOwner: boolean;
  joinedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  /** The permission Roles this member holds in the org (id + name), so the UI
   *  renders role chips WITHOUT an O(members×roles) client-side scan. */
  roles: Array<{ id: string; name: string }>;
}

interface OrgMembersPage {
  organizationId: string;
  organizationName: string;
  ownerId?: string;
  members: MemberSummary[];
  /** Total memberships matching the (search/role) filter — the full count so
   *  the client can page; `members` is only the requested window. */
  total: number;
  offset: number;
  limit: number;
}

class OrgMembersService {
  /**
   * A bounded, filterable page of an org's members (joining UserOrganization +
   * User), each annotated with the permission Roles it holds. Returns null if
   * the org doesn't exist. Skips memberships whose user record was deleted out
   * from under them.
   *
   * `search` matches username/email (case-insensitive); `role` narrows to a
   * coarse membership role. Both are applied at the DB level (never in memory),
   * and `total` reflects the full filtered count so the client can page. The
   * roster is sorted by join time for a stable window across pages.
   */
  async listMembers(
    orgId: string,
    opts: { limit?: number; offset?: number; search?: string; role?: OrgMemberRole } = {},
  ): Promise<OrgMembersPage | null> {
    const org = await Organization.findById(toOrgId(orgId))
      .select('name owner')
      .lean();
    if (!org) return null;

    const limit = Math.min(Math.max(1, opts.limit ?? MEMBER_LIST_DEFAULT_LIMIT), MEMBER_LIST_MAX_LIMIT);
    const offset = Math.max(0, opts.offset ?? 0);

    const filter: Record<string, unknown> = { organizationId: toOrgId(orgId) };
    if (opts.role) filter.role = opts.role;

    // Search matches username/email. populate() can't be filtered at the DB
    // level, so resolve matching user ids first and constrain the membership
    // query by them. No match short-circuits to an empty page (no count needed).
    if (opts.search && opts.search.trim()) {
      const rx = new RegExp(escapeRegex(opts.search.trim()), 'i');
      const matched = await User.find({ $or: [{ username: rx }, { email: rx }] })
        .select('_id').lean();
      if (matched.length === 0) {
        return { organizationId: orgId, organizationName: org.name, ownerId: org.owner?.toString(), members: [], total: 0, offset, limit };
      }
      filter.userId = { $in: matched.map((u) => u._id) };
    }

    const [memberships, total] = await Promise.all([
      UserOrganization.find(filter)
        .populate<{
        userId: {
          _id: mongoose.Types.ObjectId;
          username: string;
          email: string;
          isEmailVerified: boolean;
          createdAt?: Date;
          updatedAt?: Date;
        };
      }>({ path: 'userId', select: '_id username email isEmailVerified createdAt updatedAt' })
        .sort({ joinedAt: 1, _id: 1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      UserOrganization.countDocuments(filter),
    ]);

    const present = memberships.filter(m => m.userId);

    // Per-member assigned Role names — one query for the whole page, grouped by
    // user, so the client renders role chips without an O(members×roles) scan.
    const pageUserIds = present.map(m => m.userId._id);
    const rolesByUser = new Map<string, Array<{ id: string; name: string }>>();
    if (pageUserIds.length > 0) {
      const assignments = await RoleAssignment.find({
        organizationId: toOrgId(orgId), userId: { $in: pageUserIds },
      })
        .populate<{ roleId: { _id: mongoose.Types.ObjectId; name: string } | null }>(
          { path: 'roleId', select: '_id name' },
        )
        .lean();
      for (const a of assignments) {
        if (!a.roleId) continue;
        const uid = String(a.userId);
        const list = rolesByUser.get(uid) ?? [];
        list.push({ id: String(a.roleId._id), name: a.roleId.name });
        rolesByUser.set(uid, list);
      }
    }

    const members = present.map(m => {
      const uid = m.userId._id.toString();
      return {
        id: uid,
        username: m.userId.username,
        email: m.userId.email,
        role: m.role,
        isEmailVerified: m.userId.isEmailVerified,
        isActive: m.isActive,
        isOwner: m.role === 'owner',
        joinedAt: m.joinedAt,
        createdAt: m.userId.createdAt,
        updatedAt: m.userId.updatedAt,
        roles: (rolesByUser.get(uid) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      };
    });

    return {
      organizationId: orgId,
      organizationName: org.name,
      ownerId: org.owner?.toString(),
      members,
      total,
      offset,
      limit,
    };
  }

  /**
   * Add a member by user-id or email. Defaults role to 'member'. Wraps
   * the existence + duplicate checks + insert in a single transaction.
   * Throws OM_ORG_NOT_FOUND / OM_USER_NOT_FOUND / OM_ALREADY_MEMBER.
   */
  async addMember(orgId: string, body: { userId?: string; email?: string; role?: OrgMemberRole }): Promise<void> {
    await withMongoTransaction(async (session) => {
      const org = await Organization.findById(toOrgId(orgId)).session(session);
      if (!org) throw new Error(OM_ORG_NOT_FOUND);

      const user = body.userId
        ? await User.findById(body.userId).session(session)
        : await User.findOne({ email: body.email!.toLowerCase() }).session(session);
      if (!user) throw new Error(OM_USER_NOT_FOUND);

      const existing = await UserOrganization.findOne({
        userId: user._id, organizationId: toOrgId(orgId),
      }).session(session);
      if (existing) throw new Error(OM_ALREADY_MEMBER);

      // Seat-cap enforcement — pooled at the account root (same cap the invite
      // path enforces); a direct add must not bypass it. But seats count DISTINCT
      // humans across the subtree, so a user who already holds a seat elsewhere in
      // the account consumes no new seat — only check capacity when they don't
      // (mirrors bulkAddMemberToTeams).
      const subtreeIds = (await expandOrgScope(orgId)).map(toOrgId);
      const alreadyHasSeat = await UserOrganization.exists({
        userId: user._id, organizationId: { $in: subtreeIds }, isActive: true,
      }).session(session);
      if (!alreadyHasSeat && !(await seatCapacityAvailable(orgId, 1, session))) {
        throw new Error(OM_SEAT_LIMIT);
      }

      const addedRole = body.role || 'member';
      await UserOrganization.create(
        [{ userId: user._id, organizationId: toOrgId(orgId), role: addedRole }],
        { session },
      );

      // Single-source RBAC: give a plain member the built-in Member Role floor
      // so they resolve to the member bundle (they'd hold zero permissions
      // otherwise). Admin adds get their Role elsewhere.
      if (addedRole === 'member') {
        await ensureBaselineRole(user._id, toOrgId(orgId), session);
      }

      // G5: re-validate the pooled cap AFTER the write, inside the same tx, so a
      // concurrent add/invite that slipped in between our pre-check and this
      // insert can't push the account over its seats limit unnoticed. Only when
      // this add actually consumed a seat (matches the pre-check's guard so we
      // don't block re-adding an already-seated human when the cap is exceeded).
      if (!alreadyHasSeat && !(await seatCapacityStillWithinCap(orgId, session))) {
        throw new Error(OM_SEAT_LIMIT);
      }
    });
  }

  /**
   * List every descendant team of `contextOrgId` (org → team hierarchy), sorted
   * by name. The context org itself is excluded. Returns `[]` for a flat org
   * with no teams. Roster used by the "add to teams" picker (no member context).
   */
  async listTeams(contextOrgId: string): Promise<{ teams: TeamSummary[] }> {
    const subtree = await expandOrgScope(contextOrgId); // includes contextOrgId
    const teamIds = subtree.filter((id) => id !== contextOrgId);
    if (teamIds.length === 0) return { teams: [] };

    const orgs = await Organization.find({ _id: { $in: teamIds.map(toOrgId) } })
      .select('_id name parentOrgId').lean();
    const teams: TeamSummary[] = orgs.map((o) => {
      const parent = o.parentOrgId;
      return { orgId: String(o._id), orgName: o.name, ...(parent ? { parentOrgId: String(parent) } : {}) };
    });
    teams.sort((a, b) => a.orgName.localeCompare(b.orgName));
    return { teams };
  }

  /**
   * The {@link listTeams} roster, each entry annotated with whether `memberId`
   * belongs to it (and their role/active state). Powers the admin "manage teams"
   * view. Returns `[]` for a flat org with no teams.
   */
  async listMemberTeams(contextOrgId: string, memberId: string): Promise<{ teams: MemberTeam[] }> {
    const { teams: roster } = await this.listTeams(contextOrgId);
    if (roster.length === 0) return { teams: [] };

    const memberships = await UserOrganization.find({
      userId: memberId, organizationId: { $in: roster.map((t) => toOrgId(t.orgId)) },
    }).select('organizationId role isActive').lean();
    const byOrg = new Map(memberships.map((m) => [String(m.organizationId), m]));

    const teams: MemberTeam[] = roster.map((t) => {
      const m = byOrg.get(t.orgId);
      return { ...t, isMember: !!m, ...(m ? { role: m.role, isActive: m.isActive } : {}) };
    });
    return { teams };
  }

  /**
   * Add a single user (by id or email) to multiple teams in one transaction.
   * Every target must lie within `contextOrgId`'s subtree — the controller has
   * already verified the actor administers `contextOrgId`, and a parent admin
   * inherits admin over descendants, so subtree membership is the authorization
   * boundary. Idempotent per team: an existing membership is reported
   * `already_member` rather than erroring, so re-saving the manage-teams modal
   * is safe. Throws OM_USER_NOT_FOUND / OM_TARGETS_OUT_OF_SCOPE.
   */
  async bulkAddMemberToTeams(
    contextOrgId: string,
    body: { userId?: string; email?: string; orgIds: string[]; role?: OrgMemberRole },
  ): Promise<{ results: BulkAddResult[] }> {
    const subtree = await expandOrgScope(contextOrgId);
    const subtreeSet = new Set(subtree);
    const outOfScope = body.orgIds.filter((id) => !subtreeSet.has(id));
    if (outOfScope.length > 0) throw new Error(OM_TARGETS_OUT_OF_SCOPE);

    return withMongoTransaction(async (session) => {
      const user = body.userId
        ? await User.findById(body.userId).session(session)
        : await User.findOne({ email: body.email!.toLowerCase() }).session(session);
      if (!user) throw new Error(OM_USER_NOT_FOUND);

      // Seats pool at the account ROOT and count DISTINCT humans, so adding
      // this one user to N teams consumes at most ONE seat. If they don't
      // already hold a seat in the account, check pooled capacity once up front.
      const subtreeIds = subtree.map(toOrgId);
      const alreadyHasSeat = await UserOrganization.exists({
        userId: user._id, organizationId: { $in: subtreeIds }, isActive: true,
      }).session(session);
      if (!alreadyHasSeat && !(await seatCapacityAvailable(contextOrgId, 1, session))) {
        throw new Error(OM_SEAT_LIMIT);
      }

      const addedRole = body.role || 'member';
      const results: BulkAddResult[] = [];
      for (const orgId of body.orgIds) {
        const existing = await UserOrganization.findOne({
          userId: user._id, organizationId: toOrgId(orgId),
        }).session(session);
        if (existing) {
          results.push({ orgId, status: 'already_member' });
          continue;
        }
        await UserOrganization.create(
          [{ userId: user._id, organizationId: toOrgId(orgId), role: addedRole }],
          { session },
        );
        // Single-source RBAC: plain members get the built-in Member Role floor
        // per team so they resolve to the member bundle.
        if (addedRole === 'member') {
          await ensureBaselineRole(user._id, toOrgId(orgId), session);
        }
        results.push({ orgId, status: 'added' });
      }
      return { results };
    });
  }

  /**
   * Remove a member from an org. Refuses if the target is the org owner
   * (transfer first). Also clears `User.lastActiveOrgId` if it pointed at
   * this org so the next login picks a different default.
   *
   * Bumps the removed user's `tokenVersion` so any JWTs they still hold for
   * the now-revoked org are rejected on the next request (the JWT carries
   * the issuance-time tokenVersion; `requireAuth` compares it to the
   * current value). Without this bump a kicked user keeps acting as the
   * org until their access token expires (~15 min default).
   */
  async removeMember(orgId: string, userId: string): Promise<void> {
    await withMongoTransaction(async (session) => {
      const membership = await UserOrganization.findOne({
        userId, organizationId: toOrgId(orgId),
      }).session(session);
      if (!membership) throw new Error(OM_NOT_A_MEMBER);
      if (membership.role === 'owner') throw new Error(OM_CANNOT_REMOVE_OWNER);

      await UserOrganization.deleteOne({ _id: membership._id }).session(session);
      await User.updateOne(
        { _id: userId },
        {
          $inc: { tokenVersion: 1 },
          $unset: { refreshToken: '' },
        },
        { session },
      );
      // Clear lastActiveOrgId if it pointed at the just-removed org (in a
      // separate update so the unset only fires for matching docs).
      await User.updateOne(
        { _id: userId, lastActiveOrgId: String(toOrgId(orgId)) },
        { $unset: { lastActiveOrgId: '' } },
        { session },
      );
    });
    // Post-commit: publish the removed user's now-current tokenVersion.
    await publishUserRevocation(userId);
  }

  /**
   * Atomically swap ownership: demote current owner to admin, promote
   * new owner from member/admin to owner, update Organization.owner.
   * Caller is responsible for verifying the actor (owner or sysadmin).
   *
   * Bumps BOTH users' `tokenVersion` in the same transaction (mirrors
   * updateRole/removeMember). The membership `role` is baked into each user's
   * JWT at issue time, so without this the demoted ex-owner would keep an
   * owner-role token (~15 min) and the new owner's elevation wouldn't take effect
   * until their token refreshed. The bump forces `requireAuth` to reject both
   * users' outstanding tokens so a refresh reissues them with the swapped role.
   */
  async transferOwnership(orgId: string, newOwnerId: string): Promise<void> {
    let oldOwnerId: string | undefined;
    await withMongoTransaction(async (session) => {
      const org = await Organization.findById(toOrgId(orgId)).session(session);
      if (!org) throw new Error(OM_ORG_NOT_FOUND);

      const oldOwnerMembership = await UserOrganization.findOne({
        organizationId: toOrgId(orgId), role: 'owner',
      }).session(session);
      if (!oldOwnerMembership) throw new Error(OM_OWNER_MEMBERSHIP_NOT_FOUND);

      const newOwnerMembership = await UserOrganization.findOne({
        userId: newOwnerId, organizationId: toOrgId(orgId),
      }).session(session);
      if (!newOwnerMembership) throw new Error(OM_NEW_OWNER_MUST_BE_MEMBER);

      oldOwnerId = String(oldOwnerMembership.userId);
      oldOwnerMembership.role = 'admin';
      await oldOwnerMembership.save({ session });
      newOwnerMembership.role = 'owner';
      await newOwnerMembership.save({ session });

      org.owner = new mongoose.Types.ObjectId(newOwnerId);
      await org.save({ session });

      // Invalidate both users' outstanding access tokens so the role swap takes
      // effect immediately (the JWT carries the issue-time membership role).
      await User.updateMany(
        { _id: { $in: [oldOwnerMembership.userId, newOwnerId] } },
        { $inc: { tokenVersion: 1 } },
        { session },
      );
    });
    // Post-commit: publish BOTH users' now-current tokenVersion so the role swap
    // takes effect on the stateless services immediately.
    await publishUsersRevocation([oldOwnerId, newOwnerId].filter((v): v is string => !!v));
  }

  /** Check if the caller is the org owner — used by ownership-transfer authz. */
  async isOrgOwner(orgId: string, userId: string): Promise<boolean> {
    const org = await Organization.findById(toOrgId(orgId));
    return !!org && org.owner.toString() === userId;
  }

  /**
   * Soft-deactivate a member: sets isActive=false and clears their
   * lastActiveOrgId if it pointed here. They keep the membership record
   * but lose access. Refuses to touch the owner.
   *
   * Bumps the user's `tokenVersion` and clears their refresh token in the same
   * transaction (mirrors {@link removeMember}). `requireAuth` trusts the JWT
   * claims and only re-reads `tokenVersion` — it does NOT re-check `isActive` —
   * so without this bump a deactivated member would keep full read+write access
   * until their access token expired (~15 min). The bump forces every outstanding
   * JWT to be rejected on the next request, and unsetting the refresh token
   * blocks a silent re-issue.
   */
  async deactivateMember(orgId: string, userId: string): Promise<void> {
    await withMongoTransaction(async (session) => {
      const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId) }).session(session);
      if (!membership) throw new Error(OM_MEMBERSHIP_NOT_FOUND);
      if (membership.role === 'owner') throw new Error(OM_CANNOT_REMOVE_OWNER);
      if (!membership.isActive) throw new Error(OM_ALREADY_INACTIVE);

      membership.isActive = false;
      await membership.save({ session });

      // Invalidate outstanding access tokens + block refresh re-issue so the
      // loss of access is immediate, not deferred to token expiry.
      await User.updateOne(
        { _id: userId },
        {
          $inc: { tokenVersion: 1 },
          $unset: { refreshToken: '' },
        },
        { session },
      );

      // Clear lastActiveOrgId if it pointed at the just-deactivated org.
      await User.updateOne(
        { _id: userId, lastActiveOrgId: String(toOrgId(orgId)) },
        { $unset: { lastActiveOrgId: '' } },
        { session },
      );
    });
    // Post-commit: publish the deactivated user's now-current tokenVersion.
    await publishUserRevocation(userId);
  }

  /** Re-activate a previously deactivated member. */
  async activateMember(orgId: string, userId: string): Promise<void> {
    await withMongoTransaction(async (session) => {
      const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId) }).session(session);
      if (!membership) throw new Error(OM_MEMBERSHIP_NOT_FOUND);
      if (membership.isActive) throw new Error(OM_ALREADY_ACTIVE);

      // Reactivation re-occupies a seat, so it must honor the pooled cap the
      // invite/add paths enforce — otherwise deactivate→reactivate churn could
      // push an account over its seat limit. A user already holding an active
      // seat elsewhere in the subtree consumes no new seat (distinct-humans).
      const subtreeIds = (await expandOrgScope(orgId)).map(toOrgId);
      const alreadyHasSeat = await UserOrganization.exists({
        userId, organizationId: { $in: subtreeIds }, isActive: true,
      }).session(session);
      if (!alreadyHasSeat && !(await seatCapacityAvailable(orgId, 1, session))) {
        throw new Error(OM_SEAT_LIMIT);
      }

      membership.isActive = true;
      await membership.save({ session });
    });
  }
}

export const orgMembersService = new OrgMembersService();
logger.info('OrgMembersService ready');
