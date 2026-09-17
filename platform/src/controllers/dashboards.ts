// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controllers for the dashboards CRUD surface.
 *
 *   GET    /api/dashboards         — list visible to caller (per-org + public)
 *   GET    /api/dashboards/:id     — fetch one
 *   POST   /api/dashboards         — create (org-admin or sysadmin)
 *   PUT    /api/dashboards/:id     — update (creator | org-admin | sysadmin)
 *   DELETE /api/dashboards/:id     — soft delete (creator | org-admin | sysadmin)
 *   POST   /api/dashboards/:id/clone — fork into the caller's org as `private`
 *
 * Catalog enforcement: panel `queryKey` values are validated against the
 * platform-side catalog (`platform/src/observability/catalog.ts`) at write
 * time. Bad keys → 400. Frontend never sends PromQL/LogQL, only the key
 * referencing a catalog entry; this keeps the catalog as the security
 * boundary even when dashboards are user-editable.
 */

import { createLogger, getParam, sendError, sendQuotaReserveDenied, sendSuccess, userHasPermission, isSystemAdmin } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { getAdminContext, requireAuthContext, withController } from '../helpers/controller-helper.js';
import { releaseFeatureQuota, reserveFeatureQuota } from '../middleware/quota.js';
import { canQueryCatalogKey, type CatalogCaller, QUERIES } from '../observability/catalog.js';
import { dashboardService, type PanelInput } from '../services/dashboard-service.js';
import { isReasonableString } from '../utils/string-guards.js';

const logger = createLogger('dashboards-controller');

/** Bound the size of free-text fields and the panel set to defend against
 *  pathological client payloads. Numbers picked to be generous for a
 *  realistic dashboard while still bounded enough to keep the JSONB column
 *  + payload size sane. */
const {
  dashboardMaxName: MAX_NAME,
  dashboardMaxDescription: MAX_DESCRIPTION,
  dashboardMaxPanelTitle: MAX_TITLE,
  dashboardMaxPanels: MAX_PANELS,
} = config.observability;


/**
 * Panels whose catalog key the caller can't run (a fleet-wide key for a
 * non-sysadmin, an admin-only key for a plain member — see
 * `canQueryCatalogKey`) are withheld from reads, and a dashboard left with
 * nothing to render is hidden outright. Without this an org member sees the
 * seeded public defaults (Queue Health, Registry Activity, …) and opens them to
 * a wall of 403 panels. A dashboard with no panels at all stays visible — it's
 * a fresh dashboard, not a restricted one.
 */
function hasRenderablePanel(queryKeys: string[], caller: CatalogCaller): boolean {
  return queryKeys.length === 0 || queryKeys.some(k => canQueryCatalogKey(k, caller));
}

/** Validate + normalize a panel array from a JSON body. Returns null + sends
 *  a 400 response if anything is malformed; the catalog query-key check is
 *  the security-critical bit (rejects keys that don't exist in QUERIES, and
 *  keys the caller couldn't render). */
function validatePanels(body: unknown, caller: CatalogCaller, sendErr: (msg: string) => void): PanelInput[] | null {
  const arr = (body as { panels?: unknown }).panels;
  if (arr === undefined) return [];
  if (!Array.isArray(arr)) {
    sendErr('panels must be an array');
    return null;
  }
  if (arr.length > MAX_PANELS) {
    sendErr(`panels[] exceeds the ${MAX_PANELS}-panel cap`);
    return null;
  }
  const cleaned: PanelInput[] = [];
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i] as Record<string, unknown>;
    if (!p || typeof p !== 'object') {
      sendErr(`panels[${i}] must be an object`);
      return null;
    }
    if (!isReasonableString(p.queryKey, 100) || !(p.queryKey in QUERIES)) {
      sendErr(`panels[${i}].queryKey is not a known catalog entry`);
      return null;
    }
    if (!canQueryCatalogKey(p.queryKey, caller)) {
      sendErr(`panels[${i}].queryKey is not available to you`);
      return null;
    }
    if (!isReasonableString(p.title, MAX_TITLE)) {
      sendErr(`panels[${i}].title must be a non-empty string <= ${MAX_TITLE} chars`);
      return null;
    }
    if (p.vizKind !== undefined && !isReasonableString(p.vizKind, 30)) {
      sendErr(`panels[${i}].vizKind must be a string <= 30 chars`);
      return null;
    }
    if (p.span !== undefined && (typeof p.span !== 'number' || p.span < 1 || p.span > 12)) {
      sendErr(`panels[${i}].span must be a number 1..12`);
      return null;
    }
    cleaned.push({
      queryKey: p.queryKey as string,
      vizKind: (p.vizKind as string) ?? 'line',
      title: p.title as string,
      span: (p.span as number) ?? 6,
      groupBy: typeof p.groupBy === 'string' ? p.groupBy : null,
      format: typeof p.format === 'string' ? p.format : null,
      position: typeof p.position === 'number' ? p.position : i,
    });
  }
  return cleaned;
}

/** GET /api/dashboards — list dashboards visible to the caller. */
export const listDashboards = withController('List dashboards', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;
  const caller = getAdminContext(req);

  const rows = await dashboardService.list({ orgId, userId, isSuperAdmin: caller.isSuperAdmin });
  if (caller.isSuperAdmin) return sendSuccess(res, 200, { dashboards: rows });

  const panelKeys = await dashboardService.listPanelKeys(rows.map(d => d.id));
  const dashboards = rows.filter(d => hasRenderablePanel(panelKeys.get(d.id) ?? [], caller));
  sendSuccess(res, 200, { dashboards });
});

/** GET /api/dashboards/:id — fetch one (visibility-gated, panels the caller
 *  can't render withheld). */
export const getDashboard = withController('Get dashboard', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;
  const caller = getAdminContext(req);

  const dashboard = await dashboardService.findById(getParam(req.params, 'id')!);
  if (!dashboard) return sendError(res, 404, 'Dashboard not found');

  const ok = dashboardService.canRead(dashboard, { orgId, userId, isSuperAdmin: caller.isSuperAdmin });
  // 404 not 403 to avoid leaking existence — same for a dashboard with nothing
  // the caller can render (it's hidden from their list too).
  if (!ok || !hasRenderablePanel(dashboard.panels.map(p => p.queryKey), caller)) {
    return sendError(res, 404, 'Dashboard not found');
  }

  const panels = dashboard.panels.filter(p => canQueryCatalogKey(p.queryKey, caller));
  sendSuccess(res, 200, { dashboard: { ...dashboard, panels } });
});

/** POST /api/dashboards — create. */
export const createDashboard = withController('Create dashboard', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  // The static `dashboards:write` capability gate now lives at the route
  // (`requirePermission('dashboards:write')`), so it's visible in the route
  // table. The `public`-visibility check below is a separate, finer gate.

  const body = req.body as { name?: unknown; description?: unknown; visibility?: unknown; layoutJson?: unknown };
  if (!isReasonableString(body.name, MAX_NAME)) {
    return sendError(res, 400, `name is required (max ${MAX_NAME} chars)`);
  }
  if (body.description !== undefined && body.description !== null && !isReasonableString(body.description, MAX_DESCRIPTION)) {
    return sendError(res, 400, `description must be a string <= ${MAX_DESCRIPTION} chars`);
  }

  let visibility: 'private' | 'org' | 'public' = 'private';
  if (body.visibility !== undefined) {
    if (body.visibility !== 'private' && body.visibility !== 'org' && body.visibility !== 'public') {
      return sendError(res, 400, 'visibility must be one of: private, org, public');
    }
    visibility = body.visibility;
    // Only sysadmins can create `public` dashboards (they ride the
    // system-org visibility rule for every org).
    if (visibility === 'public' && !isSystemAdmin(req)) {
      return sendError(res, 403, 'Only system admins can create public dashboards');
    }
  }

  let bad = false;
  const panels = validatePanels(req.body, getAdminContext(req), (msg) => { sendError(res, 400, msg); bad = true; });
  if (bad || panels === null) return;

  // Per-org cap on dashboards; reserve atomically before insert.
  const reservation = await reserveFeatureQuota(orgId, 'dashboards');
  if (reservation.exceeded) {
    return sendQuotaReserveDenied(res, 'dashboards', reservation);
  }

  try {
    const created = await dashboardService.create(
      {
        name: body.name,
        description: typeof body.description === 'string' ? body.description : undefined,
        visibility,
        layoutJson: (body.layoutJson && typeof body.layoutJson === 'object') ? (body.layoutJson as Record<string, { x: number; y: number; w: number; h: number }>) : {},
        panels,
      },
      { orgId, userId },
    );

    audit(req, 'dashboard.create', { targetType: 'dashboard', targetId: created.id, details: { name: created.name, visibility } });
    sendSuccess(res, 201, { dashboard: created });
  } catch (err) {
    releaseFeatureQuota(orgId, 'dashboards', logger.warn.bind(logger));
    throw err;
  }
});

/** PUT /api/dashboards/:id — partial update (with optional full-set panel replace). */
export const updateDashboard = withController('Update dashboard', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  const existing = await dashboardService.findById(getParam(req.params, 'id')!);
  if (!existing) return sendError(res, 404, 'Dashboard not found');

  // Handler-gated on purpose: canWrite is DYNAMIC (creator | org-admin |
  // sysadmin) and must resolve the target dashboard first, so it can't be a
  // route-level requirePermission.
  const canWrite = dashboardService.canWrite(existing, {
    orgId,
    userId,
    isSuperAdmin: isSystemAdmin(req),
    isOrgAdmin: userHasPermission(req, 'dashboards:write'),
  });
  if (!canWrite) return sendError(res, 403, 'You cannot modify this dashboard');

  const body = req.body as { name?: unknown; description?: unknown; visibility?: unknown; layoutJson?: unknown; panels?: unknown };

  if (body.name !== undefined && !isReasonableString(body.name, MAX_NAME)) {
    return sendError(res, 400, `name must be a non-empty string <= ${MAX_NAME} chars`);
  }
  if (body.description !== undefined && body.description !== null && !isReasonableString(body.description, MAX_DESCRIPTION)) {
    return sendError(res, 400, `description must be a string <= ${MAX_DESCRIPTION} chars`);
  }

  let visibility: 'private' | 'org' | 'public' | undefined;
  if (body.visibility !== undefined) {
    if (body.visibility !== 'private' && body.visibility !== 'org' && body.visibility !== 'public') {
      return sendError(res, 400, 'visibility must be one of: private, org, public');
    }
    visibility = body.visibility;
    if (visibility === 'public' && !isSystemAdmin(req)) {
      return sendError(res, 403, 'Only system admins can promote a dashboard to public');
    }
  }

  let panels: PanelInput[] | null = null;
  if (body.panels !== undefined) {
    let bad = false;
    panels = validatePanels(req.body, getAdminContext(req), (msg) => { sendError(res, 400, msg); bad = true; });
    if (bad || panels === null) return;
  }

  const updated = await dashboardService.update(
    getParam(req.params, 'id')!,
    {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: body.description === null ? null : (typeof body.description === 'string' ? body.description : undefined),
      visibility,
      layoutJson: (body.layoutJson && typeof body.layoutJson === 'object') ? (body.layoutJson as Record<string, { x: number; y: number; w: number; h: number }>) : undefined,
      panels: panels ?? undefined,
    },
    { userId },
  );
  if (!updated) return sendError(res, 404, 'Dashboard not found');

  // canWrite lets sysadmins edit any dashboard, so the affected org may
  // differ from the actor's org — record the dashboard's own orgId.
  audit(req, 'dashboard.update', { targetType: 'dashboard', targetId: updated.id, affectedOrgId: existing.orgId });
  sendSuccess(res, 200, { dashboard: updated });
});

/** DELETE /api/dashboards/:id — soft delete. */
export const deleteDashboard = withController('Delete dashboard', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  const existing = await dashboardService.findById(getParam(req.params, 'id')!);
  if (!existing) return sendError(res, 404, 'Dashboard not found');

  // Handler-gated on purpose: canWrite is DYNAMIC (creator | org-admin |
  // sysadmin) and must resolve the target dashboard first, so it can't be a
  // route-level requirePermission.
  const canWrite = dashboardService.canWrite(existing, {
    orgId,
    userId,
    isSuperAdmin: isSystemAdmin(req),
    isOrgAdmin: userHasPermission(req, 'dashboards:write'),
  });
  if (!canWrite) return sendError(res, 403, 'You cannot delete this dashboard');

  const ok = await dashboardService.delete(getParam(req.params, 'id')!, { userId });
  if (!ok) return sendError(res, 404, 'Dashboard not found');

  // Release the quota slot the create path reserved against the dashboard's
  // owning org. Sysadmins deleting another org's dashboard release against
  // that org's quota, not the sysadmin's.
  releaseFeatureQuota(existing.orgId, 'dashboards', logger.warn.bind(logger));

  // canWrite lets sysadmins delete any dashboard, so the affected org may
  // differ from the actor's org — record the dashboard's own orgId.
  audit(req, 'dashboard.delete', {
    targetType: 'dashboard',
    targetId: getParam(req.params, 'id')!,
    affectedOrgId: existing.orgId,
    details: { name: existing.name },
  });
  sendSuccess(res, 200, undefined, 'Dashboard deleted');
});

/** POST /api/dashboards/:id/restore — undo a soft-delete (step-up gated). */
export const restoreDashboard = withController('Restore dashboard', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;
  const id = getParam(req.params, 'id')!;

  // Load the TOMBSTONE and apply the same DYNAMIC canWrite gate as delete
  // (creator | org-admin | sysadmin) against the deleted dashboard's own row.
  const existing = await dashboardService.findDeletedById(id);
  if (!existing) return sendError(res, 404, 'Dashboard not found');

  const canWrite = dashboardService.canWrite(existing, {
    orgId,
    userId,
    isSuperAdmin: isSystemAdmin(req),
    isOrgAdmin: userHasPermission(req, 'dashboards:write'),
  });
  if (!canWrite) return sendError(res, 403, 'You cannot restore this dashboard');

  // Restore re-adds a LIVE row, so re-reserve the feature slot delete released —
  // else an org could delete→restore→create to drift past its `dashboards` cap.
  // Reserve against the dashboard's own org (matching delete/create).
  const reservation = await reserveFeatureQuota(existing.orgId, 'dashboards');
  if (reservation.exceeded) {
    return sendQuotaReserveDenied(res, 'dashboards', reservation);
  }

  try {
    const ok = await dashboardService.restore(id, { userId });
    if (!ok) {
      releaseFeatureQuota(existing.orgId, 'dashboards', logger.warn.bind(logger));
      return sendError(res, 404, 'Dashboard not found');
    }
    audit(req, 'dashboard.restore', {
      targetType: 'dashboard',
      targetId: id,
      affectedOrgId: existing.orgId,
      details: { name: existing.name },
    });
    sendSuccess(res, 200, undefined, 'Dashboard restored');
  } catch (err) {
    releaseFeatureQuota(existing.orgId, 'dashboards', logger.warn.bind(logger));
    // The (org_id, name) unique index is partial (WHERE deleted_at IS NULL), so a
    // live namesake can coexist with this tombstone; restoring then collides.
    // Surface as 409, not a raw 500.
    if ((err as { code?: string }).code === '23505') {
      return sendError(res, 409, 'A dashboard with this name already exists — rename it and try again.');
    }
    throw err;
  }
});

/** POST /api/dashboards/:id/clone — fork into the caller's org as private. */
export const cloneDashboard = withController('Clone dashboard', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;

  // Same static gate as create — `requirePermission('dashboards:write')` at the
  // route ensures at least org-admin before a new dashboard lands in the org's
  // namespace. Source visibility (canRead) is still checked below.

  const sourceId = getParam(req.params, 'id')!;
  const caller = getAdminContext(req);

  // Cloning a dashboard you can't see is the same as cloning a non-existent
  // one. Source must be visible to the caller, with at least one panel they
  // can render — and the copy only carries those panels.
  const source = await dashboardService.findById(sourceId);
  if (!source) return sendError(res, 404, 'Dashboard not found');
  if (
    !dashboardService.canRead(source, { orgId, userId, isSuperAdmin: caller.isSuperAdmin })
    || !hasRenderablePanel(source.panels.map(p => p.queryKey), caller)
  ) {
    return sendError(res, 404, 'Dashboard not found');
  }
  const visibleSource = { ...source, panels: source.panels.filter(p => canQueryCatalogKey(p.queryKey, caller)) };

  // Clone lands a NEW dashboard in the caller's org and counts against
  // that org's quota — mirror the create-path reserve/release pattern so
  // a flurry of clones can't bypass the cap.
  const reservation = await reserveFeatureQuota(orgId, 'dashboards');
  if (reservation.exceeded) {
    return sendQuotaReserveDenied(res, 'dashboards', reservation);
  }

  try {
    const cloned = await dashboardService.clone(visibleSource, { orgId, userId });
    audit(req, 'dashboard.clone', { targetType: 'dashboard', targetId: cloned.id, details: { sourceId, name: cloned.name } });
    sendSuccess(res, 201, { dashboard: cloned });
  } catch (err) {
    releaseFeatureQuota(orgId, 'dashboards', logger.warn.bind(logger));
    throw err;
  }
});
