import { Router } from 'express';
import { getMyOrganization, addMember, transferOwnership } from '../controllers';
import { isAuthenticated, authorize } from '../middleware';

const router = Router();

router.get('/', isAuthenticated, getMyOrganization);
router.post('/members', isAuthenticated, authorize('admin'), addMember);
router.patch('/transfer-owner', isAuthenticated, authorize('admin'), transferOwnership);

export default router;
