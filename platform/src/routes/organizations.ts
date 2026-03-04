import { Router } from 'express';
import { listAllOrganizations } from '../controllers';
import { requireAuth, requireRole } from '../middleware';

const router = Router();

/** GET /organizations - List all organizations (system admin only) */
router.get('/', requireAuth, requireRole('admin'), listAllOrganizations);

export default router;
