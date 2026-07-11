// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requirePermission } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  listAllUsers,
  getUserById,
  updateUserById,
  deleteUserById,
  bulkDeleteUsers,
  updateUserFeatures,
} from '../controllers/index.js';
import { requireAuth, requireStepUp } from '../middleware/index.js';

const router = Router();

/** GET /users - List all users (system admin only) */
router.get('/', requireAuth, requirePermission('members:manage'), listAllUsers);

/** GET /users/:id - Get user by ID (system admin only) */
router.get('/:id', requireAuth, requirePermission('members:manage'), getUserById);

/** PUT /users/:id - Update user by ID (system admin only) */
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
