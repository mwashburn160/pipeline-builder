import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { config } from '../config';
import { Organization, User } from '../models';
import { logger, sendError } from '../utils';
import {
  getOrganizationQuotaStatus,
  updateQuotaLimits,
  QuotaType,
} from '../middleware/quota.middleware';
import {
  isSystemAdmin,
  requireAuth,
  requireSystemAdmin,
  getAdminContext,
  handleTransactionError,
  toOrgId,
} from './helpers';

// ============================================================================
// Quota Helpers
// ============================================================================

function formatQuotaValue(value: number): number | string {
  return value === -1 ? 'unlimited' : value;
}

function parseQuotaValue(value: any): number | undefined {
  if (value === undefined) return undefined;
  if (value === 'unlimited' || value === -1) return -1;
  const num = Number(value);
  return !isNaN(num) && num >= -1 ? num : undefined;
}

// ============================================================================
// Organization CRUD (System Admin)
// ============================================================================

/**
 * Get all organizations (System Admin only)
 * GET /organizations
 */
export async function listAllOrganizations(req: Request, res: Response): Promise<void> {
  if (!requireSystemAdmin(req, res)) return;

  try {
    const organizations = await Organization.find()
      .populate('owner', 'username email')
      .sort({ createdAt: -1 })
      .lean();

    const orgsWithCount = organizations.map(org => ({
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
      description: org.description || '',
      memberCount: org.members?.length || 0,
      ownerId: org.owner?.toString(),
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
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
  if (!requireAuth(req, res)) return;

  try {
    const { id } = req.params;

    if (!isSystemAdmin(req) && req.user!.organizationId !== id) {
      return sendError(res, 403, 'Forbidden');
    }

    const org = await Organization.findById(toOrgId(id))
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
        description: org.description || '',
        memberCount: org.members?.length || 0,
        ownerId: org.owner?.toString(),
        members: org.members,
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
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
  if (!requireSystemAdmin(req, res)) return;

  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const org = await Organization.findById(toOrgId(id));
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    if (name !== undefined) org.name = name;
    if (description !== undefined) org.description = description;

    await org.save();

    logger.info(`[UPDATE ORG] Organization ${id} updated by system admin ${req.user!.sub}`);

    res.json({
      success: true,
      statusCode: 200,
      message: 'Organization updated successfully',
      organization: {
        id: org._id.toString(),
        name: org.name,
        slug: org.slug,
        description: org.description || '',
      },
    });
  } catch (err) {
    logger.error('[UPDATE ORG] Update Error:', err);
    return sendError(res, 500, 'Error updating organization');
  }
}

/**
 * Delete organization (System Admin only)
 * DELETE /organization/:id
 */
export async function deleteOrganization(req: Request, res: Response): Promise<void> {
  if (!requireSystemAdmin(req, res)) return;

  const session = await mongoose.startSession();

  try {
    const { id } = req.params;

    if (id === 'system') {
      return sendError(res, 400, 'Cannot delete system organization');
    }

    const queryId = toOrgId(id);

    await session.withTransaction(async () => {
      const org = await Organization.findById(queryId).session(session);
      if (!org) throw new Error('ORG_NOT_FOUND');

      await User.updateMany({ organizationId: queryId }, { $unset: { organizationId: '' } }).session(session);
      await Organization.findByIdAndDelete(queryId).session(session);
    });

    logger.info(`[DELETE ORG] Organization ${id} deleted by system admin ${req.user!.sub}`);
    res.json({ success: true, statusCode: 200, message: 'Organization deleted successfully' });
  } catch (err: any) {
    if (err.message === 'ORG_NOT_FOUND') {
      return sendError(res, 404, 'Organization not found');
    }
    logger.error('[DELETE ORG] Failed:', err);
    return sendError(res, 500, 'Failed to delete organization');
  } finally {
    await session.endSession();
  }
}

// ============================================================================
// Quota Management (System Admin)
// ============================================================================

/**
 * Get organization quotas (System Admin only)
 * GET /organization/:id/quotas
 */
export async function getOrganizationQuotas(req: Request, res: Response): Promise<void> {
  if (!requireSystemAdmin(req, res)) return;

  try {
    const idRaw = req.params.id;
    const id = Array.isArray(idRaw) ? idRaw[0] : idRaw;

    const org = await Organization.findById(toOrgId(id));
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    const authHeader = req.headers.authorization || '';
    const quotaTypes = ['plugins', 'pipelines', 'apiCalls'] as const;
    const quotas: any = {};

    // Fetch quota status from the quota microservice
    for (const type of quotaTypes) {
      const quotaStatus = await getOrganizationQuotaStatus(id, type as QuotaType, authHeader);

      if (quotaStatus) {
        quotas[type] = {
          used: quotaStatus.used,
          limit: formatQuotaValue(quotaStatus.limit),
          remaining: formatQuotaValue(quotaStatus.remaining),
          resetAt: quotaStatus.resetAt,
          resetPeriod: config.quota.resetPeriod?.[type] || '3days',
          unlimited: quotaStatus.unlimited,
        };
      } else {
        // Fallback to organization document if service unavailable
        const limit = org.quotas?.[type] ?? -1;
        const used = org.usage?.[type]?.used ?? 0;
        quotas[type] = {
          used,
          limit: formatQuotaValue(limit),
          remaining: formatQuotaValue(limit === -1 ? -1 : Math.max(0, limit - used)),
          resetAt: org.usage?.[type]?.resetAt || new Date(),
          resetPeriod: config.quota.resetPeriod?.[type] || '3days',
          unlimited: limit === -1,
        };
      }
    }

    res.json({ success: true, statusCode: 200, quotas });
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
  if (!requireSystemAdmin(req, res)) return;

  try {
    const idRaw = req.params.id;
    const id = Array.isArray(idRaw) ? idRaw[0] : idRaw;
    const { plugins, pipelines, apiCalls } = req.body;

    const org = await Organization.findById(toOrgId(id));
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    // Parse quota values
    const quotaLimits: { plugins?: number; pipelines?: number; apiCalls?: number } = {};

    const parsedPlugins = parseQuotaValue(plugins);
    if (parsedPlugins !== undefined) quotaLimits.plugins = parsedPlugins;

    const parsedPipelines = parseQuotaValue(pipelines);
    if (parsedPipelines !== undefined) quotaLimits.pipelines = parsedPipelines;

    const parsedApiCalls = parseQuotaValue(apiCalls);
    if (parsedApiCalls !== undefined) quotaLimits.apiCalls = parsedApiCalls;

    // Try to update via quota service first
    const authHeader = req.headers.authorization || '';
    const serviceUpdated = await updateQuotaLimits(id, quotaLimits, authHeader);

    if (!serviceUpdated) {
      // Fallback: Update organization directly in MongoDB
      if (!org.quotas) {
        org.quotas = {
          plugins: config.quota.organization.plugins,
          pipelines: config.quota.organization.pipelines,
          apiCalls: config.quota.organization.apiCalls,
        };
      }

      for (const [key, value] of Object.entries(quotaLimits)) {
        if (value !== undefined) {
          org.quotas[key as keyof typeof org.quotas] = value;
        }
      }

      await org.save();
      logger.info(`[UPDATE ORG QUOTAS] Organization ${id} quotas updated directly (service unavailable)`);
    } else {
      // Refresh org from database to get updated values
      await org.save(); // Ensure any local changes are saved
      logger.info(`[UPDATE ORG QUOTAS] Organization ${id} quotas updated via service by system admin ${req.user!.sub}`);
    }

    // Fetch the latest quota values
    const updatedOrg = await Organization.findById(toOrgId(id));
    const finalQuotas = updatedOrg?.quotas || org.quotas;

    res.json({
      success: true,
      statusCode: 200,
      message: 'Organization quotas updated successfully',
      quotas: {
        plugins: { limit: formatQuotaValue(finalQuotas.plugins), unlimited: finalQuotas.plugins === -1 },
        pipelines: { limit: formatQuotaValue(finalQuotas.pipelines), unlimited: finalQuotas.pipelines === -1 },
        apiCalls: { limit: formatQuotaValue(finalQuotas.apiCalls), unlimited: finalQuotas.apiCalls === -1 },
      },
    });
  } catch (err) {
    logger.error('[UPDATE ORG QUOTAS] Update Error:', err);
    return sendError(res, 500, 'Error updating organization quotas');
  }
}

// ============================================================================
// Current User's Organization
// ============================================================================

/**
 * Get current user's organization
 * GET /organization
 */
export async function getMyOrganization(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const orgId = req.user!.organizationId;
    if (!orgId) {
      return sendError(res, 404, 'No organization associated with this user');
    }

    const org = await Organization.findById(toOrgId(orgId as string))
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

    const members = (org.members || []).map((member: any) => ({
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

    const { userId, email } = req.body;

    if (!userId && !email) {
      return sendError(res, 400, 'userId or email is required');
    }

    await session.withTransaction(async () => {
      const org = await Organization.findById(toOrgId(id)).session(session);
      if (!org) throw new Error('ORG_NOT_FOUND');

      const user = userId
        ? await User.findById(userId).session(session)
        : await User.findOne({ email: email.toLowerCase() }).session(session);

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
      user.organizationId = org._id as any;

      await org.save({ session });
      await user.save({ session });
    });

    logger.info(`[ADD MEMBER TO ORG] User added to Org ${id} by ${admin.adminType} ${req.user!.sub}`);
    res.json({ success: true, statusCode: 200, message: 'Member added successfully' });
  } catch (err: any) {
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
  } catch (err: any) {
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
    const { role } = req.body;
    const admin = getAdminContext(req);

    if (!admin.isSysAdmin && (!admin.isOrgAdmin || req.user!.organizationId !== id)) {
      return sendError(res, 403, 'Forbidden: Admin access required for this organization');
    }

    if (admin.isOrgAdmin && userId === req.user!.sub) {
      return sendError(res, 400, 'Cannot change your own role');
    }

    if (!role || !['user', 'admin'].includes(role)) {
      return sendError(res, 400, 'Valid role (user or admin) is required');
    }

    const org = await Organization.findById(toOrgId(id));
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    if (!org.members.some(m => m.toString() === userId)) {
      return sendError(res, 400, 'User is not a member of this organization');
    }

    if (org.owner.toString() === userId && role !== 'admin') {
      return sendError(res, 400, 'Cannot change organization owner role. Transfer ownership first.');
    }

    const user = await User.findById(userId);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    user.role = role;
    await user.save();

    logger.info(`[UPDATE MEMBER ROLE] User ${userId} role updated to ${role} in Org ${id} by ${admin.adminType} ${req.user!.sub}`);

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
    const { newOwnerId } = req.body;
    const isSysAdmin = isSystemAdmin(req);

    if (!newOwnerId) {
      return sendError(res, 400, 'New owner ID is required');
    }

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

      org.owner = newOwnerId as any;
      newOwner.role = 'admin';

      await org.save({ session });
      await newOwner.save({ session });
    });

    const adminType = isSysAdmin ? 'system admin' : 'org owner';
    logger.info(`[TRANSFER ORG OWNERSHIP] Org ${id} ownership transferred to ${newOwnerId} by ${adminType} ${req.user!.sub}`);
    res.json({ success: true, statusCode: 200, message: 'Ownership transferred successfully' });
  } catch (err: any) {
    handleTransactionError(res, err, {
      ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
      USER_NOT_FOUND: { status: 404, message: 'User not found' },
      NEW_OWNER_MUST_BE_MEMBER: { status: 400, message: 'New owner must be a member of the organization' },
    }, 'Failed to transfer ownership');
  } finally {
    await session.endSession();
  }
}