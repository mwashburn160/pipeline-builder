// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { PLATFORM_INTERNAL, contractRoute, requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getOrgFeatures } from '../controllers/features-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

/**
 * `/internal/features/:orgId` — an org's ORG-LEVEL feature flags, for a service
 * that must decide on a feature outside any request (the pipeline service's
 * runner dispatcher re-checking the operator-granted `cross_account_runners`).
 * INTERNAL and named-caller gated; the mesh policy on the Istio targets names
 * the same caller, compose relies on this gate alone.
 */
/** Where `mount.ts` mounts this router — the contract's path is under it. */
export const FEATURES_INTERNAL_MOUNT = '/internal/features';

const { orgFeatures: FEATURES } = PLATFORM_INTERNAL;

const router: Router = Router();

router.get(contractRoute(FEATURES, FEATURES_INTERNAL_MOUNT), requireServiceAuth, requireInternalService({ callers: [...FEATURES.callers] }), getOrgFeatures);

export default router;
