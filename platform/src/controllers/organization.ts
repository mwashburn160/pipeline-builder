import { createLogger, sendError, sendSuccess, SYSTEM_ORG_ID } from '@mwashburn160/api-core';
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
} from '../middleware/quota';
import { Organization, User } from '../models';
import type { QuotaTier } from '../models/organization';
import { parsePagination } from '../utils/pagination';
import { validateBody, updateOrganizationSchema, updateQuotasSchema } from '../utils/validation';

const logger = createLogger('OrganizationController');

// Quota Helpers

/**
 * Format a quota limit for API responses.
 * @param value - Raw numeric limit (-1 means unlimited)
 * @returns The numeric value, or the string 'unlimited' when -1
 */
function formatQuotaValue(value: number): number | string {
  return value === -1 ? 'unlimited' : value;
}

/**
 * Parse a quota value from user input.
 * Accepts numbers >= -1 or the string 'unlimited' (mapped to -1).
 * @param value - Raw input value
 * @returns Parsed number, or undefined if invalid/absent
 */
function parseQuotaValue(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (value === 'unlimited' || value === -1) return -1;
  const num = Number(value);
  return !isNaN(num) && num >= -1 ? num : undefined;
}

// Organization CRUD (System Admin)

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

    const { page: pageNum, limit: limitNum, skip } = parsePagination(page, limit);

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

    sendSuccess(res, 200, {
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

    sendSuccess(res, 200, {
      id: org._id.toString(),
      name: org.name,
      slug: org.slug,
      description: org.description || '',
      memberCount: org.members?.length || 0,
      ownerId: org.owner?.toString(),
      members: org.members,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
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

    sendSuccess(res, 200, {
      organization: {
        id: org._id.toString(),
        name: org.name,
        slug: org.slug,
        description: org.description || '',
      },
    }, 'Organization updated successfully');
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

    if (id === SYSTEM_ORG_ID) {
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
    sendSuccess(res, 200, undefined, 'Organization deleted successfully');
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

// Quota Management (System Admin)

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

    // Fetch quota status from the quota microservice (parallel)
    const results = await Promise.all(
      quotaTypes.map((type) => getOrganizationQuotaStatus(id, type as QuotaType, authHeader)),
    );

    for (let i = 0; i < quotaTypes.length; i++) {
      const type = quotaTypes[i];
      const quotaStatus = results[i];

      if (quotaStatus) {
        quotas[type] = {
          used: quotaStatus.used,
          limit: formatQuotaValue(quotaStatus.limit),
          remaining: formatQuotaValue(quotaStatus.remaining),
          resetAt: new Date(quotaStatus.resetAt),
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

    sendSuccess(res, 200, { quotas });
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

    sendSuccess(res, 200, {
      quotas: {
        plugins: { limit: formatQuotaValue(finalQuotas.plugins), unlimited: finalQuotas.plugins === -1 },
        pipelines: { limit: formatQuotaValue(finalQuotas.pipelines), unlimited: finalQuotas.pipelines === -1 },
        apiCalls: { limit: formatQuotaValue(finalQuotas.apiCalls), unlimited: finalQuotas.apiCalls === -1 },
      },
    }, 'Organization quotas updated successfully');
  } catch (error) {
    logger.error('[UPDATE ORG QUOTAS] Update Error:', error);
    return sendError(res, 500, 'Error updating organization quotas');
  }
}

// Current User's Organization

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

    sendSuccess(res, 200, { organization: org });
  } catch (error) {
    logger.error('[GET ORG] Fetch Error:', error);
    return sendError(res, 500, 'Error fetching organization');
  }
}

// AI Provider Configuration

/** Supported AI provider identifiers. */
const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'amazon-bedrock'] as const;

/**
 * Mask an API key for safe display, showing only the last 4 characters.
 * @param key - Full API key string
 * @returns Masked string (e.g. '...abcd')
 */
function maskKey(key: string): string {
  if (key.length <= 4) return '****';
  return '...' + key.slice(-4);
}

/**
 * Get organization AI provider configuration
 * GET /organization/ai-config
 */
export async function getOrgAIConfig(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const orgId = req.user!.organizationId;
    if (!orgId) {
      return sendError(res, 404, 'No organization associated with this user');
    }

    const org = await Organization.findById(toOrgId(orgId as string)).select('aiProviderKeys').lean();
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    const keys = org.aiProviderKeys || {};
    const providers: Record<string, { configured: boolean; hint?: string }> = {};

    for (const p of AI_PROVIDERS) {
      const key = keys[p];
      providers[p] = key
        ? { configured: true, hint: maskKey(key) }
        : { configured: false };
    }

    sendSuccess(res, 200, { providers });
  } catch (error) {
    logger.error('[GET AI CONFIG] Fetch Error:', error);
    return sendError(res, 500, 'Error fetching AI configuration');
  }
}

/**
 * Update organization AI provider keys
 * PUT /organization/ai-config
 */
export async function updateOrgAIConfig(req: Request, res: Response): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const orgId = req.user!.organizationId;
    if (!orgId) {
      return sendError(res, 404, 'No organization associated with this user');
    }

    const org = await Organization.findById(toOrgId(orgId as string));
    if (!org) {
      return sendError(res, 404, 'Organization not found');
    }

    if (!org.aiProviderKeys) {
      org.aiProviderKeys = {};
    }

    for (const p of AI_PROVIDERS) {
      const value = req.body[p];
      if (value === undefined) continue;
      if (value === null || value === '') {
        org.aiProviderKeys[p] = undefined;
      } else if (typeof value === 'string') {
        org.aiProviderKeys[p] = value;
      }
    }

    org.markModified('aiProviderKeys');
    await org.save();

    logger.info(`[UPDATE AI CONFIG] Organization ${orgId} AI config updated by ${req.user!.sub}`);

    // Return updated state
    const providers: Record<string, { configured: boolean; hint?: string }> = {};
    for (const p of AI_PROVIDERS) {
      const key = org.aiProviderKeys[p];
      providers[p] = key
        ? { configured: true, hint: maskKey(key) }
        : { configured: false };
    }

    sendSuccess(res, 200, { providers }, 'AI provider configuration updated');
  } catch (error) {
    logger.error('[UPDATE AI CONFIG] Update Error:', error);
    return sendError(res, 500, 'Error updating AI configuration');
  }
}

