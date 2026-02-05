/**
 * @module routes/auth
 * @description Authentication routes for user registration, login, logout, and token refresh.
 */

import { Router } from 'express';
import { login, logout, register, refresh } from '../controllers';
import { isAuthenticated, isValidRefreshToken } from '../middleware';

const router = Router();

/** POST /auth/register - Create a new user account */
router.post('/register', register);

/** POST /auth/login - Authenticate and receive tokens */
router.post('/login', login);

/** POST /auth/refresh - Exchange refresh token for new access token */
router.post('/refresh', isValidRefreshToken, refresh);

/** POST /auth/logout - Invalidate current session */
router.post('/logout', isAuthenticated, logout);

export default router;
