// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { listAllOrganizations } from '../controllers/index.js';
import { requireAuth, requireSystemAdmin } from '../middleware/index.js';

const router: Router = Router();

/** GET /organizations - List all organizations (system admin only).
 *  Cross-tenant enumeration, so `requireSystemAdmin` (not `requireRole`) is the
 *  accurate route guard — an org admin must never list every tenant. Mirrors the
 *  controller's `requireSystemAdmin` check. */
router.get('/', requireAuth, requireSystemAdmin, listAllOrganizations);

export default router;
