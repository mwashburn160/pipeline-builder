// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PLATFORM_INTERNAL, contractRoute, requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getEcosystemApprovers, getPublisherEligibility } from '../controllers/ecosystem-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

const router: Router = Router();

/**
 * `/internal/ecosystem/*` — platform reads for the plugin ecosystem's
 * governance (docs/runbooks/ecosystem-moderation.md). INTERNAL routes: only the `plugin` service's signed token reaches them; the mesh policy
 * on the Istio targets names the same caller, and compose relies on this gate.
 */
/** Where `mount.ts` mounts this router — the contracts' paths are under it. */
export const ECOSYSTEM_INTERNAL_MOUNT = '/internal/ecosystem';

const { publisherEligibility: ELIGIBILITY, ecosystemApprovers: APPROVERS } = PLATFORM_INTERNAL;

const pluginOnly = (callers: readonly string[]) => [requireServiceAuth, requireInternalService({ callers: [...callers] })];

/** The Verified application's platform-held checks (verified domains, owner MFA). */
router.get(contractRoute(ELIGIBILITY, ECOSYSTEM_INTERNAL_MOUNT), ...pluginOnly(ELIGIBILITY.callers), getPublisherEligibility);

/** How many Ecosystem Managers could decide a request (minus conflicts of interest). */
router.get(contractRoute(APPROVERS, ECOSYSTEM_INTERNAL_MOUNT), ...pluginOnly(APPROVERS.callers), getEcosystemApprovers);

export default router;
