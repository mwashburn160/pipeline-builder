import { Router } from 'express';
import { login, logout, register, refresh } from '../controllers';
import { isAuthenticated, isValidRefreshToken, authRateLimiters } from '../middleware';

const router = Router();

router.post('/register', authRateLimiters.register, register);
router.post('/login', authRateLimiters.login, login);
router.post('/refresh', authRateLimiters.refresh, isValidRefreshToken, refresh);
router.post('/logout', isAuthenticated, logout);

export default router;
