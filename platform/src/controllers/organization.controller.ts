import * as http from 'http';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { config } from '../config';
import { Organization, User } from '../models';
import { logger, sendError } from '../utils';

// =============================================================================
// Quota Service Configuration (consolidated into single service)
// =============================================================================

const QUOTA_SERVICE_HOST = process.env.QUOTA_SERVICE_HOST || 'quota';
const QUOTA_SERVICE_PORT = parseInt(process.env.QUOTA_SERVICE_PORT || '3000', 10);

/**
 * Fetch quota status from the quota microservice.
 */
async function fetchQuotaFromService(
  orgId: string,
  quotaType: string,
  authHeader: string,
): Promise<{ limit: number; used: number; remaining: number; resetAt: string; unlimited: boolean } | null> {
  return new Promise((resolve) => {
    const options: http.RequestOptions = {
      hostname: QUOTA_SERVICE_HOST,
      port: QUOTA_SERVICE_PORT,
      path: `/quotas/${encodeURIComponent(orgId)}/${encodeURIComponent(quotaType)}`,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'x-org-id': orgId,
      },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.success && response.status) {
            resolve({
              limit: response.status.limit,
              used: response.status.used,
              remaining: response.status.remaining,
              resetAt: response.status.resetAt,
              unlimited: response.status.unlimited,
            });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Update quota limits via the quota microservice.
 */
async function updateQuotaViaService(
  orgId: string,
  quotaLimits: { plugins?: number; pipelines?: number; apiCalls?: number },
  authHeader: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ quotaLimits });

    const options: http.RequestOptions = {
      hostname: QUOTA_SERVICE_HOST,
      port: QUOTA_SERVICE_PORT,
      path: `/quotas/${encodeURIComponent(orgId)}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': authHeader,
        'x-org-id': orgId,
      },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve(res.statusCode === 200 || res.statusCode === 201);
      });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ============================================================================
// Auth Helpers
// ============================================================================

function isSystemAdmin(req: Request): boolean {
  if (req.user?.role !== 'admin') return false;
  const orgId = req.user?.organizationId?.toLowerCase();
  const orgName = req.user?.organizationName?.toLowerCase();
  return orgId === 'system' || orgName === 'system';
}

function isOrgAdmin(req: Request): boolean {
  return req.user?.role === 'admin' && !isSystemAdmin(req);
}

function requireAuth(req: Request, res: Response): boolean {
  if (!req.user) {
    sendError(res, 401, 'Unauthorized');
    return false;
  }
  return true;
}

function requireSystemAdmin(req: Request, res: Response): boolean {
  if (!requireAuth(req, res)) return false;
  if (!isSystemAdmin(req)) {
    sendError(res, 403, 'Forbidden: System admin access required');
    return false;
  }
  return true;
}

interface AdminContext {
  isSysAdmin: boolean;
  isOrgAdmin: boolean;
  adminType: string;
}

function getAdminContext(req: Request): AdminContext {
  const isSysAdmin = isSystemAdmin(req);
  return {
    isSysAdmin,
    isOrgAdmin: isOrgAdmin(req),
    adminType: isSysAdmin ? 'system admin' : 'org admin',
  };
}

// ============================================================================
// Error Handling
// ============================================================================

type ErrorMap = Record<string, { status: number; message: string }>;

function handleTransactionError(res: Response, err: any, errorMap: ErrorMap, fallbackMessage: string): void {
  logger.error(fallbackMessage, err);
  const error = errorMap[err.message] || { status: 500, message: fallbackMessage };
  sendError(res, error.status, error.message);
}

// ============================================================================
// Quota Helpers
// ============================================================================

/**
 * Convert a string org ID to ObjectId when valid.
 * Organization._id is Mixed type to support both string IDs ('system')
 * and ObjectId values. findById won't auto-cast strings to ObjectId
 * for Mixed fields, so we must do it explicitly.
 */
function toOrgId(id: string | string[]): string | mongoose.Types.ObjectId {
  const idStr = Array.isArray(id) ? id[0] : id;
  return mongoose.Types.ObjectId.isValid(idStr) && idStr.length === 24
    ? new mongoose.Types.ObjectId(idStr)
    : idStr;
}

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
      description: (org as any).description || '',
      memberCount: org.members?.length || 0,
      ownerId: org.owner?.toString(),
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
        description: (org as any).description || '',
        memberCount: org.members?.length || 0,
        ownerId: org.owner?.toString(),
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
  if (!requireSystemAdmin(req, res)) return;

  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const org = await Organization.findById(toOrgId(id));
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    if (name !== undefined) org.name = name;
    if (description !== undefined) (org as any).description = description;

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
        description: (org as any).description || '',
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
      const quotaStatus = await fetchQuotaFromService(id, type, authHeader);

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
    const serviceUpdated = await updateQuotaViaService(id, quotaLimits, authHeader);

    if (!serviceUpdated) {
      // Fallback: Update organization directly in MongoDB
      if (!org.quotas) {
        (org as any).quotas = {
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

/**
 * Add member to organization (legacy endpoint)
 * POST /organization/members
 */
export async function addMember(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  const session = await mongoose.startSession();

  try {
    const { email } = req.body;
    const organizationId = req.user!.organizationId;
    const requesterId = req.user!.sub;

    if (!organizationId || !requesterId) {
      return sendError(res, 401, 'Unauthorized');
    }

    if (!email) {
      return sendError(res, 400, 'Email is required');
    }

    await session.withTransaction(async () => {
      const org = await Organization.findById(toOrgId(organizationId as string)).session(session);

      if (!org || org.owner.toString() !== requesterId) {
        throw new Error('UNAUTHORIZED');
      }

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
    res.json({ success: true, statusCode: 200, message: 'Member added successfully' });
  } catch (err: any) {
    const errorMap: Record<string, number> = { UNAUTHORIZED: 403, NOT_FOUND: 404, ALREADY_MEMBER: 400 };
    const status = errorMap[err.message] || 400;
    logger.error('[ADD MEMBER] Transaction Failed:', err);
    return sendError(res, status, err.message);
  } finally {
    await session.endSession();
  }
}

/**
 * Transfer organization ownership (legacy endpoint)
 * PATCH /organization/transfer-owner
 */
export async function transferOwnership(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  const session = await mongoose.startSession();

  try {
    const { newOwnerId } = req.body;
    const organizationId = req.user!.organizationId;
    const currentOwnerId = req.user!.sub;

    if (!organizationId || !currentOwnerId) {
      return sendError(res, 401, 'Unauthorized');
    }

    if (!newOwnerId) {
      return sendError(res, 400, 'New owner ID is required');
    }

    await session.withTransaction(async () => {
      const org = await Organization.findById(toOrgId(organizationId as string)).session(session);

      if (!org || org.owner.toString() !== currentOwnerId) {
        throw new Error('UNAUTHORIZED');
      }

      if (!org.members.some(id => id.toString() === newOwnerId)) {
        throw new Error('NEW_OWNER_MUST_BE_MEMBER');
      }

      org.owner = newOwnerId as any;
      await org.save({ session });
    });

    logger.info(`[TRANSFER OWNERSHIP] Org ${organizationId} transferred to ${newOwnerId}`);
    res.json({ success: true, statusCode: 200, message: 'Ownership transferred successfully' });
  } catch (err: any) {
    const status = err.message === 'UNAUTHORIZED' ? 403 : 400;
    logger.error('[TRANSFER OWNERSHIP] Failed:', err);
    return sendError(res, status, err.message);
  } finally {
    await session.endSession();
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