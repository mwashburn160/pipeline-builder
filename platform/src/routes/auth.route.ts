import { Router } from 'express';
import {
  login,
  logout,
  register,
  refresh,
} from '../controllers/auth.controller';
import {
  isAuthenticated,
  isValidRefreshToken,
} from '../middlewares/auth.middleware';

const authRouter = Router();

authRouter.post('/register', register);
authRouter.post('/login', login);
authRouter.post('/refresh', isValidRefreshToken, refresh);
authRouter.post('/logout', isAuthenticated, logout);

export default authRouter;