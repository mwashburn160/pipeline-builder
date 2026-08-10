// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requirePermission } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  listAllUsers,
  getUserById,
  createUserByAdmin,
  updateUserById,
  deleteUserById,
  bulkDeleteUsers,
  updateUserFeatures,
} from '../controllers/index.js';
import { requireAuth, requireStepUp } from '../middleware/index.js';

const router: Router = Router();

// These routes are gated by `members:manage` and are DUAL-MODE: a sysadmin acts
// fleet-wide, while an org-admin is scoped to their own org (enforced in the
// controller). Create/bulk paths are further restricted to sysadmins there.

/** GET /users - List users (members:manage; sysadmin = all, org-admin = own org). */
router.get('/', requireAuth, requirePermission('members:manage'), listAllUsers);

/** POST /users - Create a user (members:manage; controller restricts to sysadmin). */
router.post('/', requireAuth, requirePermission('members:manage'), createUserByAdmin);

/** GET /users/:id - Get a user (members:manage; org-admin scoped to a shared org). */
router.get('/:id', requireAuth, requirePermission('members:manage'), getUserById);

/** PUT /users/:id - Update a user (members:manage; org-admin scoped to a shared org). */
router.put('/:id', requireAuth, requirePermission('members:manage'), updateUserById);

/** PUT /users/:id/features - Update user feature overrides (admin only) */
router.put('/:id/features', requireAuth, requirePermission('members:manage'), updateUserFeatures);

/** DELETE /users/:id - Delete user by ID (system admin only) */
router.delete('/:id', requireAuth, requirePermission('members:manage'), requireStepUp, deleteUserById);

/**
 * POST /users/bulk-delete - Bulk delete users (system admin only).
 * Posted instead of DELETE because Express bodies on DELETE are flaky
 * through some proxies. Server enforces sysadmin-only and a 100-id cap.
 */
router.post('/bulk-delete', requireAuth, requirePermission('members:manage'), requireStepUp, bulkDeleteUsers);

export default router;
