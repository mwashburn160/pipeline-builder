// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { listAllOrganizations } from '../controllers';
import { requireAuth, requireRole } from '../middleware';

const router = Router();

/** GET /organizations - List all organizations (system admin only) */
router.get('/', requireAuth, requireRole('admin', 'owner'), listAllOrganizations);

export default router;
