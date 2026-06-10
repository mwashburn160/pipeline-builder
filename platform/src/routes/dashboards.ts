// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import {
  listDashboards,
  getDashboard,
  createDashboard,
  updateDashboard,
  deleteDashboard,
  cloneDashboard,
} from '../controllers/dashboards.js';
import { requireAuth } from '../middleware/index.js';

const router = Router();

router.get('/', requireAuth, listDashboards);
router.get('/:id', requireAuth, getDashboard);
router.post('/', requireAuth, createDashboard);
router.put('/:id', requireAuth, updateDashboard);
router.delete('/:id', requireAuth, deleteDashboard);
router.post('/:id/clone', requireAuth, cloneDashboard);

export default router;
