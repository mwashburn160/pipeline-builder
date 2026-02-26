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
import { authenticateToken } from '../middleware';

const router = Router();

/** GET /user/profile - Get current user's profile */
router.get('/profile', authenticateToken, getUser);

/** PATCH /user/profile - Update current user's profile */
router.patch('/profile', authenticateToken, updateUser);

/** DELETE /user/account - Delete current user's account */
router.delete('/account', authenticateToken, deleteUser);

/** POST /user/change-password - Change current user's password */
router.post('/change-password', authenticateToken, changePassword);

/** POST /user/generate-token - Generate API token for current user */
router.post('/generate-token', authenticateToken, generateToken);

export default router;
