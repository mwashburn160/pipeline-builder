import { Router } from 'express';
import { login, logout, register, refresh, switchOrg, sendVerificationEmail, verifyEmail } from '../controllers';
import { requireAuth, isValidRefreshToken } from '../middleware';

const router = Router();

/** POST /auth/register - Create a new user account */
router.post('/register', register);

/** POST /auth/login - Authenticate and receive tokens */
router.post('/login', login);

/** POST /auth/refresh - Exchange refresh token for new access token */
router.post('/refresh', isValidRefreshToken, refresh);

/** POST /auth/logout - Invalidate current session */
router.post('/logout', requireAuth, logout);

/** POST /auth/switch-org - Switch active organization and re-issue tokens */
router.post('/switch-org', requireAuth, switchOrg);

/** POST /auth/send-verification - Send email verification link */
router.post('/send-verification', requireAuth, sendVerificationEmail);

/** POST /auth/verify-email - Verify email with token (public, no auth needed) */
router.post('/verify-email', verifyEmail);

export default router;
