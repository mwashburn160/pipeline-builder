// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { audited, requirePermission, requireStepUp } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  listDashboards,
  getDashboard,
  createDashboard,
  updateDashboard,
  deleteDashboard,
  restoreDashboard,
  cloneDashboard,
} from '../controllers/dashboards.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router();

// Reads carry the static `dashboards:read` capability (built-in Member bundle,
// so no role loses access); the handlers' `canRead` / renderable-panel filter is
// the per-row visibility check layered on top of it.
router.get('/', requireAuth, requirePermission('dashboards:read'), listDashboards);
router.get('/:id', requireAuth, requirePermission('dashboards:read'), getDashboard);
// Create/clone need a STATIC `dashboards:write` capability — gate at the route
// so it's auditable from the route table (the handler no longer re-checks).
router.post('/', requireAuth, requirePermission('dashboards:write'), audited('dashboard.create'), createDashboard);
// Update/delete stay handler-gated: `dashboardService.canWrite` is DYNAMIC —
// it also lets the dashboard's own creator (not just an org-admin) write it,
// so it must resolve the target row first and can't move to a route middleware.
router.put('/:id', requireAuth, audited('dashboard.update'), updateDashboard);
router.delete('/:id', requireAuth, audited('dashboard.delete'), deleteDashboard);
// Deliberate asymmetry: delete is NOT step-up-gated (soft-delete is recoverable
// — the row stays restorable), but restore IS — it's the administrative override
// that brings a row back into service, mirroring the org delete/restore pattern.
// Restore stays handler-gated too (dynamic canWrite, like delete).
router.post('/:id/restore', requireAuth, requireStepUp, audited('dashboard.restore'), restoreDashboard);
router.post('/:id/clone', requireAuth, requirePermission('dashboards:write'), audited('dashboard.clone'), cloneDashboard);

export default router;
