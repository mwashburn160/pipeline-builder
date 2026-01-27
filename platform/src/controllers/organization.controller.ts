import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Organization from '../models/organization.model';
import User from '../models/user.model';
import { sendError } from '../utils/auth.utils';
import logger from '../utils/logger.utils';

export async function getMyOrganization(req: Request, res: Response) {
  try {
    if (!req.user) return sendError(res, 401, 'Unauthorized');

    const orgId = req.user.organizationId;
    if (!orgId) return sendError(res, 404, 'No organization associated with this user');

    const org = await Organization.findById(orgId)
      .populate('owner', 'username email')
      .populate('members', 'username email role');

    if (!org) return sendError(res, 404, 'Organization not found');

    res.json({ success: true, organization: org });
  } catch (err) {
    logger.error('[GET ORG] Fetch Error:', err);
    return sendError(res, 500, 'Error fetching organization');
  }
}

export async function addMember(req: Request, res: Response) {
  const session = await mongoose.startSession();
  try {
    if (!req.user) return sendError(res, 401, 'Unauthorized');

    const { email } = req.body;
    const organizationId = req.user.organizationId;
    const requesterId = req.user.sub;

    if (!organizationId || !requesterId) {
      return sendError(res, 401, 'Unauthorized');
    }

    if (!email) {
      return sendError(res, 400, 'Email is required');
    }

    await session.withTransaction(async () => {
      const org = await Organization.findById(organizationId).session(session);
      if (!org || org.owner.toString() !== requesterId) throw new Error('UNAUTHORIZED');

      const newUser = await User.findOne({ email: email.toLowerCase() }).session(session);
      if (!newUser) throw new Error('NOT_FOUND');

      if (org.members.some(id => id.toString() === newUser._id.toString())) {
        throw new Error('ALREADY_MEMBER');
      }

      org.members.push(newUser._id as any);
      newUser.organizationId = org._id as any;

      await org.save({ session });
      await newUser.save({ session });
    });

    logger.info(`[ADD MEMBER] User ${email} added to Org ${organizationId}`);
    res.json({ success: true, message: 'Member added successfully' });
  } catch (err: any) {
    logger.error('[ADD MEMBER] Transaction Failed:', err);
    const status = err.message === 'UNAUTHORIZED' ? 403 : err.message === 'NOT_FOUND' ? 404 : 400;
    return sendError(res, status, err.message);
  } finally {
    await session.endSession();
  }
}

export async function transferOwnership(req: Request, res: Response) {
  const session = await mongoose.startSession();
  try {
    if (!req.user) return sendError(res, 401, 'Unauthorized');

    const { newOwnerId } = req.body;
    const organizationId = req.user.organizationId;
    const currentOwnerId = req.user.sub;

    if (!organizationId || !currentOwnerId) {
      return sendError(res, 401, 'Unauthorized');
    }

    if (!newOwnerId) {
      return sendError(res, 400, 'New owner ID is required');
    }

    await session.withTransaction(async () => {
      const org = await Organization.findById(organizationId).session(session);
      if (!org || org.owner.toString() !== currentOwnerId) throw new Error('UNAUTHORIZED');

      const isMember = org.members.some(id => id.toString() === newOwnerId);
      if (!isMember) throw new Error('NEW_OWNER_MUST_BE_MEMBER');

      org.owner = newOwnerId as any;
      await org.save({ session });
    });

    logger.info(`[TRANSFER OWNERSHIP] Org ${organizationId} transferred to ${newOwnerId}`);
    res.json({ success: true, message: 'Ownership transferred successfully' });
  } catch (err: any) {
    logger.error('[TRANSFER OWNERSHIP] Failed:', err);
    const status = err.message === 'UNAUTHORIZED' ? 403 : 400;
    return sendError(res, status, err.message);
  } finally {
    await session.endSession();
  }
}