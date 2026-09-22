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

import { audited, requireAssurance, requireStepUp, STRONG_STEP_UP_METHODS } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { addUserGrant, removeUserGrant } from '../controllers/superadmin.js';
import { requireAuth, requireSystemAdmin } from '../middleware/index.js';

const router: Router = Router({ mergeParams: true });

// `requireSystemAdmin` mirrors the controllers' own first-line gate at the route
// layer (defense-in-depth) — granting/revoking platform-admin is sysadmin-only.
//
// ASSURANCE: granting platform-admin is the single most valuable write on
// the platform — it manufactures another operator. It is therefore in the first
// wave of `minAssurance: 2` routes, and its step-up must be earned by a SECOND
// FACTOR rather than by re-typing a password the session already proved.
router.post('/', requireAuth, requireSystemAdmin, requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.superadmin.grant'), addUserGrant);
router.delete('/', requireAuth, requireSystemAdmin, requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.superadmin.revoke'), removeUserGrant);

export default router;
