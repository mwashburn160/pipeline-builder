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

import { sendError, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit';
import { isOrgAdmin, isSystemAdmin, withController } from '../helpers/controller-helper';
import { QUERIES } from '../observability/catalog';
import { dashboardService, type PanelInput } from '../services/dashboard-service';

/** Bound the size of free-text fields and the panel set to defend against
 *  pathological client payloads. Numbers picked to be generous for a
 *  realistic dashboard while still bounded enough to keep the JSONB column
 *  + payload size sane. */
const MAX_NAME = 150;
const MAX_DESCRIPTION = 1000;
const MAX_TITLE = 200;
const MAX_PANELS = 50;

function isReasonableString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/** Validate + normalize a panel array from a JSON body. Returns null + sends
 *  a 400 response if anything is malformed; the catalog query-key check is
 *  the security-critical bit (rejects keys that don't exist in QUERIES). */
function validatePanels(body: unknown, sendErr: (msg: string) => void): PanelInput[] | null {
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
      vars: (p.vars && typeof p.vars === 'object') ? (p.vars as Record<string, string>) : {},
    });
  }
  return cleaned;
}

/** GET /api/dashboards — list dashboards visible to the caller. */
export const listDashboards = withController('List dashboards', async (req, res) => {
  const userId = req.user?.sub;
  const orgId = req.user?.organizationId;
  if (!userId || !orgId) return sendError(res, 401, 'Unauthorized');

  const rows = await dashboardService.list({
    orgId,
    userId,
    isSysAdmin: isSystemAdmin(req),
  });
  sendSuccess(res, 200, { dashboards: rows });
});

/** GET /api/dashboards/:id — fetch one (visibility-gated). */
export const getDashboard = withController('Get dashboard', async (req, res) => {
  const userId = req.user?.sub;
  const orgId = req.user?.organizationId;
  if (!userId || !orgId) return sendError(res, 401, 'Unauthorized');

  const dashboard = await dashboardService.findById((req.params.id as string));
  if (!dashboard) return sendError(res, 404, 'Dashboard not found');

  const ok = dashboardService.canRead(dashboard, { orgId, userId, isSysAdmin: isSystemAdmin(req) });
  if (!ok) return sendError(res, 404, 'Dashboard not found'); // 404 not 403 to avoid leaking existence

  sendSuccess(res, 200, { dashboard });
});

/** POST /api/dashboards — create. */
export const createDashboard = withController('Create dashboard', async (req, res) => {
  const userId = req.user?.sub;
  const orgId = req.user?.organizationId;
  if (!userId || !orgId) return sendError(res, 401, 'Unauthorized');

  // Org-admin or sysadmin can create. Anyone else gets 403 — keeps random
  // members from churning out org/public dashboards.
  if (!isSystemAdmin(req) && !isOrgAdmin(req)) {
    return sendError(res, 403, 'Org admin or system admin required to create dashboards');
  }

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
  const panels = validatePanels(req.body, (msg) => { sendError(res, 400, msg); bad = true; });
  if (bad || panels === null) return;

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
});

/** PUT /api/dashboards/:id — partial update (with optional full-set panel replace). */
export const updateDashboard = withController('Update dashboard', async (req, res) => {
  const userId = req.user?.sub;
  const orgId = req.user?.organizationId;
  if (!userId || !orgId) return sendError(res, 401, 'Unauthorized');

  const existing = await dashboardService.findById((req.params.id as string));
  if (!existing) return sendError(res, 404, 'Dashboard not found');

  const canWrite = dashboardService.canWrite(existing, {
    orgId, userId,
    isSysAdmin: isSystemAdmin(req),
    isOrgAdmin: isOrgAdmin(req),
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
    panels = validatePanels(req.body, (msg) => { sendError(res, 400, msg); bad = true; });
    if (bad || panels === null) return;
  }

  const updated = await dashboardService.update(
    (req.params.id as string),
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

  audit(req, 'dashboard.update', { targetType: 'dashboard', targetId: updated.id });
  sendSuccess(res, 200, { dashboard: updated });
});

/** DELETE /api/dashboards/:id — soft delete. */
export const deleteDashboard = withController('Delete dashboard', async (req, res) => {
  const userId = req.user?.sub;
  const orgId = req.user?.organizationId;
  if (!userId || !orgId) return sendError(res, 401, 'Unauthorized');

  const existing = await dashboardService.findById((req.params.id as string));
  if (!existing) return sendError(res, 404, 'Dashboard not found');

  const canWrite = dashboardService.canWrite(existing, {
    orgId, userId,
    isSysAdmin: isSystemAdmin(req),
    isOrgAdmin: isOrgAdmin(req),
  });
  if (!canWrite) return sendError(res, 403, 'You cannot delete this dashboard');

  const ok = await dashboardService.delete((req.params.id as string), { userId });
  if (!ok) return sendError(res, 404, 'Dashboard not found');

  audit(req, 'dashboard.delete', { targetType: 'dashboard', targetId: (req.params.id as string), details: { name: existing.name } });
  sendSuccess(res, 200, undefined, 'Dashboard deleted');
});

/** POST /api/dashboards/:id/clone — fork into the caller's org as private. */
export const cloneDashboard = withController('Clone dashboard', async (req, res) => {
  const userId = req.user?.sub;
  const orgId = req.user?.organizationId;
  if (!userId || !orgId) return sendError(res, 401, 'Unauthorized');

  // Same gate as create — needs at least org-admin to land a new dashboard
  // in the org's namespace.
  if (!isSystemAdmin(req) && !isOrgAdmin(req)) {
    return sendError(res, 403, 'Org admin or system admin required to clone');
  }

  // Cloning a dashboard you can't see is the same as cloning a non-existent
  // one. Source must be visible to the caller.
  const source = await dashboardService.findById((req.params.id as string));
  if (!source) return sendError(res, 404, 'Dashboard not found');
  if (!dashboardService.canRead(source, { orgId, userId, isSysAdmin: isSystemAdmin(req) })) {
    return sendError(res, 404, 'Dashboard not found');
  }

  const cloned = await dashboardService.clone((req.params.id as string), { orgId, userId });
  if (!cloned) return sendError(res, 404, 'Dashboard not found');

  audit(req, 'dashboard.clone', { targetType: 'dashboard', targetId: cloned.id, details: { sourceId: (req.params.id as string), name: cloned.name } });
  sendSuccess(res, 201, { dashboard: cloned });
});
