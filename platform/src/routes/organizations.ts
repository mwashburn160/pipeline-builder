// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { listAllOrganizations } from '../controllers/index.js';
import { requireAuth } from '../middleware/index.js';
import { requireSystemOrgPermission } from '@pipeline-builder/api-core';

const router: Router = Router();

/** GET /organizations — list every organization. Cross-tenant enumeration, so
 *  `platform:read` is the guard: an operator view a deployment can staff with a
 *  Role, while the permission being system-org-only means an org admin still
 *  cannot hold it. */
router.get('/', requireAuth, ...requireSystemOrgPermission('platform:read'), listAllOrganizations);

export default router;
