// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import { impersonateUser } from '../controllers/impersonate.js';
import { requireAuth, requireSystemAdmin, requireStepUp } from '../middleware/index.js';

const router: Router = Router({ mergeParams: true });

/**
 * POST /admin/impersonate/:userId — sysadmin starts a read-only
 * impersonation session of the target user. Step-up gated; sysadmin
 * gate is enforced inside the controller.
 */
// `requireSystemAdmin` mirrors the controller's own first-line gate (defense-in-depth).
router.post('/:userId', requireAuth, requireSystemAdmin, requireStepUp, impersonateUser);

export default router;
