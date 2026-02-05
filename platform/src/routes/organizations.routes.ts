/**
 * @module routes/organizations
 * @description System admin route for listing all organizations.
 */

import { Router } from 'express';
import { listAllOrganizations } from '../controllers';
import { isAuthenticated } from '../middleware';

const router = Router();

/** GET /organizations - List all organizations (system admin only) */
router.get('/', isAuthenticated, listAllOrganizations);

export default router;
