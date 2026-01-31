import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { config } from '../config';
import { Organization, User } from '../models';
import { logger, sendError } from '../utils';

/**
 * Check if user is system admin
 * System admin is defined as admin role with organizationId or organizationName === 'system'
 */
function isSystemAdmin(req: Request): boolean {
  if (req.user?.role !== 'admin') return false;
  const orgId = req.user?.organizationId?.toLowerCase();
  const orgName = req.user?.organizationName?.toLowerCase();
  return orgId === 'system' || orgName === 'system';
}

/**
 * Get all organizations (System Admin only)
 * GET /organizations
 */
export async function listAllOrganizations(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Forbidden: System admin access required');
    }

    const organizations = await Organization.find()
      .populate('owner', 'username email')
      .sort({ createdAt: -1 })
      .lean();

    // Add member count to each organization
    const orgsWithCount = organizations.map(org => ({
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
      description: (org as any).description || '',
      memberCount: org.members?.length || 0,
      ownerId: org.owner?._id?.toString(),
      createdAt: (org as any).createdAt,
      updatedAt: (org as any).updatedAt,
    }));

    res.json({ success: true, statusCode: 200, organizations: orgsWithCount });
  } catch (err) {
    logger.error('[LIST ORGS] Fetch Error:', err);
    return sendError(res, 500, 'Error fetching organizations');
  }
}

/**
 * Get organization by ID
 * GET /organization/:id
 */
export async function getOrganizationById(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const { id } = req.params;

    // Allow system admin to view any organization, others only their own
    if (!isSystemAdmin(req) && req.user.organizationId !== id) {
      return sendError(res, 403, 'Forbidden');
    }

    const org = await Organization.findById(id)
      .populate('owner', 'username email')
      .populate('members', 'username email role')
      .lean();

    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    res.json({
      success: true,
      statusCode: 200,
      data: {
        id: org._id.toString(),
        name: org.name,
        slug: org.slug,
        description: (org as any).description || '',
        memberCount: org.members?.length || 0,
        ownerId: org.owner?._id?.toString(),
        members: org.members,
        createdAt: (org as any).createdAt,
        updatedAt: (org as any).updatedAt,
      },
    });
  } catch (err) {
    logger.error('[GET ORG BY ID] Fetch Error:', err);
    return sendError(res, 500, 'Error fetching organization');
  }
}

/**
 * Update organization (System Admin only)
 * PUT /organization/:id
 */
export async function updateOrganization(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Forbidden: System admin access required');
    }

    const { id } = req.params;
    const { name, description } = req.body;

    const org = await Organization.findById(id);
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    // Update fields if provided
    if (name !== undefined) {
      org.name = name;
    }
    if (description !== undefined) {
      (org as any).description = description;
    }

    await org.save();

    logger.info(`[UPDATE ORG] Organization ${id} updated by system admin ${req.user.sub}`);

    res.json({
      success: true,
      statusCode: 200,
      message: 'Organization updated successfully',
      organization: {
        id: org._id.toString(),
        name: org.name,
        slug: org.slug,
        description: (org as any).description || '',
      },
    });
  } catch (err) {
    logger.error('[UPDATE ORG] Update Error:', err);
    return sendError(res, 500, 'Error updating organization');
  }
}

/**
 * Get organization quotas (System Admin only)
 * GET /organization/:id/quotas
 */
export async function getOrganizationQuotas(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Forbidden: System admin access required');
    }

    const { id } = req.params;

    const org = await Organization.findById(id);
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    // Reset any expired quotas
    await org.resetUsageIfExpired('plugins');
    await org.resetUsageIfExpired('pipelines');
    await org.resetUsageIfExpired('apiCalls');

    // Get quota status for each type
    const pluginsQuota = org.checkQuota('plugins');
    const pipelinesQuota = org.checkQuota('pipelines');
    const apiCallsQuota = org.checkQuota('apiCalls');

    // Helper to format quota display (returns 'unlimited' for -1)
    const formatLimit = (limit: number) => limit === -1 ? 'unlimited' : limit;
    const formatRemaining = (remaining: number) => remaining === -1 ? 'unlimited' : remaining;

    res.json({
      success: true,
      statusCode: 200,
      quotas: {
        plugins: {
          used: pluginsQuota.used,
          limit: formatLimit(pluginsQuota.limit),
          remaining: formatRemaining(pluginsQuota.remaining),
          resetAt: pluginsQuota.resetAt,
          resetPeriod: config.quota.resetPeriod?.plugins || '3days',
          unlimited: pluginsQuota.limit === -1,
        },
        pipelines: {
          used: pipelinesQuota.used,
          limit: formatLimit(pipelinesQuota.limit),
          remaining: formatRemaining(pipelinesQuota.remaining),
          resetAt: pipelinesQuota.resetAt,
          resetPeriod: config.quota.resetPeriod?.pipelines || '3days',
          unlimited: pipelinesQuota.limit === -1,
        },
        apiCalls: {
          used: apiCallsQuota.used,
          limit: formatLimit(apiCallsQuota.limit),
          remaining: formatRemaining(apiCallsQuota.remaining),
          resetAt: apiCallsQuota.resetAt,
          resetPeriod: config.quota.resetPeriod?.apiCalls || '3days',
          unlimited: apiCallsQuota.limit === -1,
        },
      },
    });
  } catch (err) {
    logger.error('[GET ORG QUOTAS] Fetch Error:', err);
    return sendError(res, 500, 'Error fetching organization quotas');
  }
}

/**
 * Update organization quotas (System Admin only)
 * PUT /organization/:id/quotas
 */
export async function updateOrganizationQuotas(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Forbidden: System admin access required');
    }

    const { id } = req.params;
    const { plugins, pipelines, apiCalls } = req.body;

    const org = await Organization.findById(id);
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    // Helper to parse quota value (accepts number, -1, or 'unlimited')
    const parseQuotaValue = (value: any): number | undefined => {
      if (value === undefined) return undefined;
      if (value === 'unlimited' || value === -1) return -1;
      const num = Number(value);
      return !isNaN(num) && num >= -1 ? num : undefined;
    };

    // Update quota limits
    if (!org.quotas) {
      (org as any).quotas = {
        plugins: config.quota.organization.plugins,
        pipelines: config.quota.organization.pipelines,
        apiCalls: config.quota.organization.apiCalls,
      };
    }

    const pluginsValue = parseQuotaValue(plugins);
    const pipelinesValue = parseQuotaValue(pipelines);
    const apiCallsValue = parseQuotaValue(apiCalls);

    if (pluginsValue !== undefined) {
      org.quotas.plugins = pluginsValue;
    }
    if (pipelinesValue !== undefined) {
      org.quotas.pipelines = pipelinesValue;
    }
    if (apiCallsValue !== undefined) {
      org.quotas.apiCalls = apiCallsValue;
    }

    await org.save();

    logger.info(`[UPDATE ORG QUOTAS] Organization ${id} quotas updated by system admin ${req.user.sub}`);

    // Helper to format limit for response
    const formatLimit = (limit: number) => limit === -1 ? 'unlimited' : limit;

    res.json({
      success: true,
      statusCode: 200,
      message: 'Organization quotas updated successfully',
      quotas: {
        plugins: {
          limit: formatLimit(org.quotas.plugins),
          unlimited: org.quotas.plugins === -1,
        },
        pipelines: {
          limit: formatLimit(org.quotas.pipelines),
          unlimited: org.quotas.pipelines === -1,
        },
        apiCalls: {
          limit: formatLimit(org.quotas.apiCalls),
          unlimited: org.quotas.apiCalls === -1,
        },
      },
    });
  } catch (err) {
    logger.error('[UPDATE ORG QUOTAS] Update Error:', err);
    return sendError(res, 500, 'Error updating organization quotas');
  }
}

/**
 * Get current user's organization
 * GET /organization
 */
export async function getMyOrganization(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const orgId = req.user.organizationId;
    if (!orgId) {
      return sendError(res, 404, 'No organization associated with this user');
    }

    const org = await Organization.findById(orgId)
      .populate('owner', 'username email')
      .populate('members', 'username email role');

    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    res.json({ success: true, statusCode: 200, organization: org });
  } catch (err) {
    logger.error('[GET ORG] Fetch Error:', err);
    return sendError(res, 500, 'Error fetching organization');
  }
}

/**
 * Add member to organization
 * POST /organization/members
 */
export async function addMember(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();

  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

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

      if (!org || org.owner.toString() !== requesterId) {
        throw new Error('UNAUTHORIZED');
      }

      const newUser = await User.findOne({ email: email.toLowerCase() }).session(session);
      if (!newUser) {
        throw new Error('NOT_FOUND');
      }

      if (org.members.some(id => id.toString() === newUser._id.toString())) {
        throw new Error('ALREADY_MEMBER');
      }

      org.members.push(newUser._id as any);
      newUser.organizationId = org._id as any;

      await org.save({ session });
      await newUser.save({ session });
    });

    logger.info(`[ADD MEMBER] User ${email} added to Org ${organizationId}`);
    res.json({ success: true, statusCode: 200, message: 'Member added successfully' });
  } catch (err: any) {
    logger.error('[ADD MEMBER] Transaction Failed:', err);

    const errorMap: Record<string, number> = {
      UNAUTHORIZED: 403,
      NOT_FOUND: 404,
      ALREADY_MEMBER: 400,
    };

    const status = errorMap[err.message] || 400;
    return sendError(res, status, err.message);
  } finally {
    await session.endSession();
  }
}

/**
 * Transfer organization ownership
 * PATCH /organization/transfer-owner
 */
export async function transferOwnership(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();

  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

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

      if (!org || org.owner.toString() !== currentOwnerId) {
        throw new Error('UNAUTHORIZED');
      }

      const isMember = org.members.some(id => id.toString() === newOwnerId);
      if (!isMember) {
        throw new Error('NEW_OWNER_MUST_BE_MEMBER');
      }

      org.owner = newOwnerId as any;
      await org.save({ session });
    });

    logger.info(`[TRANSFER OWNERSHIP] Org ${organizationId} transferred to ${newOwnerId}`);
    res.json({ success: true, statusCode: 200, message: 'Ownership transferred successfully' });
  } catch (err: any) {
    logger.error('[TRANSFER OWNERSHIP] Failed:', err);

    const status = err.message === 'UNAUTHORIZED' ? 403 : 400;
    return sendError(res, status, err.message);
  } finally {
    await session.endSession();
  }
}

/**
 * Check if user is organization admin (admin role in any non-system org)
 */
function isOrgAdmin(req: Request): boolean {
  return req.user?.role === 'admin' && !isSystemAdmin(req);
}

/**
 * Get organization members (System Admin can view any org, Org Admin can view their own)
 * GET /organization/:id/members
 */
export async function getOrganizationMembers(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const { id } = req.params;
    const isSysAdmin = isSystemAdmin(req);

    // Allow system admin to view any organization, org admin only their own
    if (!isSysAdmin && req.user.organizationId !== id) {
      return sendError(res, 403, 'Forbidden: Can only view members of your organization');
    }

    const org = await Organization.findById(id)
      .populate({
        path: 'members',
        select: '_id username email role isEmailVerified createdAt updatedAt',
      })
      .populate('owner', '_id username email')
      .lean();

    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    const members = (org.members || []).map((member: any) => ({
      id: member._id.toString(),
      username: member.username,
      email: member.email,
      role: member.role,
      isEmailVerified: member.isEmailVerified,
      isOwner: org.owner?._id?.toString() === member._id.toString(),
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    }));

    res.json({
      success: true,
      statusCode: 200,
      organizationId: id,
      organizationName: org.name,
      ownerId: org.owner?._id?.toString(),
      members,
      total: members.length,
    });
  } catch (err) {
    logger.error('[GET ORG MEMBERS] Error:', err);
    return sendError(res, 500, 'Error fetching organization members');
  }
}

/**
 * Add member to organization (System Admin or Org Admin for their org)
 * POST /organization/:id/members
 * Body: { userId or email }
 */
export async function addMemberToOrganization(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();

  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const { id } = req.params;
    const isSysAdmin = isSystemAdmin(req);
    const isOrgAdminUser = isOrgAdmin(req);

    // Must be system admin or org admin of this org
    if (!isSysAdmin && (!isOrgAdminUser || req.user.organizationId !== id)) {
      return sendError(res, 403, 'Forbidden: Admin access required for this organization');
    }

    const { userId, email } = req.body;

    if (!userId && !email) {
      return sendError(res, 400, 'userId or email is required');
    }

    await session.withTransaction(async () => {
      const org = await Organization.findById(id).session(session);
      if (!org) {
        throw new Error('ORG_NOT_FOUND');
      }

      // Find user by ID or email
      let user;
      if (userId) {
        user = await User.findById(userId).session(session);
      } else {
        user = await User.findOne({ email: email.toLowerCase() }).session(session);
      }

      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }

      // Check if already a member
      if (org.members.some(m => m.toString() === user._id.toString())) {
        throw new Error('ALREADY_MEMBER');
      }

      // Org admins cannot add users who are already in another org
      if (isOrgAdminUser && user.organizationId && user.organizationId.toString() !== id) {
        throw new Error('USER_IN_ANOTHER_ORG');
      }

      // Remove from previous organization if any (system admin only can do this)
      if (isSysAdmin && user.organizationId && user.organizationId.toString() !== id) {
        await Organization.updateOne(
          { _id: user.organizationId },
          { $pull: { members: user._id } },
        ).session(session);
      }

      // Add to organization
      org.members.push(user._id);
      user.organizationId = org._id as any;

      await org.save({ session });
      await user.save({ session });
    });

    const adminType = isSysAdmin ? 'system admin' : 'org admin';
    logger.info(`[ADD MEMBER TO ORG] User added to Org ${id} by ${adminType} ${req.user.sub}`);
    res.json({ success: true, statusCode: 200, message: 'Member added successfully' });
  } catch (err: any) {
    logger.error('[ADD MEMBER TO ORG] Failed:', err);

    const errorMap: Record<string, { status: number; message: string }> = {
      ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
      USER_NOT_FOUND: { status: 404, message: 'User not found' },
      ALREADY_MEMBER: { status: 400, message: 'User is already a member of this organization' },
      USER_IN_ANOTHER_ORG: { status: 400, message: 'User is already a member of another organization. Only system admins can move users between organizations.' },
    };

    const error = errorMap[err.message] || { status: 500, message: 'Failed to add member' };
    return sendError(res, error.status, error.message);
  } finally {
    await session.endSession();
  }
}

/**
 * Remove member from organization (System Admin or Org Admin for their org)
 * DELETE /organization/:id/members/:userId
 */
export async function removeMemberFromOrganization(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();

  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const { id, userId } = req.params;
    const isSysAdmin = isSystemAdmin(req);
    const isOrgAdminUser = isOrgAdmin(req);

    // Must be system admin or org admin of this org
    if (!isSysAdmin && (!isOrgAdminUser || req.user.organizationId !== id)) {
      return sendError(res, 403, 'Forbidden: Admin access required for this organization');
    }

    // Org admin cannot remove themselves
    if (isOrgAdminUser && userId === req.user.sub) {
      return sendError(res, 400, 'Cannot remove yourself from the organization');
    }

    await session.withTransaction(async () => {
      const org = await Organization.findById(id).session(session);
      if (!org) {
        throw new Error('ORG_NOT_FOUND');
      }

      const user = await User.findById(userId).session(session);
      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }

      // Check if user is a member
      if (!org.members.some(m => m.toString() === userId)) {
        throw new Error('NOT_A_MEMBER');
      }

      // Cannot remove owner
      if (org.owner.toString() === userId) {
        throw new Error('CANNOT_REMOVE_OWNER');
      }

      // Remove from organization
      org.members = org.members.filter(m => m.toString() !== userId);
      user.organizationId = undefined;

      await org.save({ session });
      await user.save({ session });
    });

    const adminType = isSysAdmin ? 'system admin' : 'org admin';
    logger.info(`[REMOVE MEMBER FROM ORG] User ${userId} removed from Org ${id} by ${adminType} ${req.user.sub}`);
    res.json({ success: true, statusCode: 200, message: 'Member removed successfully' });
  } catch (err: any) {
    logger.error('[REMOVE MEMBER FROM ORG] Failed:', err);

    const errorMap: Record<string, { status: number; message: string }> = {
      ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
      USER_NOT_FOUND: { status: 404, message: 'User not found' },
      NOT_A_MEMBER: { status: 400, message: 'User is not a member of this organization' },
      CANNOT_REMOVE_OWNER: { status: 400, message: 'Cannot remove organization owner. Transfer ownership first.' },
    };

    const error = errorMap[err.message] || { status: 500, message: 'Failed to remove member' };
    return sendError(res, error.status, error.message);
  } finally {
    await session.endSession();
  }
}

/**
 * Update member role in organization (System Admin or Org Admin/Owner for their org)
 * PATCH /organization/:id/members/:userId
 * Body: { role: 'user' | 'admin' }
 */
export async function updateMemberRole(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const { id, userId } = req.params;
    const { role } = req.body;
    const isSysAdmin = isSystemAdmin(req);
    const isOrgAdminUser = isOrgAdmin(req);

    // Must be system admin or org admin of this org
    if (!isSysAdmin && (!isOrgAdminUser || req.user.organizationId !== id)) {
      return sendError(res, 403, 'Forbidden: Admin access required for this organization');
    }

    // Org admin cannot change their own role
    if (isOrgAdminUser && userId === req.user.sub) {
      return sendError(res, 400, 'Cannot change your own role');
    }

    if (!role || !['user', 'admin'].includes(role)) {
      return sendError(res, 400, 'Valid role (user or admin) is required');
    }

    const org = await Organization.findById(id);
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    // Check if user is a member
    if (!org.members.some(m => m.toString() === userId)) {
      return sendError(res, 400, 'User is not a member of this organization');
    }

    // Cannot change owner's role (they must remain admin)
    if (org.owner.toString() === userId && role !== 'admin') {
      return sendError(res, 400, 'Cannot change organization owner role. Transfer ownership first.');
    }

    const user = await User.findById(userId);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    user.role = role;
    await user.save();

    const adminType = isSysAdmin ? 'system admin' : 'org admin';
    logger.info(`[UPDATE MEMBER ROLE] User ${userId} role updated to ${role} in Org ${id} by ${adminType} ${req.user.sub}`);

    res.json({
      success: true,
      statusCode: 200,
      message: 'Member role updated successfully',
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    logger.error('[UPDATE MEMBER ROLE] Error:', err);
    return sendError(res, 500, 'Failed to update member role');
  }
}

/**
 * Transfer organization ownership (System Admin can transfer any org, Org Owner can transfer their own)
 * PATCH /organization/:id/transfer-owner
 * Body: { newOwnerId }
 */
export async function transferOrganizationOwnership(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();

  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    const { id } = req.params;
    const { newOwnerId } = req.body;
    const isSysAdmin = isSystemAdmin(req);

    if (!newOwnerId) {
      return sendError(res, 400, 'New owner ID is required');
    }

    // Check if user is org owner (not just admin)
    const checkOrg = await Organization.findById(id);
    if (!checkOrg) {
      return sendError(res, 404, 'Organization not found');
    }

    const isOrgOwner = checkOrg.owner.toString() === req.user.sub;

    // Must be system admin or the current org owner
    if (!isSysAdmin && !isOrgOwner) {
      return sendError(res, 403, 'Forbidden: Only system admin or organization owner can transfer ownership');
    }

    await session.withTransaction(async () => {
      const org = await Organization.findById(id).session(session);
      if (!org) {
        throw new Error('ORG_NOT_FOUND');
      }

      const newOwner = await User.findById(newOwnerId).session(session);
      if (!newOwner) {
        throw new Error('USER_NOT_FOUND');
      }

      // New owner must be a member
      if (!org.members.some(m => m.toString() === newOwnerId)) {
        throw new Error('NEW_OWNER_MUST_BE_MEMBER');
      }

      // Update owner
      org.owner = newOwnerId as any;

      // Ensure new owner has admin role
      newOwner.role = 'admin';

      await org.save({ session });
      await newOwner.save({ session });
    });

    const adminType = isSysAdmin ? 'system admin' : 'org owner';
    logger.info(`[TRANSFER ORG OWNERSHIP] Org ${id} ownership transferred to ${newOwnerId} by ${adminType} ${req.user.sub}`);
    res.json({ success: true, statusCode: 200, message: 'Ownership transferred successfully' });
  } catch (err: any) {
    logger.error('[TRANSFER ORG OWNERSHIP] Failed:', err);

    const errorMap: Record<string, { status: number; message: string }> = {
      ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
      USER_NOT_FOUND: { status: 404, message: 'User not found' },
      NEW_OWNER_MUST_BE_MEMBER: { status: 400, message: 'New owner must be a member of the organization' },
    };

    const error = errorMap[err.message] || { status: 500, message: 'Failed to transfer ownership' };
    return sendError(res, error.status, error.message);
  } finally {
    await session.endSession();
  }
}

/**
 * Delete organization (System Admin only)
 * DELETE /organization/:id
 */
export async function deleteOrganization(req: Request, res: Response): Promise<void> {
  const session = await mongoose.startSession();

  try {
    if (!req.user) {
      return sendError(res, 401, 'Unauthorized');
    }

    if (!isSystemAdmin(req)) {
      return sendError(res, 403, 'Forbidden: System admin access required');
    }

    const { id } = req.params;

    // Prevent deleting system organization
    if (id === 'system') {
      return sendError(res, 400, 'Cannot delete system organization');
    }

    await session.withTransaction(async () => {
      const org = await Organization.findById(id).session(session);
      if (!org) {
        throw new Error('ORG_NOT_FOUND');
      }

      // Remove organizationId from all members
      await User.updateMany(
        { organizationId: id },
        { $unset: { organizationId: '' } },
      ).session(session);

      // Delete the organization
      await Organization.findByIdAndDelete(id).session(session);
    });

    logger.info(`[DELETE ORG] Organization ${id} deleted by system admin ${req.user.sub}`);
    res.json({ success: true, statusCode: 200, message: 'Organization deleted successfully' });
  } catch (err: any) {
    logger.error('[DELETE ORG] Failed:', err);

    if (err.message === 'ORG_NOT_FOUND') {
      return sendError(res, 404, 'Organization not found');
    }
    return sendError(res, 500, 'Failed to delete organization');
  } finally {
    await session.endSession();
  }
}
