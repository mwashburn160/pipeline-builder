// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requirePermission } from '@pipeline-builder/api-core';
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
import { requireAuth, requireStepUp } from '../middleware/index.js';

const router: Router = Router();

router.get('/', requireAuth, listDashboards);
router.get('/:id', requireAuth, getDashboard);
// Create/clone need a STATIC `dashboards:write` capability — gate at the route
// so it's auditable from the route table (the handler no longer re-checks).
router.post('/', requireAuth, requirePermission('dashboards:write'), createDashboard);
// Update/delete stay handler-gated: `dashboardService.canWrite` is DYNAMIC —
// it also lets the dashboard's own creator (not just an org-admin) write it,
// so it must resolve the target row first and can't move to a route middleware.
router.put('/:id', requireAuth, updateDashboard);
router.delete('/:id', requireAuth, deleteDashboard);
// Deliberate asymmetry: delete is NOT step-up-gated (soft-delete is recoverable
// — the row stays restorable), but restore IS — it's the administrative override
// that brings a row back into service, mirroring the org delete/restore pattern.
// Restore stays handler-gated too (dynamic canWrite, like delete).
router.post('/:id/restore', requireAuth, requireStepUp, restoreDashboard);
router.post('/:id/clone', requireAuth, requirePermission('dashboards:write'), cloneDashboard);

export default router;
