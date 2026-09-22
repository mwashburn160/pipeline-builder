// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sysadmin routes for per-org KMS configuration.
 *
 * Mounted under `/admin/orgs/:orgId/kms-config`. The PerOrgKmsKeyProvider
 * reads these documents at first-touch to wrap each org's secrets under
 * its own CMK; this surface is how an operator points an org at a CMK
 * without shelling into Mongo.
 */

import { audited, requireAssurance, requirePermission, requireStepUp, STRONG_STEP_UP_METHODS } from '@pipeline-builder/api-core';
import { Router } from 'express';
import {
  deleteOrgKmsConfig,
  getOrgKmsConfig,
  putOrgKmsConfig,
  testOrgKmsConfig,
} from '../controllers/org-kms-config.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router({ mergeParams: true });

// `requirePermission('org:kms')` is the capability gate for the sensitive
// customer-managed-KMS surface (split out of `org:settings`); the controllers
// additionally enforce `requireSystemAdmin`, so this fleet stays superadmin-only
// in practice while the capability check documents + future-proofs the KMS
// authority. Superadmins bypass `requirePermission` via `hasPermission`.
router.get('/', requireAuth, requirePermission('org:kms'), getOrgKmsConfig);
// Mutations re-encrypt every per-org secret under a new CMK — gate on step-up so
// a stolen session can't rotate the wrapping key, and on assurance so the
// session itself is MFA-grade. Pointing an org at an attacker-controlled CMK is
// as close to "read every secret this org has" as a single write gets, so the
// step-up must be earned by a SECOND FACTOR (passkey or authenticator code), not
// by re-typing the password the session already holds.
router.put('/', requireAuth, requirePermission('org:kms'), requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.org.kms-config.upsert'), putOrgKmsConfig);
router.delete('/', requireAuth, requirePermission('org:kms'), requireAssurance({ minAssurance: 2 }), requireStepUp({ methods: STRONG_STEP_UP_METHODS }), audited('admin.org.kms-config.delete'), deleteOrgKmsConfig);
// POST /test — dry-run the proposed config without touching Mongo.
// Read-only; no step-up needed (and we want operators to be able to
// validate a CMK without having to re-prompt every time).
router.post('/test', requireAuth, requirePermission('org:kms'), testOrgKmsConfig);

export default router;
