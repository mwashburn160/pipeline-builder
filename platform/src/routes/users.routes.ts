import { Router } from 'express';
import {
  listAllUsers,
  getUserById,
  updateUserById,
  deleteUserById,
} from '../controllers';
import { isAuthenticated } from '../middleware';

const router = Router();

// System admin user management endpoints
// All these endpoints require system admin access (checked in controller)
router.get('/', isAuthenticated, listAllUsers);
router.get('/:id', isAuthenticated, getUserById);
router.put('/:id', isAuthenticated, updateUserById);
router.delete('/:id', isAuthenticated, deleteUserById);

export default router;
