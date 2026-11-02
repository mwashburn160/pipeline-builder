// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin route for the admin-home dashboard summary.
 * Mounted at `/admin/summary`.
 */

import { Router } from 'express';
import { getAdminSummary } from '../controllers/admin-summary.js';
import { requireAuth } from '../middleware/index.js';
import { requireSystemOrgPermission } from '@pipeline-builder/api-core';

const router: Router = Router();

// `platform:read` rather than the superadmin flag: these are deploy-time
// settings and cross-tenant COUNTS, not any tenant's data, so a deployment can
// staff the view with a Role. The permission is system-org-only, so it can never
// be granted inside a tenant; superadmins hold it implicitly. The controller
// re-checks the SAME permission as its first line, so a direct controller call
// cannot bypass the gate.
router.get('/', requireAuth, ...requireSystemOrgPermission('platform:read'), getAdminSummary);

export default router;
