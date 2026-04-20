// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { config } from '../config';
import { audit } from '../helpers/audit';
import {
  isSystemAdmin,
  requireAuth,
  requireSystemAdmin,
  toOrgId,
  withController,
} from '../helpers/controller-helper';
import {
  getOrganizationQuotaStatus,
  updateQuotaLimits,
  QuotaType,
} from '../middleware/quota';
import { Organization, User, UserOrganization } from '../models';
import type { QuotaTier } from '../models/organization';
import { parsePagination } from '../utils/pagination';
import { validateBody, createOrganizationSchema, updateOrganizationSchema, updateQuotasSchema } from '../utils/validation';

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
export const listAllOrganizations = withController('List organizations', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const { search } = req.query;

  const filter: Record<string, unknown> = {};
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { slug: { $regex: search, $options: 'i' } },
    ];
  }

  const { offset, limit: limitNum } = parsePagination(req.query.offset, req.query.limit);

  const [organizations, total] = await Promise.all([
    Organization.find(filter)
      .populate('owner', 'username email')
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limitNum)
      .lean(),
    Organization.countDocuments(filter),
  ]);

  // Fetch member counts for all returned orgs in parallel
  const memberCounts = await Promise.all(
    organizations.map(org => UserOrganization.countDocuments({ organizationId: org._id, isActive: true })),
  );

  const orgsWithCount = organizations.map((org, idx) => ({
    id: org._id.toString(),
    name: org.name,
    slug: org.slug,
    description: org.description || '',
    memberCount: memberCounts[idx],
    ownerId: org.owner?.toString(),
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  }));

  sendSuccess(res, 200, {
    organizations: orgsWithCount,
    pagination: { total, offset, limit: limitNum, hasMore: offset + limitNum < total },
  });
});

/**
 * Create a new organization.
 * POST /organization
 *
 * Creates an Organization and a {@link UserOrganization} record
 * linking the authenticated user as the owner. Sets the user's
 * `lastActiveOrgId` to the new organization.
 */
export const createOrganization = withController('Create organization', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const body = validateBody(createOrganizationSchema, req.body, res);
  if (!body) return;

  const session = await mongoose.startSession();

  try {
    let result: Record<string, unknown> | undefined;

    await session.withTransaction(async () => {
      const userId = req.user!.sub;

      const tier = body.tier || 'developer';
      const tierConfig = config.quota.tier[tier];

      const orgData: Record<string, unknown> = {
        name: body.name,
        description: body.description || '',
        owner: userId,
        tier,
      };

      // Set quota limits from tier config (developer limits are the model default,
      // but we set them explicitly for all tiers for consistency)
      if (tierConfig) {
        orgData.quotas = {
          plugins: tierConfig.plugins,
          pipelines: tierConfig.pipelines,
          apiCalls: tierConfig.apiCalls,
        };
      }

      const [org] = await Organization.create([orgData], { session });

      await UserOrganization.create([{
        userId,
        organizationId: org._id,
        role: 'owner',
      }], { session });

      await User.updateOne(
        { _id: userId },
        { $set: { lastActiveOrgId: org._id } },
      ).session(session);

      result = {
        id: org._id.toString(),
        name: org.name,
        slug: org.slug,
        description: org.description || '',
        tier,
      };
    });

    audit(req, 'org.create', { targetType: 'organization', targetId: (result as Record<string, string>)?.id });
    logger.info(`[CREATE ORG] Org created by ${req.user!.sub}`, result);
    sendSuccess(res, 201, { organization: result }, 'Organization created successfully');
  } finally {
    await session.endSession();
  }
});

/**
 * Get organization by ID
 * GET /organization/:id
 */
export const getOrganizationById = withController('Get organization', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const { id } = req.params;

  if (!isSystemAdmin(req) && req.user!.organizationId !== id) {
    return sendError(res, 403, 'Forbidden');
  }

  const org = await Organization.findById(toOrgId(id))
    .populate('owner', 'username email')
    .lean();

  if (!org) {
    return sendError(res, 404, 'Organization not found');
  }

  // Fetch members from junction collection
  const [memberships, memberCount] = await Promise.all([
    UserOrganization.find({ organizationId: org._id }).populate('userId', 'username email').lean(),
    UserOrganization.countDocuments({ organizationId: org._id }),
  ]);

  const members = memberships.map(m => ({
    ...(m.userId as unknown as Record<string, unknown>),
    role: m.role,
    joinedAt: m.joinedAt,
  }));

  sendSuccess(res, 200, {
    id: org._id.toString(),
    name: org.name,
    slug: org.slug,
    description: org.description || '',
    memberCount,
    ownerId: org.owner?.toString(),
    members,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  });
});

/**
 * Update organization (System Admin only)
 * PUT /organization/:id
 */
export const updateOrganization = withController('Update organization', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

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
});

/**
 * Delete organization (System Admin only)
 * DELETE /organization/:id
 */
export const deleteOrganization = withController('Delete organization', async (req, res) => {
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

      await UserOrganization.deleteMany({ organizationId: queryId }).session(session);
      await User.updateMany({ lastActiveOrgId: queryId }, { $unset: { lastActiveOrgId: '' } }).session(session);
      await Organization.findByIdAndDelete(queryId).session(session);
    });

    logger.info(`[DELETE ORG] Organization ${id} deleted by system admin ${req.user!.sub}`);
    audit(req, 'admin.org.delete', { targetType: 'organization', targetId: String(id) });
    sendSuccess(res, 200, undefined, 'Organization deleted successfully');
  } finally {
    await session.endSession();
  }
}, {
  ORG_NOT_FOUND: { status: 404, message: 'Organization not found' },
});

// Quota Management (System Admin)

/**
 * Get organization quotas (System Admin only)
 * GET /organization/:id/quotas
 */
export const getOrganizationQuotas = withController('Get organization quotas', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

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
});

/**
 * Update organization quotas (System Admin only)
 * PUT /organization/:id/quotas
 */
export const updateOrganizationQuotas = withController('Update organization quotas', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

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
});

// Current User's Organization

/**
 * Get current user's organization
 * GET /organization
 */
export const getMyOrganization = withController('Get my organization', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const orgId = req.user!.organizationId;
  if (!orgId) {
    return sendError(res, 404, 'No organization associated with this user');
  }

  const org = await Organization.findById(toOrgId(orgId as string))
    .populate('owner', 'username email')
    .lean();

  if (!org) {
    return sendError(res, 404, 'Organization not found');
  }

  // Fetch members from junction collection
  const memberships = await UserOrganization.find({ organizationId: org._id })
    .populate('userId', 'username email')
    .lean();

  const members = memberships.map(m => ({
    ...(m.userId as unknown as Record<string, unknown>),
    role: m.role,
    joinedAt: m.joinedAt,
  }));

  sendSuccess(res, 200, { organization: { ...org, members } });
});

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
export const getOrgAIConfig = withController('Get AI config', async (req, res) => {
  if (!requireAuth(req, res)) return;

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
});

/**
 * Update organization AI provider keys
 * PUT /organization/ai-config
 */
export const updateOrgAIConfig = withController('Update AI config', async (req, res) => {
  if (!requireAuth(req, res)) return;

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
});
