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
router.get('/', requireAuth, requireRole('admin', 'owner'), listAllUsers);

/** GET /users/:id - Get user by ID (system admin only) */
router.get('/:id', requireAuth, requireRole('admin', 'owner'), getUserById);

/** PUT /users/:id - Update user by ID (system admin only) */
router.put('/:id', requireAuth, requireRole('admin', 'owner'), updateUserById);

/** PUT /users/:id/features - Update user feature overrides (admin only) */
router.put('/:id/features', requireAuth, requireRole('admin', 'owner'), updateUserFeatures);

/** DELETE /users/:id - Delete user by ID (system admin only) */
router.delete('/:id', requireAuth, requireRole('admin', 'owner'), deleteUserById);

export default router;
