// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin route for the admin-home dashboard summary.
 * Mounted at `/admin/summary`.
 */

import { Router } from 'express';
import { getAdminSummary } from '../controllers/admin-summary';
import { requireAuth } from '../middleware';

const router = Router();

router.get('/', requireAuth, getAdminSummary);

export default router;
