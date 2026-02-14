import { createLogger, sendError } from '@mwashburn160/api-core';
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { config } from '../config';
import {
  isSystemAdmin,
  requireAuth,
  requireSystemAdmin,
  toOrgId,
} from '../helpers/controller-helper';
import {
  getOrganizationQuotaStatus,
  updateQuotaLimits,
  QuotaType,
} from '../middleware/quota.middleware';
import { Organization, User } from '../models';
import type { QuotaTier } from '../models/organization.model';
import { validateBody } from '../utils/auth-utils';
import { updateOrganizationSchema, updateQuotasSchema } from '../validation/schemas';

const logger = createLogger('OrganizationController');

// ============================================================================
// Quota Helpers
// ============================================================================

function formatQuotaValue(value: number): number | string {
  return value === -1 ? 'unlimited' : value;
}

function parseQuotaValue(value: unknown): number | undefined {
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
    const { search, page = '1', limit = '20' } = req.query;

    const filter: Record<string, unknown> = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [organizations, total] = await Promise.all([
      Organization.find(filter)
        .populate('owner', 'username email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Organization.countDocuments(filter),
    ]);

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

    res.json({
      success: true,
      statusCode: 200,
      organizations: orgsWithCount,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    logger.error('[LIST ORGS] Fetch Error:', error);
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
  } catch (error) {
    logger.error('[GET ORG BY ID] Fetch Error:', error);
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
    const body = validateBody(updateOrganizationSchema, req.body, res);
    if (!body) return;

    const org = await Organization.findById(toOrgId(id));
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    if (body.name !== undefined) org.name = body.name;
    if (body.description !== undefined) org.description = body.description;

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
  } catch (error) {
    logger.error('[UPDATE ORG] Update Error:', error);
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
  } catch (error) {
    if (error instanceof Error && error.message === 'ORG_NOT_FOUND') {
      return sendError(res, 404, 'Organization not found');
    }
    logger.error('[DELETE ORG] Failed:', error);
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
    const tierKey = (org.tier || 'developer') as QuotaTier;
    const tierConfig = config.quota.tier[tierKey];
    const quotaTypes = ['plugins', 'pipelines', 'apiCalls'] as const;
    const quotas: Record<string, { used: number; limit: number | string; remaining: number | string; resetAt: Date; resetPeriod: string; unlimited: boolean }> = {};

    // Fetch quota status from the quota microservice
    for (const type of quotaTypes) {
      const quotaStatus = await getOrganizationQuotaStatus(id, type as QuotaType, authHeader);

      if (quotaStatus) {
        quotas[type] = {
          used: quotaStatus.used,
          limit: formatQuotaValue(quotaStatus.limit),
          remaining: formatQuotaValue(quotaStatus.remaining),
          resetAt: quotaStatus.resetAt,
          resetPeriod: tierConfig.resetPeriod[type],
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
          resetPeriod: tierConfig.resetPeriod[type],
          unlimited: limit === -1,
        };
      }
    }

    res.json({ success: true, statusCode: 200, quotas });
  } catch (error) {
    logger.error('[GET ORG QUOTAS] Fetch Error:', error);
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
    const body = validateBody(updateQuotasSchema, req.body, res);
    if (!body) return;

    const org = await Organization.findById(toOrgId(id));
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    // Parse quota values
    const quotaLimits: { plugins?: number; pipelines?: number; apiCalls?: number } = {};

    const parsedPlugins = parseQuotaValue(body.plugins);
    if (parsedPlugins !== undefined) quotaLimits.plugins = parsedPlugins;

    const parsedPipelines = parseQuotaValue(body.pipelines);
    if (parsedPipelines !== undefined) quotaLimits.pipelines = parsedPipelines;

    const parsedApiCalls = parseQuotaValue(body.apiCalls);
    if (parsedApiCalls !== undefined) quotaLimits.apiCalls = parsedApiCalls;

    // Try to update via quota service first
    const authHeader = req.headers.authorization || '';
    const serviceUpdated = await updateQuotaLimits(id, quotaLimits, authHeader);

    if (!serviceUpdated) {
      // Fallback: Update organization directly in MongoDB
      if (!org.quotas) {
        const tierLimits = config.quota.tier[org.tier || 'developer'];
        org.quotas = {
          plugins: tierLimits.plugins,
          pipelines: tierLimits.pipelines,
          apiCalls: tierLimits.apiCalls,
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
  } catch (error) {
    logger.error('[UPDATE ORG QUOTAS] Update Error:', error);
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
  } catch (error) {
    logger.error('[GET ORG] Fetch Error:', error);
    return sendError(res, 500, 'Error fetching organization');
  }
}

