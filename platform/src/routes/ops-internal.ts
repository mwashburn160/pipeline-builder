// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ops-center's reads of platform-held identity data (controllers/ops-internal.ts).
 * Service token only, ops-center only.
 */

import { PLATFORM_INTERNAL, contractRoute, requireInternalService } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { getLiveOrgIds, getOrgAccountRoot, postAuditActivity } from '../controllers/ops-internal.js';
import { requireServiceAuth } from '../middleware/index.js';

/** Where `mount.ts` mounts this router — the contracts' paths are under it. */
export const OPS_INTERNAL_MOUNT = '/internal/ops';

const { orgAccountRoot: ROOT, auditActivity: ACTIVITY, liveOrgIds: LIVE } = PLATFORM_INTERNAL;

const router: Router = Router();

router.get(contractRoute(ROOT, OPS_INTERNAL_MOUNT), requireServiceAuth, requireInternalService({ callers: [...ROOT.callers] }), getOrgAccountRoot);
router.post(contractRoute(ACTIVITY, OPS_INTERNAL_MOUNT), requireServiceAuth, requireInternalService({ callers: [...ACTIVITY.callers] }), postAuditActivity);
router.get(contractRoute(LIVE, OPS_INTERNAL_MOUNT), requireServiceAuth, requireInternalService({ callers: [...LIVE.callers] }), getLiveOrgIds);

export default router;
