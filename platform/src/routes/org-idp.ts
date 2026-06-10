// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  sysadmin routes for per-org IdP configuration (scaffolding).
 *
 * Mounted under `/admin/org-idp` so the route prefix mirrors the
 * existing admin surfaces. The runtime auth dispatcher that consumes
 * these configs lands in a follow-up gated on the customer's IdP choice.
 */

import { Router } from 'express';
import {
  deleteOrgIdpConfig,
  getOrgIdpConfig,
  listOrgIdpConfigs,
  patchOrgIdpConfig,
  putOrgIdpConfig,
} from '../controllers/org-idp.js';
import { requireAuth } from '../middleware/index.js';

const router = Router();

router.get('/', requireAuth, listOrgIdpConfigs);
router.get('/:orgId', requireAuth, getOrgIdpConfig);
router.put('/:orgId', requireAuth, putOrgIdpConfig);
router.patch('/:orgId', requireAuth, patchOrgIdpConfig);
router.delete('/:orgId', requireAuth, deleteOrgIdpConfig);

export default router;
