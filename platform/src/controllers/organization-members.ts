import { createLogger, sendError, sendSuccess } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
  isSystemAdmin,
  requireAuth,
  getAdminContext,
  handleTransactionError,
  toOrgId,
} from '../helpers/controller-helper';
import { Organization, User, UserOrganization } from '../models';
import {
  validateBody,
  addMemberSchema,
  updateMemberRoleSchema,
  transferOwnershipSchema,
} from '../utils/validation';

const logger = createLogger('OrganizationMembersController');

// Member Management (Admin endpoints)

/**
 * Get organization members.
 * GET /organization/:id/members
 *
 * Queries the {@link UserOrganization} junction collection to list all
 * members of the organization, populating user details. Returns each
 * member's per-org role ('owner' | 'admin' | 'member').
 */
export async function getOrganizationMembers(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const { id } = req.params;
    const isSysAdmin = isSystemAdmin(req);

    if (!isSysAdmin && req.user!.organizationId !== id) {
      return sendError(res, 403, 'Forbidden: Can only view members of your organization');
    }

    const org = await Organization.findById(toOrgId(id))
      .select('name owner')
      .populate('owner', '_id username email')
      .lean();

    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    const memberships = await UserOrganization.find({ organizationId: toOrgId(id) })
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
      .filter(m => m.userId) // skip if user was deleted
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

    sendSuccess(res, 200, {
      organizationId: id,
      organizationName: org.name,
      ownerId: org.owner?.toString(),
      members,
      total: members.length,
    });
  } catch (error) {
    logger.error('[GET ORG MEMBERS] Error:', error);
    return sendError(res, 500, 'Error fetching organization members');
  }
}

/**
 * Add member to organization.
 * POST /organization/:id/members
 *
 * Creates a {@link UserOrganization} record linking the user to the org.
 * Accepts `userId` or `email` to identify the user. Checks for existing
 * membership to prevent duplicates. Default role is 'member'.
 */
export async function addMemberToOrganization(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  const session = await mongoose.startSession();

  try {
    const { id } = req.params;
    const admin = getAdminContext(req);

    if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
      return sendError(res, 403, 'Forbidden: Admin access required for this organization');
    }

    const body = validateBody(addMemberSchema, req.body, res);
    if (!body) return;

    await session.withTransaction(async () => {
      const org = await Organization.findById(toOrgId(id)).session(session);
      if (!org) throw new Error('ORG_NOT_FOUND');

      const user = body.userId
        ? await User.findById(body.userId).session(session)
        : await User.findOne({ email: body.email!.toLowerCase() }).session(session);

      if (!user) throw new Error('USER_NOT_FOUND');

      const existing = await UserOrganization.findOne({
        userId: user._id,
        organizationId: toOrgId(id),
      }).session(session);

      if (existing) {
        throw new Error('ALREADY_MEMBER');
      }

      await UserOrganization.create(
        [
          {
            userId: user._id,
            organizationId: toOrgId(id),
            role: body.role || 'member',
          },
        ],
        { session },
      );
    });

    logger.info(`[ADD MEMBER TO ORG] User added to Org ${id} by ${admin.adminType} ${req.user!.sub}`);
    sendSuccess(res, 200, undefined, 'Member added successfully');
  } catch (error) {
    handleTransactionError(res, error, {
      ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
      USER_NOT_FOUND: { status: 404, message: 'User not found' },
      ALREADY_MEMBER: { status: 400, message: 'User is already a member of this organization' },
    }, 'Failed to add member');
  } finally {
    await session.endSession();
  }
}

/**
 * Remove member from organization.
 * DELETE /organization/:id/members/:userId
 *
 * Deletes the {@link UserOrganization} record. Cannot remove the org owner
 * (transfer ownership first). Clears `User.lastActiveOrgId` if it pointed
 * to this organization.
 */
export async function removeMemberFromOrganization(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  const session = await mongoose.startSession();

  try {
    const { id, userId } = req.params;
    const admin = getAdminContext(req);

    if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
      return sendError(res, 403, 'Forbidden: Admin access required for this organization');
    }

    if (admin.isOrgAdmin && userId === req.user!.sub) {
      return sendError(res, 400, 'Cannot remove yourself from the organization');
    }

    await session.withTransaction(async () => {
      const membership = await UserOrganization.findOne({
        userId,
        organizationId: toOrgId(id),
      }).session(session);

      if (!membership) throw new Error('NOT_A_MEMBER');

      if (membership.role === 'owner') {
        throw new Error('CANNOT_REMOVE_OWNER');
      }

      await UserOrganization.deleteOne({ _id: membership._id }).session(session);

      // If this was the user's last active org, clear it
      await User.updateOne(
        { _id: userId, lastActiveOrgId: toOrgId(id) },
        { $unset: { lastActiveOrgId: '' } },
      ).session(session);
    });

    logger.info(`[REMOVE MEMBER FROM ORG] User ${userId} removed from Org ${id} by ${admin.adminType} ${req.user!.sub}`);
    sendSuccess(res, 200, undefined, 'Member removed successfully');
  } catch (error) {
    handleTransactionError(res, error, {
      NOT_A_MEMBER: { status: 400, message: 'User is not a member of this organization' },
      CANNOT_REMOVE_OWNER: { status: 400, message: 'Cannot remove organization owner. Transfer ownership first.' },
    }, 'Failed to remove member');
  } finally {
    await session.endSession();
  }
}

/**
 * Update member role in organization.
 * PATCH /organization/:id/members/:userId
 *
 * Updates the `role` field on the {@link UserOrganization} record.
 * Valid roles: 'owner' | 'admin' | 'member'. Cannot change the owner's
 * role directly -- use transferOrganizationOwnership instead.
 */
export async function updateMemberRole(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const { id, userId } = req.params;
    const body = validateBody(updateMemberRoleSchema, req.body, res);
    if (!body) return;

    const admin = getAdminContext(req);

    if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
      return sendError(res, 403, 'Forbidden: Admin access required for this organization');
    }

    if (admin.isOrgAdmin && userId === req.user!.sub) {
      return sendError(res, 400, 'Cannot change your own role');
    }

    const membership = await UserOrganization.findOne({
      userId,
      organizationId: toOrgId(id),
    });

    if (!membership) {
      return sendError(res, 400, 'User is not a member of this organization');
    }

    if (membership.role === 'owner') {
      return sendError(res, 400, 'Cannot change organization owner role. Transfer ownership first.');
    }

    membership.role = body.role;
    await membership.save();

    const user = await User.findById(userId).select('_id username email').lean();

    logger.info(`[UPDATE MEMBER ROLE] User ${userId} role updated to ${body.role} in Org ${id} by ${admin.adminType} ${req.user!.sub}`);

    sendSuccess(res, 200, {
      user: {
        id: user?._id.toString() ?? userId,
        username: user?.username,
        email: user?.email,
        role: membership.role,
      },
    }, 'Member role updated successfully');
  } catch (error) {
    logger.error('[UPDATE MEMBER ROLE] Error:', error);
    return sendError(res, 500, 'Failed to update member role');
  }
}

/**
 * Transfer organization ownership.
 * PATCH /organization/:id/transfer-owner
 *
 * Atomically updates {@link UserOrganization} records: demotes the current
 * owner to 'admin' and promotes the new owner to 'owner'. Also updates
 * the denormalized `Organization.owner` reference.
 */
export async function transferOrganizationOwnership(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  const session = await mongoose.startSession();

  try {
    const { id } = req.params;
    const body = validateBody(transferOwnershipSchema, req.body, res);
    if (!body) return;

    const { newOwnerId } = body;
    const isSysAdmin = isSystemAdmin(req);

    const checkOrg = await Organization.findById(toOrgId(id));
    if (!checkOrg) {
      return sendError(res, 404, 'Organization not found');
    }

    const isOrgOwner = checkOrg.owner.toString() === req.user!.sub;

    if (!isSysAdmin && !isOrgOwner) {
      return sendError(res, 403, 'Forbidden: Only system admin or organization owner can transfer ownership');
    }

    await session.withTransaction(async () => {
      const org = await Organization.findById(toOrgId(id)).session(session);
      if (!org) throw new Error('ORG_NOT_FOUND');

      // Find current owner's membership
      const oldOwnerMembership = await UserOrganization.findOne({
        organizationId: toOrgId(id),
        role: 'owner',
      }).session(session);

      if (!oldOwnerMembership) throw new Error('OWNER_MEMBERSHIP_NOT_FOUND');

      // Find new owner's membership
      const newOwnerMembership = await UserOrganization.findOne({
        userId: newOwnerId,
        organizationId: toOrgId(id),
      }).session(session);

      if (!newOwnerMembership) throw new Error('NEW_OWNER_MUST_BE_MEMBER');

      // Demote old owner to admin
      oldOwnerMembership.role = 'admin';
      await oldOwnerMembership.save({ session });

      // Promote new owner
      newOwnerMembership.role = 'owner';
      await newOwnerMembership.save({ session });

      // Update Organization.owner reference
      org.owner = new mongoose.Types.ObjectId(newOwnerId);
      await org.save({ session });
    });

    const adminType = isSysAdmin ? 'system admin' : 'org owner';
    logger.info(`[TRANSFER ORG OWNERSHIP] Org ${id} ownership transferred to ${newOwnerId} by ${adminType} ${req.user!.sub}`);
    sendSuccess(res, 200, undefined, 'Ownership transferred successfully');
  } catch (error) {
    handleTransactionError(res, error, {
      ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
      OWNER_MEMBERSHIP_NOT_FOUND: { status: 500, message: 'Current owner membership record not found' },
      NEW_OWNER_MUST_BE_MEMBER: { status: 400, message: 'New owner must be a member of the organization' },
    }, 'Failed to transfer ownership');
  } finally {
    await session.endSession();
  }
}

/**
 * Deactivate a member (soft removal -- keeps {@link UserOrganization} record, revokes access).
 * PATCH /organization/:id/members/:userId/deactivate
 *
 * Sets `isActive: false` on the UserOrganization record. The deactivated
 * user can no longer switch to this org or access its resources. Clears
 * `User.lastActiveOrgId` if it pointed to this organization.
 */
export async function deactivateMember(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const { id, userId } = req.params;
    const admin = getAdminContext(req);

    if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
      return sendError(res, 403, 'Forbidden: Admin access required for this organization');
    }

    const membership = await UserOrganization.findOne({
      userId,
      organizationId: toOrgId(id),
    });

    if (!membership) {
      return sendError(res, 404, 'Membership not found');
    }

    if (membership.role === 'owner') {
      return sendError(res, 400, 'Cannot deactivate organization owner. Transfer ownership first.');
    }

    if (!membership.isActive) {
      return sendError(res, 400, 'Member is already inactive');
    }

    membership.isActive = false;
    await membership.save();

    // Clear lastActiveOrgId if it pointed to this org
    await User.updateOne(
      { _id: userId, lastActiveOrgId: toOrgId(id) },
      { $unset: { lastActiveOrgId: '' } },
    );

    logger.info(`[DEACTIVATE MEMBER] User ${userId} deactivated in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
    sendSuccess(res, 200, undefined, 'Member deactivated successfully');
  } catch (error) {
    logger.error('[DEACTIVATE MEMBER] Error:', error);
    return sendError(res, 500, 'Failed to deactivate member');
  }
}

/**
 * Reactivate a previously deactivated member.
 * PATCH /organization/:id/members/:userId/activate
 *
 * Sets `isActive: true` on the {@link UserOrganization} record, restoring
 * the user's access to the organization with their existing role.
 */
export async function activateMember(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const { id, userId } = req.params;
    const admin = getAdminContext(req);

    if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
      return sendError(res, 403, 'Forbidden: Admin access required for this organization');
    }

    const membership = await UserOrganization.findOne({
      userId,
      organizationId: toOrgId(id),
    });

    if (!membership) {
      return sendError(res, 404, 'Membership not found');
    }

    if (membership.isActive) {
      return sendError(res, 400, 'Member is already active');
    }

    membership.isActive = true;
    await membership.save();

    logger.info(`[ACTIVATE MEMBER] User ${userId} reactivated in Org ${id} by ${admin.adminType} ${req.user!.sub}`);
    sendSuccess(res, 200, undefined, 'Member reactivated successfully');
  } catch (error) {
    logger.error('[ACTIVATE MEMBER] Error:', error);
    return sendError(res, 500, 'Failed to activate member');
  }
}
