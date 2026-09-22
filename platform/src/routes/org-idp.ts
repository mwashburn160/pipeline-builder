// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  sysadmin routes for per-org IdP configuration (scaffolding).
 *
 * Mounted under `/admin/org-idp` so the route prefix mirrors the
 * existing admin surfaces. The runtime auth dispatcher that consumes
 * these configs lands in a follow-up gated on the customer's IdP choice.
 */

import { audited, requireAssurance, requirePermission, requireStepUp, STRONG_STEP_UP_METHODS } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  deleteOrgIdpConfig,
  getOrgIdpConfig,
  listOrgIdpConfigs,
  patchOrgIdpConfig,
  putOrgIdpConfig,
} from '../controllers/org-idp.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router();

// `requirePermission('org:idp')` is the capability gate for the sensitive SSO/
// IdP surface (split out of `org:settings`); the controllers additionally
// enforce `requireSystemAdmin`, so this fleet stays superadmin-only in practice
// while the capability check documents + future-proofs the IdP authority.
// Superadmins bypass `requirePermission` via `hasPermission`.
router.get('/', requireAuth, requirePermission('org:idp'), listOrgIdpConfigs);
router.get('/:orgId', requireAuth, requirePermission('org:idp'), getOrgIdpConfig);
// Mutations persist the org's IdP `clientSecret` — gate on step-up so a stolen
// session can't write SSO credentials (mirrors org-kms-config), and on assurance
// so the session is MFA-grade. Repointing an org's IdP is a way to become
// any of its users, so the step-up must be earned by a SECOND FACTOR.
router.put('/:orgId', requireAuth, requirePermission('org:idp'), requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.org-idp.upsert'), putOrgIdpConfig);
router.patch('/:orgId', requireAuth, requirePermission('org:idp'), requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.org-idp.upsert'), patchOrgIdpConfig);
router.delete('/:orgId', requireAuth, requirePermission('org:idp'), requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.org-idp.delete'), deleteOrgIdpConfig);

export default router;
