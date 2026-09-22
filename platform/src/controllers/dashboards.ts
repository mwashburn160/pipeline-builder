// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controllers for the dashboards CRUD surface.
 *
 *   GET    /api/dashboards         — list visible to caller (per-org + public)
 *   GET    /api/dashboards/deleted — restorable tombstones ("recently deleted")
 *   GET    /api/dashboards/:id     — fetch one
 *   POST   /api/dashboards         — create (org-admin or sysadmin)
 *   PUT    /api/dashboards/:id     — update (creator | org-admin | sysadmin)
 *   DELETE /api/dashboards/:id     — soft delete (creator | org-admin | sysadmin)
 *   POST   /api/dashboards/:id/restore — undo a soft delete (step-up gated)
 *   POST   /api/dashboards/:id/purge   — permanent hard-delete (step-up gated)
 *   POST   /api/dashboards/:id/clone — fork into the caller's org as `private`
 *
 * Catalog enforcement: panel `queryKey` values are validated against the
 * platform-side catalog (`platform/src/observability/catalog.ts`) at write
 * time. Bad keys → 400. Frontend never sends PromQL/LogQL, only the key
 * referencing a catalog entry; this keeps the catalog as the security
 * boundary even when dashboards are user-editable.
 */

import { createLogger, getParam, sendError, sendSuccess, userHasPermission, isSystemAdmin } from '@pipeline-builder/api-core';
import type { Response } from 'express';
import { audit } from '../helpers/audit.js';
import { getAdminContext, requireAuthContext, withController } from '../helpers/controller-helper.js';
import { releaseFeatureQuota, withFeatureQuota } from '../middleware/quota.js';
import { canQueryCatalogKey, type CatalogCaller, QUERIES } from '../observability/catalog.js';
import { dashboardService, type PanelInput } from '../services/dashboard-service.js';
import { createDashboardSchema, updateDashboardSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('dashboards-controller');


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

/**
 * The catalog check on validated panels — the security-critical bit: every
 * `queryKey` must exist in QUERIES and be one the caller could render. Sends a
 * 400 and returns null on the first refusal; otherwise the panels, positioned.
 */
function checkPanelKeys(panels: PanelInput[], caller: CatalogCaller, res: Response): PanelInput[] | null {
  for (let i = 0; i < panels.length; i++) {
    const key = panels[i].queryKey;
    if (!(key in QUERIES)) {
      sendError(res, 400, `panels[${i}].queryKey is not a known catalog entry`);
      return null;
    }
    if (!canQueryCatalogKey(key, caller)) {
      sendError(res, 400, `panels[${i}].queryKey is not available to you`);
      return null;
    }
  }
  return panels.map((p, i) => ({
    ...p,
    vizKind: p.vizKind ?? 'line',
    span: p.span ?? 6,
    position: p.position ?? i,
  }));
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

  const body = validateBody(createDashboardSchema, req.body, res);
  if (!body) return;
  const visibility = body.visibility ?? 'private';
  // Only sysadmins can create `public` dashboards (they ride the system-org
  // visibility rule for every org).
  if (visibility === 'public' && !isSystemAdmin(req)) {
    return sendError(res, 403, 'Only system admins can create public dashboards');
  }
  const panels = checkPanelKeys(body.panels ?? [], getAdminContext(req), res);
  if (!panels) return;

  // Per-org cap on dashboards; reserve atomically before insert.
  await withFeatureQuota(res, orgId, 'dashboards', async () => {
    const created = await dashboardService.create(
      {
        name: body.name,
        description: body.description ?? undefined,
        visibility,
        layoutJson: body.layoutJson ?? {},
        panels,
      },
      { orgId, userId },
    );

    audit(req, 'dashboard.create', { targetType: 'dashboard', targetId: created.id, details: { name: created.name, visibility } });
    sendSuccess(res, 201, { dashboard: created });
  });
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

  const body = validateBody(updateDashboardSchema, req.body, res);
  if (!body) return;
  if (body.visibility === 'public' && !isSystemAdmin(req)) {
    return sendError(res, 403, 'Only system admins can promote a dashboard to public');
  }
  let panels: PanelInput[] | undefined;
  if (body.panels !== undefined) {
    const checked = checkPanelKeys(body.panels, getAdminContext(req), res);
    if (!checked) return;
    panels = checked;
  }

  const updated = await dashboardService.update(
    getParam(req.params, 'id')!,
    {
      name: body.name,
      description: body.description,
      visibility: body.visibility,
      layoutJson: body.layoutJson,
      panels,
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
  releaseFeatureQuota(existing.orgId, 'dashboards', logger.warn.bind(logger), null);

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

/**
 * GET /api/dashboards/deleted — the caller's restorable tombstones.
 *
 * Same read capability as the live list (`dashboards:read` at the route) and the
 * same per-row visibility, narrowed further to rows the caller could actually
 * restore: the panel must not offer a Restore that the dynamic `canWrite` gate
 * on `POST /:id/restore` would then 403. No renderable-panel filter here —
 * panels are irrelevant to a tombstone you are deciding whether to bring back,
 * and hiding restorable rows behind a catalog check would strand them.
 */
export const listDeletedDashboards = withController('List deleted dashboards', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;
  const caller = getAdminContext(req);

  const rows = await dashboardService.listDeleted({ orgId, userId, isSuperAdmin: caller.isSuperAdmin });
  const writeCtx = {
    orgId,
    userId,
    isSuperAdmin: caller.isSuperAdmin,
    isOrgAdmin: userHasPermission(req, 'dashboards:write'),
  };
  const dashboards = rows.filter((d) => dashboardService.canWrite(d, writeCtx));
  sendSuccess(res, 200, { dashboards });
});

/**
 * POST /api/dashboards/:id/purge — PERMANENT hard-delete of a tombstone,
 * finalizing now what the retention sweep would do at `purge_after`.
 *
 * Same authority as restore: the dynamic `canWrite` gate against the tombstone's
 * own row, plus the route's step-up (re-verify before an irreversible
 * destruction). 404 when the id is unknown or still live — a live dashboard has
 * to be soft-deleted first and can never be destroyed in one call.
 */
export const purgeDashboard = withController('Purge dashboard', async (req, res) => {
  const ctx = requireAuthContext(req, res);
  if (!ctx) return;
  const { userId, orgId } = ctx;
  const id = getParam(req.params, 'id')!;

  const existing = await dashboardService.findDeletedById(id);
  if (!existing) return sendError(res, 404, 'Dashboard not found');

  const canWrite = dashboardService.canWrite(existing, {
    orgId,
    userId,
    isSuperAdmin: isSystemAdmin(req),
    isOrgAdmin: userHasPermission(req, 'dashboards:write'),
  });
  if (!canWrite) return sendError(res, 403, 'You cannot delete this dashboard');

  const ok = await dashboardService.purgeById(id);
  if (!ok) return sendError(res, 404, 'Dashboard not found');

  // The quota slot was already released by delete — purging a tombstone frees
  // nothing further, so there is deliberately no release here.
  audit(req, 'dashboard.purge', {
    targetType: 'dashboard',
    targetId: id,
    affectedOrgId: existing.orgId,
    details: { name: existing.name },
  });
  sendSuccess(res, 200, undefined, 'Dashboard permanently deleted');
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
  await withFeatureQuota(res, existing.orgId, 'dashboards', async () => {
    try {
      const ok = await dashboardService.restore(id, { userId });
      if (!ok) {
        sendError(res, 404, 'Dashboard not found');
        return false;
      }
    } catch (err) {
      // The (org_id, name) unique index is partial (WHERE deleted_at IS NULL), so a
      // live namesake can coexist with this tombstone; restoring then collides.
      // Surface as 409, not a raw 500.
      if ((err as { code?: string }).code === '23505') {
        sendError(res, 409, 'A dashboard with this name already exists — rename it and try again.');
        return false;
      }
      throw err;
    }
    audit(req, 'dashboard.restore', {
      targetType: 'dashboard',
      targetId: id,
      affectedOrgId: existing.orgId,
      details: { name: existing.name },
    });
    sendSuccess(res, 200, undefined, 'Dashboard restored');
    return true;
  });
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
  await withFeatureQuota(res, orgId, 'dashboards', async () => {
    const cloned = await dashboardService.clone(visibleSource, { orgId, userId });
    audit(req, 'dashboard.clone', { targetType: 'dashboard', targetId: cloned.id, details: { sourceId, name: cloned.name } });
    sendSuccess(res, 201, { dashboard: cloned });
  });
});
