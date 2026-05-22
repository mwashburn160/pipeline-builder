// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import {
  listAllUsers,
  getUserById,
  updateUserById,
  deleteUserById,
  bulkDeleteUsers,
  updateUserFeatures,
} from '../controllers';
import { requireAuth, requireRole, requireStepUp } from '../middleware';

const router = Router();

/** GET /users - List all users (system admin only) */
router.get('/', requireAuth, requireRole('admin', 'owner'), listAllUsers);

/** GET /users/:id - Get user by ID (system admin only) */
router.get('/:id', requireAuth, requireRole('admin', 'owner'), getUserById);

/** PUT /users/:id - Update user by ID (system admin only) */
router.put('/:id', requireAuth, requireRole('admin', 'owner'), updateUserById);

/** PUT /users/:id/features - Update user feature overrides (admin only) */
router.put('/:id/features', requireAuth, requireRole('admin', 'owner'), updateUserFeatures);

/** DELETE /users/:id - Delete user by ID (system admin only) */
router.delete('/:id', requireAuth, requireRole('admin', 'owner'), deleteUserById);

/**
 * POST /users/bulk-delete - Bulk delete users (system admin only).
 * Posted instead of DELETE because Express bodies on DELETE are flaky
 * through some proxies. Server enforces sysadmin-only and a 100-id cap.
 */
router.post('/bulk-delete', requireAuth, requireRole('admin', 'owner'), requireStepUp, bulkDeleteUsers);

export default router;
