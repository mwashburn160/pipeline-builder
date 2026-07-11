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
import { requireAuth, requireStepUp } from '../middleware/index.js';

const router = Router();

router.get('/', requireAuth, listOrgIdpConfigs);
router.get('/:orgId', requireAuth, getOrgIdpConfig);
// Mutations persist the org's IdP `clientSecret` — gate on step-up so a
// stolen session can't write SSO credentials (mirrors org-kms-config).
router.put('/:orgId', requireAuth, requireStepUp, putOrgIdpConfig);
router.patch('/:orgId', requireAuth, requireStepUp, patchOrgIdpConfig);
router.delete('/:orgId', requireAuth, requireStepUp, deleteOrgIdpConfig);

export default router;
