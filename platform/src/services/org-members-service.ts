// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { toOrgId } from '../helpers/controller-helper';
import { expandOrgScope } from '../helpers/org-hierarchy';
import { Organization, User, UserOrganization } from '../models';
import type { OrgMemberRole } from '../models/user-organization';
import { withMongoTransaction } from '../utils/mongo-tx';

const logger = createLogger('org-members-service');

export const OM_ORG_NOT_FOUND = 'OM_ORG_NOT_FOUND';
export const OM_USER_NOT_FOUND = 'OM_USER_NOT_FOUND';
export const OM_ALREADY_MEMBER = 'OM_ALREADY_MEMBER';
export const OM_NOT_A_MEMBER = 'OM_NOT_A_MEMBER';
export const OM_CANNOT_REMOVE_OWNER = 'OM_CANNOT_REMOVE_OWNER';
export const OM_CANNOT_CHANGE_OWNER = 'OM_CANNOT_CHANGE_OWNER';
export const OM_OWNER_MEMBERSHIP_NOT_FOUND = 'OM_OWNER_MEMBERSHIP_NOT_FOUND';
export const OM_NEW_OWNER_MUST_BE_MEMBER = 'OM_NEW_OWNER_MUST_BE_MEMBER';
export const OM_MEMBERSHIP_NOT_FOUND = 'OM_MEMBERSHIP_NOT_FOUND';
export const OM_ALREADY_INACTIVE = 'OM_ALREADY_INACTIVE';
export const OM_ALREADY_ACTIVE = 'OM_ALREADY_ACTIVE';
/** A bulk-add target org is outside the context org's subtree (a parent admin
 *  may only place members on teams they administer, i.e. descendants). */
export const OM_TARGETS_OUT_OF_SCOPE = 'OM_TARGETS_OUT_OF_SCOPE';

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

/** Outcome of a single team in a bulk-add operation. */
export interface BulkAddResult {
  orgId: string;
  status: 'added' | 'already_member';
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
  isOwner: boolean;
  joinedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

interface OrgWithMembers {
  organizationId: string;
  organizationName: string;
  ownerId?: string;
  members: MemberSummary[];
}

class OrgMembersService {
  /**
   * Find org + populate the full member list (joining UserOrganization +
   * User). Returns null if the org doesn't exist. Skips memberships whose
   * user record was deleted out from under them.
   */
  async listMembers(orgId: string): Promise<OrgWithMembers | null> {
    const org = await Organization.findById(toOrgId(orgId))
      .select('name owner')
      .populate('owner', '_id username email')
      .lean();
    if (!org) return null;

    const memberships = await UserOrganization.find({ organizationId: toOrgId(orgId) })
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
      .lean();

    const members = memberships
      .filter(m => m.userId)
      .map(m => ({
        id: m.userId._id.toString(),
        username: m.userId.username,
        email: m.userId.email,
        role: m.role,
        isEmailVerified: m.userId.isEmailVerified,
        isOwner: m.role === 'owner',
        joinedAt: m.joinedAt,
        createdAt: m.userId.createdAt,
        updatedAt: m.userId.updatedAt,
      }));

    return {
      organizationId: orgId,
      organizationName: org.name,
      ownerId: org.owner?.toString(),
      members,
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

      await UserOrganization.create(
        [{ userId: user._id, organizationId: toOrgId(orgId), role: body.role || 'member' }],
        { session },
      );
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
      const parent = (o as { parentOrgId?: unknown }).parentOrgId;
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
    const subtree = new Set(await expandOrgScope(contextOrgId));
    const outOfScope = body.orgIds.filter((id) => !subtree.has(id));
    if (outOfScope.length > 0) throw new Error(OM_TARGETS_OUT_OF_SCOPE);

    return withMongoTransaction(async (session) => {
      const user = body.userId
        ? await User.findById(body.userId).session(session)
        : await User.findOne({ email: body.email!.toLowerCase() }).session(session);
      if (!user) throw new Error(OM_USER_NOT_FOUND);

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
          [{ userId: user._id, organizationId: toOrgId(orgId), role: body.role || 'member' }],
          { session },
        );
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
   * org until their access token expires (~2 h default).
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
  }

  /**
   * Change a member's role within an org. Refuses to touch the owner role
   * (use transferOwnership). Returns the user details + new role for the
   * controller's response.
   *
   * Bumps the target user's `tokenVersion` on every successful role change
   * so role claims baked into outstanding JWTs (`role: admin` vs `member`)
   * can't outlive the demotion. Same defensive rationale as removeMember:
   * server-side authorization is the source of truth, but the JWT cache
   * needs to follow the DB.
   */
  async updateRole(orgId: string, userId: string, role: OrgMemberRole) {
    const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId) });
    if (!membership) throw new Error(OM_NOT_A_MEMBER);
    if (membership.role === 'owner') throw new Error(OM_CANNOT_CHANGE_OWNER);
    if (membership.role === role) {
      // No-op when caller passes the existing role — don't churn tokens.
      const user = await User.findById(userId).select('_id username email').lean();
      return { user, role: membership.role };
    }

    membership.role = role;
    await membership.save();
    await User.updateOne(
      { _id: userId },
      { $inc: { tokenVersion: 1 } },
    );

    const user = await User.findById(userId).select('_id username email').lean();
    return { user, role: membership.role };
  }

  /**
   * Atomically swap ownership: demote current owner to admin, promote
   * new owner from member/admin to owner, update Organization.owner.
   * Caller is responsible for verifying the actor (owner or sysadmin).
   */
  async transferOwnership(orgId: string, newOwnerId: string): Promise<void> {
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

      oldOwnerMembership.role = 'admin';
      await oldOwnerMembership.save({ session });
      newOwnerMembership.role = 'owner';
      await newOwnerMembership.save({ session });

      org.owner = new mongoose.Types.ObjectId(newOwnerId);
      await org.save({ session });
    });
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
   */
  async deactivateMember(orgId: string, userId: string): Promise<void> {
    const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId) });
    if (!membership) throw new Error(OM_MEMBERSHIP_NOT_FOUND);
    if (membership.role === 'owner') throw new Error(OM_CANNOT_REMOVE_OWNER);
    if (!membership.isActive) throw new Error(OM_ALREADY_INACTIVE);

    membership.isActive = false;
    await membership.save();

    await User.updateOne(
      { _id: userId, lastActiveOrgId: String(toOrgId(orgId)) },
      { $unset: { lastActiveOrgId: '' } },
    );
  }

  /** Re-activate a previously deactivated member. */
  async activateMember(orgId: string, userId: string): Promise<void> {
    const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId) });
    if (!membership) throw new Error(OM_MEMBERSHIP_NOT_FOUND);
    if (membership.isActive) throw new Error(OM_ALREADY_ACTIVE);

    membership.isActive = true;
    await membership.save();
  }
}

export const orgMembersService = new OrgMembersService();
logger.info('OrgMembersService ready');
