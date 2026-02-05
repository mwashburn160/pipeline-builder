/**
 * @module routes/user
 * @description Current user profile management routes.
 * All routes require authentication.
 */

import { Router } from 'express';
import {
  changePassword,
  deleteUser,
  generateToken,
  getUser,
  updateUser,
} from '../controllers';
import { isAuthenticated } from '../middleware';

const router = Router();

/** GET /user/profile - Get current user's profile */
router.get('/profile', isAuthenticated, getUser);

/** PATCH /user/profile - Update current user's profile */
router.patch('/profile', isAuthenticated, updateUser);

/** DELETE /user/account - Delete current user's account */
router.delete('/account', isAuthenticated, deleteUser);

/** POST /user/change-password - Change current user's password */
router.post('/change-password', isAuthenticated, changePassword);

/** POST /user/generate-token - Generate API token for current user */
router.post('/generate-token', isAuthenticated, generateToken);

export default router;
