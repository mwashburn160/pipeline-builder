import { Router } from 'express';
import {
  getMyOrganization,
  addMember,
  transferOwnership,
} from '../controllers/organization.controller';
import { isAuthenticated, authorize } from '../middlewares/auth.middleware';

const orgRouter = Router();

orgRouter.get('/', isAuthenticated, getMyOrganization);
orgRouter.post('/members', isAuthenticated, authorize('admin'), addMember);
orgRouter.patch('/transfer-owner', isAuthenticated, authorize('admin'), transferOwnership);

export default orgRouter;