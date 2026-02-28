/**
 * @module routes/users
 * @description System admin user management routes.
 * All routes require authentication and system admin privileges (checked in controller).
 */

import { Router } from 'express';
import {
  listAllUsers,
  getUserById,
  updateUserById,
  deleteUserById,
  updateUserFeatures,
} from '../controllers';
import { requireAuth, requireRole } from '../middleware';

const router = Router();

/** GET /users - List all users (system admin only) */
router.get('/', requireAuth, requireRole('admin'), listAllUsers);

/** GET /users/:id - Get user by ID (system admin only) */
router.get('/:id', requireAuth, requireRole('admin'), getUserById);

/** PUT /users/:id - Update user by ID (system admin only) */
router.put('/:id', requireAuth, requireRole('admin'), updateUserById);

/** PUT /users/:id/features - Update user feature overrides (admin only) */
router.put('/:id/features', requireAuth, requireRole('admin'), updateUserFeatures);

/** DELETE /users/:id - Delete user by ID (system admin only) */
router.delete('/:id', requireAuth, requireRole('admin'), deleteUserById);

export default router;
