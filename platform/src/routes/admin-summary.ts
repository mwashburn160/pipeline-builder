// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin route for the admin-home dashboard summary.
 * Mounted at `/admin/summary`.
 */

import { Router } from 'express';
import { getAdminSummary } from '../controllers/admin-summary.js';
import { requireAuth, requireSystemAdmin } from '../middleware/index.js';

const router: Router = Router();

// `requireSystemAdmin` mirrors the controller's own first-line gate at the
// route layer, so the fleet-wide counts are gated where the route table can see it.
router.get('/', requireAuth, requireSystemAdmin, getAdminSummary);

export default router;
