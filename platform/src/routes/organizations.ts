/**
 * @module routes/organizations
 * @description System admin route for listing all organizations.
 */

import { Router } from 'express';
import { listAllOrganizations } from '../controllers';
import { authenticateToken, requireRole } from '../middleware';

const router = Router();

/** GET /organizations - List all organizations (system admin only) */
router.get('/', authenticateToken, requireRole('admin'), listAllOrganizations);

export default router;
