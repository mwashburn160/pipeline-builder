// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, getParam, isServicePrincipal, isSystemAdmin, sendError, sendSuccess, parsePaginationParams, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import {
  canAccessOrg,
  canAdministerOrg,
  requireAuth,
  requireSystemAdmin,
  withController,
} from '../helpers/controller-helper.js';
import { expandOrgScope } from '../helpers/org-hierarchy.js';
import { pooledSeatUsage } from '../helpers/seats.js';
import {
  organizationService,
  ORG_NOT_FOUND,
  SYSTEM_ORG_DELETE_FORBIDDEN,
  ORG_SLUG_TAKEN,
  ORG_AI_KEY_TOO_LONG,
} from '../services/index.js';
import {
  exportOrg,
  softDeleteOrg,
  ORG_ALREADY_DELETED,
  ORG_SNAPSHOT_FAILED,
} from '../services/org-cascade-service.js';
import { validateBody, createOrganizationSchema, updateOrganizationSchema, updateOrgIdentitySchema, updateQuotasSchema } from '../utils/validation.js';

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
  const tier = tierRaw && ['developer', 'pro', 'team', 'enterprise'].includes(tierRaw)
    ? (tierRaw as 'developer' | 'pro' | 'team' | 'enterprise')
    : undefined;
  const { offset, limit } = parsePaginationParams(req.query);

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
    if (eligibility === 'tier-forbidden') {
      return sendError(res, 403, 'Teams require a Team or Enterprise plan — upgrade the organization to create teams');
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

  // Bound the member roster this hot read returns — `memberCount` still reflects
  // the full org, so the UI can page via ?membersOffset/?membersLimit. The
  // service clamps these to a safe range; a missing value falls back to its cap.
  const membersLimit = parseInt(String(req.query.membersLimit), 10);
  const membersOffset = parseInt(String(req.query.membersOffset), 10);
  const org = await organizationService.getById(id, {
    membersLimit: Number.isNaN(membersLimit) ? undefined : membersLimit,
    membersOffset: Number.isNaN(membersOffset) ? undefined : membersOffset,
  });
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

/**
 * GET /organization/:id/parent — the org's direct parent id (org → team
 * hierarchy), or `null` for a root org. A least-privilege internal read for
 * peer services (compliance's scheduled scans run detached from any request/JWT
 * and need the parent to evaluate parent `propagateToChildren` rules); an
 * account/ancestor admin may also read their own. Mirrors the seat-usage gate:
 * service principal OR org-admin, never the broad `canAccessOrg`/full-org body.
 */
export const getOrganizationParent = withController('Get organization parent', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  if (!isServicePrincipal(req) && !(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: service or organization-admin only');
  }
  const org = await organizationService.getById(id);
  if (!org) return sendError(res, 404, 'Organization not found');
  sendSuccess(res, 200, { parentOrgId: org.parentOrgId ?? null });
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
 * PATCH /organization/:id/identity — self-serve org identity edit (name/slug).
 *
 * Unlike `PUT /organization/:id` (sysadmin-only), this is reachable by an org
 * owner/admin for their OWN org (or a parent-org admin over a managed team) via
 * `canAdministerOrg` — the same target-scoped authority gate `exportOrganization`
 * uses. `requirePermission('org:settings')` is the capability gate at the route;
 * this is the tenancy gate. A plain member is refused. Reuses the shared
 * `organizationService.update` logic (name/slug), which enforces slug
 * uniqueness. Does NOT touch tier/quotas/description-via-sysadmin or DELETE.
 */
export const updateOrganizationIdentity = withController('Update organization identity', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = getParam(req.params, 'id')!;
  // Tenancy: sysadmin, own-org admin/owner, or an admin/owner of a parent org
  // managing this team. Members and unrelated orgs are refused — a non-sysadmin
  // can only edit an org they administer.
  if (!(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'You can only edit an organization you administer');
  }

  const body = validateBody(updateOrgIdentitySchema, req.body, res);
  if (!body) return;

  const updated = await organizationService.update(id, body);
  if (!updated) return sendError(res, 404, 'Organization not found');

  audit(req, 'org.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: {
      ...(body.name !== undefined ? { name: updated.name } : {}),
      ...(body.slug !== undefined ? { slug: updated.slug } : {}),
    },
  });
  logger.info(`Organization ${id} identity updated by ${req.user!.sub}`, { fields: Object.keys(body) });
  sendSuccess(res, 200, { organization: updated }, 'Organization updated successfully');
}, {
  [ORG_SLUG_TAKEN]: { status: 409, message: 'That slug is already taken — choose another' },
});

/**
 * PATCH /organization/:id/tier — sysadmin tier change.
 *
 * Body: `{ tier: 'developer' | 'pro' | 'team' | 'enterprise' }`. Reseeds the
 * org's quota limits from the new tier's config. The audit event
 * carries the previous tier so the transition is reconstructable
 * even if the org doc has been rewritten since.
 */
export const updateOrganizationTier = withController('Update organization tier', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;

  const id = getParam(req.params, 'id')!;
  const tier = (req.body as { tier?: unknown })?.tier;
  if (tier !== 'developer' && tier !== 'pro' && tier !== 'team' && tier !== 'enterprise') {
    return sendError(res, 400, 'tier must be one of: developer, pro, team, enterprise');
  }

  // Over-cap gate (docs/billing-bundles.md §8): a downgrade must not strand
  // members/resources. Same protection as the billing plan-change path; a
  // sysadmin can deliberately override with `force: true`.
  const force = (req.body as { force?: unknown })?.force === true;
  if (!force) {
    const overages = await organizationService.checkTierOvercap(id, tier);
    if (overages.length > 0) {
      return sendError(res, 409, 'This tier change would put the account over its limit — remove members/resources first, or pass force=true', 'TIER_OVER_CAP', { overages });
    }
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

  // A root org with live teams must not be deleted directly — it would orphan
  // the teams (dangling `parentOrgId`) and their pooled seats/usage. Require the
  // teams be removed first. `expandOrgScope` returns `[self]` for a flat org or
  // a team (no descendants), so this only blocks a root that still has teams.
  const scope = await expandOrgScope(id);
  if (scope.length > 1) {
    return sendError(res, 400, 'This organization has teams — delete or move its teams before deleting it');
  }

  // SOFT-delete instead of the immediate destructive cascade: capture a durable
  // recovery snapshot, tombstone the org (`deletedAt`/`purgeAfter`) for the
  // configured retention window, and bump every active member's tokenVersion so
  // their sessions are cut immediately. The token chokepoint (`resolveMembership`)
  // then refuses to re-issue a token scoped to the soft-deleted org — access is
  // gone WITHOUT touching the destructive stores. The purge sweep (org-purge.ts)
  // runs the existing fail-closed cascade + hard delete once the window lapses.
  //
  // If the snapshot can't be produced/persisted, softDeleteOrg throws
  // ORG_SNAPSHOT_FAILED and the org is NOT tombstoned — we never lose an org
  // without a recovery snapshot.
  const actorOrgId = (req.user!.organizationId as string) ?? SYSTEM_ORG_ID;
  const result = await softDeleteOrg(id, actorOrgId, req.user!.sub);

  logger.info(`Organization ${id} soft-deleted by system admin ${req.user!.sub}`, {
    purgeAfter: result.purgeAfter, snapshotId: result.snapshotId, membersInvalidated: result.membersInvalidated,
  });
  // `affectedOrgId` is the org being soft-deleted (the action's target), not the
  // sysadmin's own org.
  audit(req, 'org.soft_delete', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { purgeAfter: result.purgeAfter, snapshotId: result.snapshotId, membersInvalidated: result.membersInvalidated },
  });
  sendSuccess(
    res,
    202,
    { deletedAt: result.deletedAt, purgeAfter: result.purgeAfter, snapshotId: result.snapshotId },
    `Organization scheduled for deletion. It can be restored until ${result.purgeAfter.toISOString()}.`,
  );
}, {
  [ORG_NOT_FOUND]: { status: 404, message: 'Organization not found' },
  [ORG_ALREADY_DELETED]: { status: 409, message: 'Organization is already scheduled for deletion' },
  [ORG_SNAPSHOT_FAILED]: { status: 502, message: 'Could not capture the recovery snapshot — the organization was NOT deleted. Retry once the datastore recovers.' },
  [SYSTEM_ORG_DELETE_FORBIDDEN]: { status: 400, message: 'Cannot delete system organization' },
});

/**
 * POST /organization/:id/restore — restore a soft-deleted org within its
 * retention window. Reverses {@link deleteOrganization}: clears the tombstone
 * and bumps member tokenVersion so re-issued tokens see the org live again.
 *
 * Authorized for a sysadmin OR an admin/owner of the org (or a managing parent
 * org) via `canAdministerOrg` — the same target-scoped authority gate `export`
 * uses. `requirePermission('org:settings')` is the capability gate at the route.
 * Refused (404) if the org was already purged (gone — nothing to restore).
 */
export const restoreOrganization = withController('Restore organization', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = getParam(req.params, 'id')!;
  if (!(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'You can only restore an organization you administer');
  }

  const restored = await organizationService.restore(id);
  if (!restored) {
    return sendError(res, 404, 'No organization pending deletion with this id (already purged or never deleted)');
  }

  logger.info(`Organization ${id} restored by ${req.user!.sub}`, { membersInvalidated: restored.membersInvalidated });
  audit(req, 'org.restore', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: id,
    details: { membersInvalidated: restored.membersInvalidated },
  });
  sendSuccess(res, 200, { organization: restored }, 'Organization restored');
});

/**
 * GDPR portability export. System admins can export any org;
 * org admins / owners can export their own org only. Returns a single
 * JSON blob with every Postgres + Mongo row for the target org. Read-only.
 */
export const exportOrganization = withController('Export organization', async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = getParam(req.params, 'id')!;
  const actorOrgId = (req.user!.organizationId as string) ?? SYSTEM_ORG_ID;
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

/**
 * PUT /organization/:id/seat-limit — internal: set the account seat limit.
 *
 * `seats` is platform-owned (not a quota-service type), so the billing service
 * syncs the effective seat entitlement (tier base + bundles) here. Gated to a
 * service principal or a sysadmin; NO step-up (service-to-service). Always
 * applied to the resolved ROOT org.
 */
export const updateOrganizationSeatLimit = withController('Update organization seat limit', async (req, res) => {
  if (!requireAuth(req, res)) return;
  if (!isServicePrincipal(req) && !isSystemAdmin(req)) {
    return sendError(res, 403, 'Forbidden: service or system-admin only');
  }

  const id = getParam(req.params, 'id')!;
  const body = (req.body ?? {}) as { seats?: unknown; features?: unknown };
  if (typeof body.seats !== 'number' || !Number.isInteger(body.seats) || body.seats < -1) {
    return sendError(res, 400, 'seats must be an integer >= -1');
  }
  // Optional account-level feature entitlements (purchased bundles).
  let features: string[] | undefined;
  if (body.features !== undefined) {
    if (!Array.isArray(body.features) || body.features.some((f) => typeof f !== 'string')) {
      return sendError(res, 400, 'features must be an array of strings');
    }
    features = body.features as string[];
  }

  const result = await organizationService.setSeatLimit(id, body.seats, features);
  if (!result) return sendError(res, 404, 'Organization not found');

  // Entitlement mutation on the account root (+ its descendants) — leave an audit
  // trail like every other admin org mutation (setTier, member ops, delete).
  audit(req, 'admin.org.seatLimit.update', {
    targetType: 'organization',
    targetId: id,
    affectedOrgId: result.rootOrgId,
    details: { seats: body.seats, ...(features ? { features } : {}) },
  });
  logger.info('Seat limit synced', { orgId: id, rootOrgId: result.rootOrgId, seats: body.seats, features, by: req.user!.sub });
  sendSuccess(res, 200, result, 'Seat limit updated');
});

/**
 * GET /organization/:id/seat-usage — internal: current pooled seat usage + limit
 * for the account (root). Used by billing's over-cap gate before removing a seat
 * bundle. Service principal or sysadmin.
 */
export const getOrganizationSeatUsage = withController('Get organization seat usage', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const id = getParam(req.params, 'id')!;
  // Billing's over-cap gate calls this with a service token; an account admin
  // (or an ancestor-org admin) may also read their OWN pooled seat usage — it's
  // their own data. pooledSeatUsage resolves `id` to its root internally.
  if (!isServicePrincipal(req) && !(await canAdministerOrg(req, id))) {
    return sendError(res, 403, 'Forbidden: service or organization-admin only');
  }
  const usage = await pooledSeatUsage(id);
  sendSuccess(res, 200, usage);
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
}, {
  [ORG_AI_KEY_TOO_LONG]: { status: 400, message: 'AI provider key exceeds the maximum allowed length' },
});
