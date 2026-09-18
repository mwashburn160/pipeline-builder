// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { notifyEmail } from '../controllers/notify-email.js';
import { requireServiceAuth } from '../middleware/index.js';

const router: Router = Router();

/**
 * POST /internal/notify-email — internal service-to-service email send.
 *
 * `compliance` is the only caller (its notification channels relay through
 * platform, which holds the SMTP credentials). An INTERNAL route (#14): no user
 * token reaches it, and the caller's name is bound to its signing key, so this
 * cannot be driven by any other workload. The mesh policy on the Istio targets
 * names the same caller; compose has no mesh, so this gate is the enforcement.
 */
router.post('/', requireServiceAuth, requireInternalService({ callers: ['compliance'] }), notifyEmail);

export default router;
