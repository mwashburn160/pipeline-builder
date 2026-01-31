import { Router } from 'express';
import {
  changePassword,
  deleteUser,
  generateToken,
  getUser,
  updateUser,
} from '../controllers';
import {
  isAuthenticated,
  apiRateLimiters,
  authRateLimiters,
  sensitiveRateLimiters,
} from '../middleware';

const router = Router();

// Current user endpoints
router.get('/profile', isAuthenticated, apiRateLimiters.read, getUser);
router.patch('/profile', isAuthenticated, apiRateLimiters.write, updateUser);
router.delete('/account', isAuthenticated, sensitiveRateLimiters.accountDeletion, deleteUser);
router.post('/change-password', isAuthenticated, authRateLimiters.passwordChange, changePassword);
router.post('/generate-token', isAuthenticated, sensitiveRateLimiters.tokenGeneration, generateToken);

export default router;
