// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requireAuth,
  isSystemAdmin,
  sendSuccess,
  sendError,
  ErrorCode,
  VALID_QUOTA_TYPES,
  getParam,
} from '@pipeline-builder/api-core';
import type { QuotaType } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, RequestHandler } from 'express';
import {
  AUTH_OPTS,
  isValidQuotaType,
} from '../helpers/quota-helpers';
import { authorizeOrg } from '../middleware/authorize-org';
import { quotaService } from '../services/quota-service';

const router: Router = Router();

// GET /quotas — own org quotas (orgId from JWT / header)

router.get(
  '/',
  requireAuth(AUTH_OPTS) as RequestHandler,
  withRoute(async ({ res, ctx, orgId }) => {
    const quota = await quotaService.findByOrgId(orgId);
    ctx.log('COMPLETED', 'Retrieved own org quotas', { orgId });
    return sendSuccess(res, 200, { quota });
  }),
);

// GET /quotas/all — all organizations with quotas (system admin only)
// NOTE: Must be registered before /:orgId to avoid being caught by that route.

router.get(
  '/all',
  requireAuth(AUTH_OPTS) as RequestHandler,
  withRoute(async ({ req, res, ctx }) => {
    if (!isSystemAdmin(req)) {
      return sendError(
        res, 403,
        'Access denied. Only system administrators can view all organizations.',
        ErrorCode.INSUFFICIENT_PERMISSIONS,
      );
    }

    const organizations = await quotaService.findAll();
    ctx.log('COMPLETED', 'Listed all organizations', { total: organizations.length });
    return sendSuccess(res, 200, { organizations, total: organizations.length });
  }),
);

// GET /quotas/:orgId — all quotas for a specific org

router.get(
  '/:orgId',
  requireAuth(AUTH_OPTS) as RequestHandler,
  authorizeOrg() as RequestHandler,
  withRoute(async ({ req, res, ctx }) => {
    const targetOrgId = getParam(req.params, 'orgId')!;

    const quota = await quotaService.findByOrgId(targetOrgId);
    ctx.log('COMPLETED', 'Retrieved org quotas', { orgId: targetOrgId });
    return sendSuccess(res, 200, { quota });
  }),
);

// GET /quotas/:orgId/:quotaType — single quota type status

router.get(
  '/:orgId/:quotaType',
  requireAuth(AUTH_OPTS) as RequestHandler,
  authorizeOrg() as RequestHandler,
  withRoute(async ({ req, res, ctx }) => {
    const targetOrgId = getParam(req.params, 'orgId')!;
    const quotaType = getParam(req.params, 'quotaType');

    if (!quotaType || !isValidQuotaType(quotaType)) return sendError(res, 400, `Invalid quota type. Must be one of: ${VALID_QUOTA_TYPES.join(', ')}`, ErrorCode.VALIDATION_ERROR);

    const status = await quotaService.getQuotaStatus(targetOrgId, quotaType as QuotaType);
    ctx.log('COMPLETED', 'Retrieved quota status', { orgId: targetOrgId, quotaType });
    return sendSuccess(res, 200, { quotaType, status });
  }),
);

/** Read-side quota router (mounted at /quotas). */
export default router;
