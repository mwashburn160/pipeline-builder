// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit';
import {
  isSystemAdmin,
  requireAuth,
  requireSystemAdmin,
  withController,
} from '../helpers/controller-helper';
import {
  organizationService,
  ORG_NOT_FOUND,
  SYSTEM_ORG_DELETE_FORBIDDEN,
} from '../services';
import { parsePagination } from '../utils/pagination';
import { validateBody, createOrganizationSchema, updateOrganizationSchema, updateQuotasSchema } from '../utils/validation';

const logger = createLogger('OrganizationController');

/**
 * Parse a quota value from user input.
 * Accepts numbers >= -1 or the string 'unlimited' (mapped to -1).
 */
function parseQuotaValue(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (value === 'unlimited' || value === -1) return -1;
  const num = Number(value);
  return !isNaN(num) && num >= -1 ? num : undefined;
}

// Organization CRUD (System Admin)

export const listAllOrganizations = withController('List organizations', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const { offset, limit } = parsePagination(req.query.offset, req.query.limit);

  const { organizations, total } = await organizationService.list({ search, offset, limit });

  sendSuccess(res, 200, {
    organizations,
    pagination: { total, offset, limit, hasMore: offset + limit < total },
  });
});

export const createOrganization = withController('Create organization', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const body = validateBody(createOrganizationSchema, req.body, res);
  if (!body) return;

  const result = await organizationService.create(req.user!.sub, body);

  audit(req, 'org.create', { targetType: 'organization', targetId: result.id });
  logger.info(`Org created by ${req.user!.sub}`, { id: result.id });
  sendSuccess(res, 201, { organization: result }, 'Organization created successfully');
});

export const getOrganizationById = withController('Get organization', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const idRaw = req.params.id;
  const id = Array.isArray(idRaw) ? idRaw[0] : idRaw;
  if (!isSystemAdmin(req) && req.user!.organizationId !== id) {
    return sendError(res, 403, 'Forbidden');
  }

  const org = await organizationService.getById(id);
  if (!org) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, org);
});

export const updateOrganization = withController('Update organization', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const body = validateBody(updateOrganizationSchema, req.body, res);
  if (!body) return;

  const idRaw = req.params.id;
  const id = Array.isArray(idRaw) ? idRaw[0] : idRaw;
  const updated = await organizationService.update(id, body);
  if (!updated) return sendError(res, 404, 'Organization not found');

  logger.info(`Organization ${id} updated by system admin ${req.user!.sub}`);
  sendSuccess(res, 200, { organization: updated }, 'Organization updated successfully');
});

export const deleteOrganization = withController('Delete organization', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const idRaw = req.params.id;
  const id = Array.isArray(idRaw) ? idRaw[0] : idRaw;
  await organizationService.delete(id);

  logger.info(`Organization ${id} deleted by system admin ${req.user!.sub}`);
  audit(req, 'admin.org.delete', { targetType: 'organization', targetId: String(id) });
  sendSuccess(res, 200, undefined, 'Organization deleted successfully');
}, {
  [ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [SYSTEM_ORG_DELETE_FORBIDDEN]: { status: 400, message: 'Cannot delete system organization' },
});

// Quota Management (System Admin)

export const getOrganizationQuotas = withController('Get organization quotas', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const idRaw = req.params.id;
  const id = Array.isArray(idRaw) ? idRaw[0] : idRaw;

  const quotas = await organizationService.getQuotas(id, req.headers.authorization || '');
  if (!quotas) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, { quotas });
});

export const updateOrganizationQuotas = withController('Update organization quotas', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const body = validateBody(updateQuotasSchema, req.body, res);
  if (!body) return;

  const idRaw = req.params.id;
  const id = Array.isArray(idRaw) ? idRaw[0] : idRaw;

  const quotaLimits: { plugins?: number; pipelines?: number; apiCalls?: number; aiCalls?: number } = {};
  const parsedPlugins = parseQuotaValue(body.plugins);
  if (parsedPlugins !== undefined) quotaLimits.plugins = parsedPlugins;
  const parsedPipelines = parseQuotaValue(body.pipelines);
  if (parsedPipelines !== undefined) quotaLimits.pipelines = parsedPipelines;
  const parsedApiCalls = parseQuotaValue(body.apiCalls);
  if (parsedApiCalls !== undefined) quotaLimits.apiCalls = parsedApiCalls;
  const parsedAiCalls = parseQuotaValue(body.aiCalls);
  if (parsedAiCalls !== undefined) quotaLimits.aiCalls = parsedAiCalls;

  const quotas = await organizationService.updateQuotas(id, quotaLimits, req.headers.authorization || '');
  if (!quotas) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, { quotas }, 'Organization quotas updated successfully');
});

// Current User's Organization

export const getMyOrganization = withController('Get my organization', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const orgId = req.user!.organizationId;
  if (!orgId) return sendError(res, 404, 'No organization associated with this user');

  const org = await organizationService.getById(orgId as string);
  if (!org) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, { organization: org });
});

// AI Provider Configuration

export const getOrgAIConfig = withController('Get AI config', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const orgId = req.user!.organizationId;
  if (!orgId) return sendError(res, 404, 'No organization associated with this user');

  const providers = await organizationService.getAIConfig(orgId as string);
  if (!providers) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, { providers });
});

export const updateOrgAIConfig = withController('Update AI config', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const orgId = req.user!.organizationId;
  if (!orgId) return sendError(res, 404, 'No organization associated with this user');

  const providers = await organizationService.updateAIConfig(orgId as string, req.body);
  if (!providers) return sendError(res, 404, 'Organization not found');

  logger.info(`Organization ${orgId} AI config updated by ${req.user!.sub}`);
  sendSuccess(res, 200, { providers }, 'AI provider configuration updated');
});
