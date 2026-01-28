import { Router } from 'express';
import { login, logout, register, refresh } from '../controllers';
import { isAuthenticated, isValidRefreshToken } from '../middleware';

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', isValidRefreshToken, refresh);
router.post('/logout', isAuthenticated, logout);

export default router;
