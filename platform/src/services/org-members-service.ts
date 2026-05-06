// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { toOrgId } from '../helpers/controller-helper';
import { Organization, User, UserOrganization } from '../models';
import type { OrgMemberRole } from '../models/user-organization';

const logger = createLogger('OrgMembersService');

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
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
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
    } finally {
      await session.endSession();
    }
  }

  /**
   * Remove a member from an org. Refuses if the target is the org owner
   * (transfer first). Also clears `User.lastActiveOrgId` if it pointed at
   * this org so the next login picks a different default.
   */
  async removeMember(orgId: string, userId: string): Promise<void> {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const membership = await UserOrganization.findOne({
          userId, organizationId: toOrgId(orgId),
        }).session(session);
        if (!membership) throw new Error(OM_NOT_A_MEMBER);
        if (membership.role === 'owner') throw new Error(OM_CANNOT_REMOVE_OWNER);

        await UserOrganization.deleteOne({ _id: membership._id }).session(session);
        await User.updateOne(
          { _id: userId, lastActiveOrgId: toOrgId(orgId) },
          { $unset: { lastActiveOrgId: '' } },
        ).session(session);
      });
    } finally {
      await session.endSession();
    }
  }

  /**
   * Change a member's role within an org. Refuses to touch the owner role
   * (use transferOwnership). Returns the user details + new role for the
   * controller's response.
   */
  async updateRole(orgId: string, userId: string, role: OrgMemberRole) {
    const membership = await UserOrganization.findOne({ userId, organizationId: toOrgId(orgId) });
    if (!membership) throw new Error(OM_NOT_A_MEMBER);
    if (membership.role === 'owner') throw new Error(OM_CANNOT_CHANGE_OWNER);

    membership.role = role;
    await membership.save();

    const user = await User.findById(userId).select('_id username email').lean();
    return { user, role: membership.role };
  }

  /**
   * Atomically swap ownership: demote current owner to admin, promote
   * new owner from member/admin to owner, update Organization.owner.
   * Caller is responsible for verifying the actor (owner or sysadmin).
   */
  async transferOwnership(orgId: string, newOwnerId: string): Promise<void> {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
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
    } finally {
      await session.endSession();
    }
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
      { _id: userId, lastActiveOrgId: toOrgId(orgId) },
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
