// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getEcosystemApprovers, getPublisherEligibility } from '../controllers/ecosystem-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

const router: Router = Router();

/**
 * `/internal/ecosystem/*` — platform reads for the plugin ecosystem's
 * governance (docs/plans/plugin-ecosystem.md §3.0.1, §3.7). INTERNAL routes
 * (#14): only the `plugin` service's signed token reaches them; the mesh policy
 * on the Istio targets names the same caller, and compose relies on this gate.
 */
const pluginOnly = [requireServiceAuth, requireInternalService({ callers: ['plugin'] })];

/** The Verified application's platform-held checks (verified domains, owner MFA). */
router.get('/publisher-eligibility/:orgId', ...pluginOnly, getPublisherEligibility);

/** How many Ecosystem Managers could decide a request (minus conflicts of interest). */
router.get('/approvers', ...pluginOnly, getEcosystemApprovers);

export default router;
