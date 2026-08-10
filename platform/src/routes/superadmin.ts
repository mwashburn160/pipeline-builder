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
import { requireAuth, requireSystemAdmin, requireStepUp } from '../middleware/index.js';

const router: Router = Router({ mergeParams: true });

// `requireSystemAdmin` mirrors the controllers' own first-line gate at the route
// layer (defense-in-depth) — granting/revoking platform-admin is sysadmin-only.
router.post('/', requireAuth, requireSystemAdmin, requireStepUp, addUserGrant);
router.delete('/', requireAuth, requireSystemAdmin, requireStepUp, removeUserGrant);

export default router;
