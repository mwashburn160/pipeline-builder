import { Router } from 'express';
import { changePassword, deleteUser, generateToken, getUser, updateUser } from '../controllers/user.controller';
import { isAuthenticated } from '../middlewares/auth.middleware';

const userRouter = Router();

userRouter.get('/profile', isAuthenticated, getUser);
userRouter.patch('/profile', isAuthenticated, updateUser);
userRouter.delete('/account', isAuthenticated, deleteUser);
userRouter.post('/change-password', isAuthenticated, changePassword);

userRouter.post('/generate-token', isAuthenticated, generateToken);

export default userRouter;