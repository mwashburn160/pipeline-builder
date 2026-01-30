import { Router } from 'express';
import {
  getMyOrganization,
  getOrganizationById,
  updateOrganization,
  getOrganizationQuotas,
  updateOrganizationQuotas,
  addMember,
  transferOwnership,
} from '../controllers';
import { isAuthenticated, authorize } from '../middleware';

const router = Router();

router.get('/', isAuthenticated, getMyOrganization);
router.get('/:id', isAuthenticated, getOrganizationById);
router.put('/:id', isAuthenticated, updateOrganization);
router.get('/:id/quotas', isAuthenticated, getOrganizationQuotas);
router.put('/:id/quotas', isAuthenticated, updateOrganizationQuotas);
router.post('/members', isAuthenticated, authorize('admin'), addMember);
router.patch('/transfer-owner', isAuthenticated, authorize('admin'), transferOwnership);

export default router;
