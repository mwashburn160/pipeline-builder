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

    const org = await Organization.findById(id).lean();
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    // Get actual usage counts (you would implement these based on your plugin/pipeline services)
    // For now, we'll return placeholder values
    const pluginsUsed = 0; // TODO: Count actual plugins for this org
    const pipelinesUsed = 0; // TODO: Count actual pipelines for this org
    const apiCallsUsed = 0; // TODO: Count actual API calls for this org

    res.json({
      success: true,
      statusCode: 200,
      quotas: {
        plugins: {
          used: pluginsUsed,
          limit: org.quotas?.plugins ?? config.quota.organization.plugins,
        },
        pipelines: {
          used: pipelinesUsed,
          limit: org.quotas?.pipelines ?? config.quota.organization.pipelines,
        },
        apiCalls: {
          used: apiCallsUsed,
          limit: org.quotas?.apiCalls ?? config.quota.organization.apiCalls,
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

    // Update quota limits
    if (!org.quotas) {
      (org as any).quotas = {
        plugins: config.quota.organization.plugins,
        pipelines: config.quota.organization.pipelines,
        apiCalls: config.quota.organization.apiCalls,
      };
    }

    if (plugins !== undefined && plugins >= 0) {
      org.quotas.plugins = plugins;
    }
    if (pipelines !== undefined && pipelines >= 0) {
      org.quotas.pipelines = pipelines;
    }
    if (apiCalls !== undefined && apiCalls >= 0) {
      org.quotas.apiCalls = apiCalls;
    }

    await org.save();

    logger.info(`[UPDATE ORG QUOTAS] Organization ${id} quotas updated by system admin ${req.user.sub}`);

    res.json({
      success: true,
      statusCode: 200,
      message: 'Organization quotas updated successfully',
      quotas: {
        plugins: org.quotas.plugins,
        pipelines: org.quotas.pipelines,
        apiCalls: org.quotas.apiCalls,
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
