// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit';
import {
  canAccessOrg,
  canAdministerOrg,
  requireAuth,
  requireSystemAdmin,
  withController,
} from '../helpers/controller-helper';
import { expandOrgScope } from '../helpers/org-hierarchy';
import {
  organizationService,
  ORG_NOT_FOUND,
  SYSTEM_ORG_DELETE_FORBIDDEN,
} from '../services';
import { cascadeDeleteOrg, exportOrg } from '../services/org-cascade-service';
import { parsePagination } from '../utils/pagination';
import { validateBody, createOrganizationSchema, updateOrganizationSchema, updateQuotasSchema } from '../utils/validation';

const logger = createLogger('organization-controller');

/**
 * Parse a quota value from user input.
 * Accepts numbers >= -1 or the string 'unlimited' (mapped to -1).
 */
function parseQuotaValue(value: unknown): number | undefined {
  // Treat null as "absent" so an explicit `null` in the request body doesn't
  // produce `NaN >= -1` (false) and silently drop the field with no signal —
  // callers expect undefined to mean "leave as-is".
  if (value === undefined || value === null) return undefined;
  if (value === 'unlimited' || value === -1) return -1;
  const num = Number(value);
  return !isNaN(num) && num >= -1 ? num: undefined;
}

// Organization CRUD (System Admin)

export const listAllOrganizations = withController('List organizations', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const search = typeof req.query.search === 'string' ? req.query.search: undefined;
  // Tier facet — passed through verbatim; service coerces invalid values
  // to "no filter" via the QuotaTier union (Mongo just no-ops on unknown enums).
  const tierRaw = typeof req.query.tier === 'string' ? req.query.tier: undefined;
  const tier = tierRaw && ['developer', 'pro', 'unlimited'].includes(tierRaw)
    ? (tierRaw as 'developer' | 'pro' | 'unlimited')
    : undefined;
  const { offset, limit } = parsePagination(req.query.offset, req.query.limit);

  const { organizations, total } = await organizationService.list({ search, tier, offset, limit });

  sendSuccess(res, 200, {
    organizations,
    pagination: { total, offset, limit, hasMore: offset + limit < total },
  });
});

export const createOrganization = withController('Create organization', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const body = validateBody(createOrganizationSchema, req.body, res);
  if (!body) return;

  // Creating a team (nested org) requires admin/owner over the parent (or an
  // ancestor), and the parent must itself be a root org (one nesting level).
  if (body.parentOrgId) {
    if (!(await canAdministerOrg(req, body.parentOrgId))) {
      return sendError(res, 403, 'You must be an admin of the parent organization to create a team under it');
    }
    const eligibility = await organizationService.checkParentEligible(body.parentOrgId);
    if (eligibility === 'not-found') return sendError(res, 404, 'Parent organization not found');
    if (eligibility === 'not-root') {
      return sendError(res, 400, 'Teams can only be nested one level deep (the parent must be a top-level organization)');
    }
  }

  const result = await organizationService.create(req.user!.sub, body);

  audit(req, 'org.create', {
    targetType: 'organization',
    targetId: result.id,
    ...(body.parentOrgId && { details: { parentOrgId: body.parentOrgId } }),
  });
  logger.info(`Org created by ${req.user!.sub}`, { id: result.id, parentOrgId: body.parentOrgId });
  sendSuccess(res, 201, { organization: result }, 'Organization created successfully');
});

export const getOrganizationById = withController('Get organization', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = getParam(req.params, 'id')!;
  // Own org (any member), a team you manage (parent-org admin), or sysadmin.
  if (!(await canAccessOrg(req, id))) {
    return sendError(res, 403, 'Forbidden');
  }

  const org = await organizationService.getById(id);
  if (!org) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, org);
});

/**
 * GET /organization/:id/descendants — the org → team subtree as a flat id list
 * (`[self, ...descendantOrgIds]`). Used by peer services (reporting rollup) and
 * the dashboard to aggregate a parent over its teams. Readable by anyone who
 * can access the org (own org, an ancestor admin, or sysadmin).
 */
export const getOrganizationDescendants = withController('Get org descendants', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = getParam(req.params, 'id')!;
  if (!(await canAccessOrg(req, id))) {
    return sendError(res, 403, 'Forbidden');
  }

  const orgIds = await expandOrgScope(id);
  sendSuccess(res, 200, { orgIds });
});

export const updateOrganization = withController('Update organization', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const body = validateBody(updateOrganizationSchema, req.body, res);
  if (!body) return;

  const id = getParam(req.params, 'id')!;
  const updated = await organizationService.update(id, body);
  if (!updated) return sendError(res, 404, 'Organization not found');

  logger.info(`Organization ${id} updated by system admin ${req.user!.sub}`);
  sendSuccess(res, 200, { organization: updated }, 'Organization updated successfully');
});

/**
 * PATCH /organization/:id/tier — sysadmin tier change.
 *
 * Body: `{ tier: 'developer' | 'pro' | 'unlimited' }`. Reseeds the
 * org's quota limits from the new tier's config. The audit event
 * carries the previous tier so the transition is reconstructable
 * even if the org doc has been rewritten since.
 */
export const updateOrganizationTier = withController('Update organization tier', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const id = getParam(req.params, 'id')!;
  const tier = (req.body as { tier?: unknown })?.tier;
  if (tier !== 'developer' && tier !== 'pro' && tier !== 'unlimited') {
    return sendError(res, 400, 'tier must be one of: developer, pro, unlimited');
  }

  const result = await organizationService.setTier(id, tier);
  if (!result) return sendError(res, 404, 'Organization not found');

  audit(req, 'admin.org.tier.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { previousTier: result.previousTier, tier: result.tier },
  });
  logger.info('Organization tier updated', { id, tier, previousTier: result.previousTier, by: req.user!.sub });
  sendSuccess(res, 200, result, 'Tier updated successfully');
});

export const deleteOrganization = withController('Delete organization', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const id = getParam(req.params, 'id')!;

  // full cascade across Postgres, Mongo, quota, billing BEFORE the
  // org doc itself is deleted. Cascade returns a report so the audit event
  // captures what was actually touched. We let cascade failures propagate;
  // a partial state is worse than retrying the whole sweep.
  const actorOrgId = (req.user!.organizationId as string) ?? 'system';
  const cascadeReport = await cascadeDeleteOrg(id, actorOrgId);

  await organizationService.delete(id);

  logger.info(`Organization ${id} deleted by system admin ${req.user!.sub}`, { cascade: cascadeReport });
  // `affectedOrgId` is the org being deleted (the action's target), not the
  // sysadmin's own org. Lets the audit log answer "which orgs has a sysadmin
  // dissolved" without joining against `details`.
  audit(req, 'admin.org.delete', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { cascade: cascadeReport },
  });
  sendSuccess(res, 200, { cascade: cascadeReport }, 'Organization deleted successfully');
}, {
  [ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [SYSTEM_ORG_DELETE_FORBIDDEN]: { status: 400, message: 'Cannot delete system organization' },
});

/**
 * GDPR portability export. System admins can export any org;
 * org admins / owners can export their own org only. Returns a single
 * JSON blob with every Postgres + Mongo row for the target org. Read-only.
 */
export const exportOrganization = withController('Export organization', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = getParam(req.params, 'id')!;
  const actorOrgId = (req.user!.organizationId as string) ?? 'system';
  // Sysadmin, own-org admin/owner, or admin/owner of a parent org managing
  // this team. Members and unrelated orgs are refused.
  if (!(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'Org admins can only export their own org or a team they manage');
  }

  const dump = await exportOrg(id, actorOrgId);

  audit(req, 'admin.org.export', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      postgresTables: Object.keys(dump.postgres).length,
      invitations: dump.mongo.invitations.length,
      auditEvents: dump.mongo.auditEvents.length,
    },
  });

  // Stream the dump as application/json; the file may be large for orgs with
  // long histories. Setting `Content-Disposition: attachment` makes browsers
  // save instead of render.
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="org-${id}-export.json"`);
  res.status(200).send(JSON.stringify(dump, null, 2));
});

// Quota Management (System Admin)

export const getOrganizationQuotas = withController('Get organization quotas', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const id = getParam(req.params, 'id')!;

  const quotas = await organizationService.getQuotas(id, req.headers.authorization || '');
  if (!quotas) return sendError(res, 404, 'Organization not found');

  sendSuccess(res, 200, { quotas });
});

export const updateOrganizationQuotas = withController('Update organization quotas', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const body = validateBody(updateQuotasSchema, req.body, res);
  if (!body) return;

  const id = getParam(req.params, 'id')!;

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
