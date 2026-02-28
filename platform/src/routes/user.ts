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
import { requireAuth } from '../middleware';

const router = Router();

/** GET /user/profile - Get current user's profile */
router.get('/profile', requireAuth, getUser);

/** PATCH /user/profile - Update current user's profile */
router.patch('/profile', requireAuth, updateUser);

/** DELETE /user/account - Delete current user's account */
router.delete('/account', requireAuth, deleteUser);

/** POST /user/change-password - Change current user's password */
router.post('/change-password', requireAuth, changePassword);

/** POST /user/generate-token - Generate API token for current user */
router.post('/generate-token', requireAuth, generateToken);

export default router;
