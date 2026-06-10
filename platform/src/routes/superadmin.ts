// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * User-grant routes (sysadmin-gated).
 *
 * Mounted at `/admin/users/:id/grants`. Generic path so the privilege
 * surface isn't telegraphed in access logs; the grant name lives in the
 * JSON body. Today the only grant is `platform-admin`; future grants
 * (audit-read, data-export, etc.) slot in without new routes.
 */

import { Router } from 'express';
import { addUserGrant, removeUserGrant } from '../controllers/superadmin.js';
import { requireAuth, requireStepUp } from '../middleware/index.js';

const router = Router({ mergeParams: true });

router.post('/', requireAuth, requireStepUp, addUserGrant);
router.delete('/', requireAuth, requireStepUp, removeUserGrant);

export default router;
