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

import { Router } from 'express';
import {
  deleteOrgKmsConfig,
  getOrgKmsConfig,
  putOrgKmsConfig,
  testOrgKmsConfig,
} from '../controllers/org-kms-config.js';
import { requireAuth, requireStepUp } from '../middleware/index.js';

const router: Router = Router({ mergeParams: true });

router.get('/', requireAuth, getOrgKmsConfig);
// Mutations re-encrypt every per-org secret under a new CMK — gate on
// step-up so a stolen session can't rotate the wrapping key.
router.put('/', requireAuth, requireStepUp, putOrgKmsConfig);
router.delete('/', requireAuth, requireStepUp, deleteOrgKmsConfig);
// POST /test — dry-run the proposed config without touching Mongo.
// Read-only; no step-up needed (and we want operators to be able to
// validate a CMK without having to re-prompt every time).
router.post('/test', requireAuth, testOrgKmsConfig);

export default router;
