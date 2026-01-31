import { Router } from 'express';
import {
  listAllUsers,
  getUserById,
  updateUserById,
  deleteUserById,
} from '../controllers';
import { isAuthenticated, adminRateLimiters } from '../middleware';

const router = Router();

// System admin user management endpoints
// All these endpoints require system admin access (checked in controller)
router.get('/', isAuthenticated, adminRateLimiters.userManagement, listAllUsers);
router.get('/:id', isAuthenticated, adminRateLimiters.userManagement, getUserById);
router.put('/:id', isAuthenticated, adminRateLimiters.userManagement, updateUserById);
router.delete('/:id', isAuthenticated, adminRateLimiters.userManagement, deleteUserById);

export default router;
