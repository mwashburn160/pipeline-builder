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

router.get('/profile', isAuthenticated, getUser);
router.patch('/profile', isAuthenticated, updateUser);
router.delete('/account', isAuthenticated, deleteUser);
router.post('/change-password', isAuthenticated, changePassword);
router.post('/generate-token', isAuthenticated, generateToken);

export default router;
