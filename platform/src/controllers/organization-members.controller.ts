/**
 * @module controllers/organization-members
 * @description Organization member management and ownership transfer.
 */

import { createLogger, sendError } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import {
  isSystemAdmin,
  requireAuth,
  getAdminContext,
  handleTransactionError,
  toOrgId,
} from '../helpers/controller-helper';
import { Organization, User } from '../models';
import { validateBody } from '../utils/auth-utils';
import {
  addMemberSchema,
  updateMemberRoleSchema,
  transferOwnershipSchema,
} from '../validation/schemas';

const logger = createLogger('OrganizationMembersController');

// ============================================================================
// Member Management (Admin endpoints)
// ============================================================================

/**
 * Get organization members
 * GET /organization/:id/members
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
      .populate({ path: 'members', select: '_id username email role isEmailVerified createdAt updatedAt' })
      .populate('owner', '_id username email')
      .lean();

    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    interface PopulatedMember {
      _id: mongoose.Types.ObjectId;
      username: string;
      email: string;
      role: string;
      isEmailVerified: boolean;
      createdAt?: Date;
      updatedAt?: Date;
    }

    const members = ((org.members || []) as unknown as PopulatedMember[]).map(member => ({
      id: member._id.toString(),
      username: member.username,
      email: member.email,
      role: member.role,
      isEmailVerified: member.isEmailVerified,
      isOwner: org.owner?.toString() === member._id.toString(),
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    }));

    res.json({
      success: true,
      statusCode: 200,
      organizationId: id,
      organizationName: org.name,
      ownerId: org.owner?.toString(),
      members,
      total: members.length,
    });
  } catch (err) {
    logger.error('[GET ORG MEMBERS] Error:', err);
    return sendError(res, 500, 'Error fetching organization members');
  }
}

/**
 * Add member to organization
 * POST /organization/:id/members
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

      if (org.members.some(m => m.toString() === user._id.toString())) {
        throw new Error('ALREADY_MEMBER');
      }

      if (admin.isOrgAdmin && user.organizationId && user.organizationId.toString() !== id) {
        throw new Error('USER_IN_ANOTHER_ORG');
      }

      if (admin.isSysAdmin && user.organizationId && user.organizationId.toString() !== id) {
        await Organization.updateOne({ _id: user.organizationId }, { $pull: { members: user._id } }).session(session);
      }

      org.members.push(user._id);
      user.organizationId = org._id as mongoose.Types.ObjectId;

      await org.save({ session });
      await user.save({ session });
    });

    logger.info(`[ADD MEMBER TO ORG] User added to Org ${id} by ${admin.adminType} ${req.user!.sub}`);
    res.json({ success: true, statusCode: 200, message: 'Member added successfully' });
  } catch (err) {
    handleTransactionError(res, err, {
      ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
      USER_NOT_FOUND: { status: 404, message: 'User not found' },
      ALREADY_MEMBER: { status: 400, message: 'User is already a member of this organization' },
      USER_IN_ANOTHER_ORG: { status: 400, message: 'User is already a member of another organization. Only system admins can move users between organizations.' },
    }, 'Failed to add member');
  } finally {
    await session.endSession();
  }
}

/**
 * Remove member from organization
 * DELETE /organization/:id/members/:userId
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
      const org = await Organization.findById(toOrgId(id)).session(session);
      if (!org) throw new Error('ORG_NOT_FOUND');

      const user = await User.findById(userId).session(session);
      if (!user) throw new Error('USER_NOT_FOUND');

      if (!org.members.some(m => m.toString() === userId)) {
        throw new Error('NOT_A_MEMBER');
      }

      if (org.owner.toString() === userId) {
        throw new Error('CANNOT_REMOVE_OWNER');
      }

      org.members = org.members.filter(m => m.toString() !== userId);
      user.organizationId = undefined;

      await org.save({ session });
      await user.save({ session });
    });

    logger.info(`[REMOVE MEMBER FROM ORG] User ${userId} removed from Org ${id} by ${admin.adminType} ${req.user!.sub}`);
    res.json({ success: true, statusCode: 200, message: 'Member removed successfully' });
  } catch (err) {
    handleTransactionError(res, err, {
      ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
      USER_NOT_FOUND: { status: 404, message: 'User not found' },
      NOT_A_MEMBER: { status: 400, message: 'User is not a member of this organization' },
      CANNOT_REMOVE_OWNER: { status: 400, message: 'Cannot remove organization owner. Transfer ownership first.' },
    }, 'Failed to remove member');
  } finally {
    await session.endSession();
  }
}

/**
 * Update member role in organization
 * PATCH /organization/:id/members/:userId
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

    const org = await Organization.findById(toOrgId(id));
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    if (!org.members.some(m => m.toString() === userId)) {
      return sendError(res, 400, 'User is not a member of this organization');
    }

    if (org.owner.toString() === userId && body.role !== 'admin') {
      return sendError(res, 400, 'Cannot change organization owner role. Transfer ownership first.');
    }

    const user = await User.findById(userId);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    // Map organization role to user role ('member' -> 'user', 'admin' -> 'admin')
    user.role = body.role === 'member' ? 'user' : 'admin';
    await user.save();

    logger.info(`[UPDATE MEMBER ROLE] User ${userId} role updated to ${body.role} in Org ${id} by ${admin.adminType} ${req.user!.sub}`);

    res.json({
      success: true,
      statusCode: 200,
      message: 'Member role updated successfully',
      user: { id: user._id.toString(), username: user.username, email: user.email, role: user.role },
    });
  } catch (err) {
    logger.error('[UPDATE MEMBER ROLE] Error:', err);
    return sendError(res, 500, 'Failed to update member role');
  }
}

/**
 * Transfer organization ownership
 * PATCH /organization/:id/transfer-owner
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

      const newOwner = await User.findById(newOwnerId).session(session);
      if (!newOwner) throw new Error('USER_NOT_FOUND');

      if (!org.members.some(m => m.toString() === newOwnerId)) {
        throw new Error('NEW_OWNER_MUST_BE_MEMBER');
      }

      org.owner = new mongoose.Types.ObjectId(newOwnerId);
      newOwner.role = 'admin';

      await org.save({ session });
      await newOwner.save({ session });
    });

    const adminType = isSysAdmin ? 'system admin' : 'org owner';
    logger.info(`[TRANSFER ORG OWNERSHIP] Org ${id} ownership transferred to ${newOwnerId} by ${adminType} ${req.user!.sub}`);
    res.json({ success: true, statusCode: 200, message: 'Ownership transferred successfully' });
  } catch (err) {
    handleTransactionError(res, err, {
      ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
      USER_NOT_FOUND: { status: 404, message: 'User not found' },
      NEW_OWNER_MUST_BE_MEMBER: { status: 400, message: 'New owner must be a member of the organization' },
    }, 'Failed to transfer ownership');
  } finally {
    await session.endSession();
  }
}
