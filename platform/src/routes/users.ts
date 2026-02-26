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
} from '../controllers';
import { authenticateToken, requireRole } from '../middleware';

const router = Router();

/** GET /users - List all users (system admin only) */
router.get('/', authenticateToken, requireRole('admin'), listAllUsers);

/** GET /users/:id - Get user by ID (system admin only) */
router.get('/:id', authenticateToken, requireRole('admin'), getUserById);

/** PUT /users/:id - Update user by ID (system admin only) */
router.put('/:id', authenticateToken, requireRole('admin'), updateUserById);

/** DELETE /users/:id - Delete user by ID (system admin only) */
router.delete('/:id', authenticateToken, requireRole('admin'), deleteUserById);

export default router;
