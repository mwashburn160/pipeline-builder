// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  requireAuth,
  isSystemAdmin,
  NotFoundError,
  sendSuccess,
  sendBadRequest,
  sendQuotaExceeded,
  ErrorCode,
  getParam,
  validateBody,
} from '@pipeline-builder/api-core';
import type { QuotaType } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { INTERNAL_AUTH_OPTS } from '../helpers/quota-helpers';
import { authorizeOrg } from '../middleware/authorize-org';
import { quotaService, OrgNotFoundError } from '../services/quota-service';
import { UpdateQuotaSchema, IncrementQuotaSchema, DecrementQuotaSchema, ResetQuotaSchema } from '../validation/schemas';

export function createUpdateQuotaRoutes(): Router {
  const router: Router = Router();

  // PUT /quotas/:orgId  update org name, slug, and/or quota limits (system admin only)

  router.put( '/:orgId',
    requireAuth as RequestHandler,
    authorizeOrg({ requireSystemAdmin: true }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;

      const validation = validateBody(req, UpdateQuotaSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const body = validation.value;

      try {
        const result = await quotaService.update(targetOrgId, body);
        ctx.log('COMPLETED', 'Updated quota', { orgId: targetOrgId });
        return sendSuccess(res, 200, { quota: result }, 'Updated successfully');
      } catch (error) {
        if (error instanceof OrgNotFoundError) throw new NotFoundError('Organization not found.');
        throw error;
      }
    }),
  );

  // DELETE /quotas/:orgId � cascade hook (system admin only). Drops the
  // org's quota document. Idempotent: returns 200 with `deleted: false` when
  // the org was already gone, which lets the platform cascade run repeatedly
  // without orchestration babysitting.

  router.delete( '/:orgId',
    requireAuth as RequestHandler,
    authorizeOrg({ requireSystemAdmin: true }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;
      const deleted = await quotaService.delete(targetOrgId);
      ctx.log('COMPLETED', deleted ? 'Quota org deleted': 'Quota org delete: not found', { orgId: targetOrgId });
      return sendSuccess(res, 200, { deleted }, deleted ? 'Quota org deleted': 'Quota org was already absent');
    }),
  );

  // POST /quotas/:orgId/reset  reset usage counters (system admin only)

  router.post( '/:orgId/reset',
    requireAuth as RequestHandler,
    authorizeOrg({ requireSystemAdmin: true }) as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;

      const validation = validateBody(req, ResetQuotaSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const { quotaType } = validation.value;

      try {
        const result = await quotaService.resetUsage(targetOrgId, quotaType);
        ctx.log('COMPLETED', 'Reset quota usage', { orgId: targetOrgId, quotaType });
        return sendSuccess( res, 200,
          { quota: result },
          quotaType ? `${quotaType} usage reset successfully`: 'All quota usage reset successfully',
        );
      } catch (error) {
        if (error instanceof OrgNotFoundError) throw new NotFoundError('Organization not found.');
        throw error;
      }
    }),
  );

  // POST /quotas/:orgId/increment  increment usage (internal service use only)
  // Accepts same-org or system admin auth. This endpoint is intended for
  // internal service-to-service calls (pipeline, plugin services) and should
  // not be exposed directly to end users.

  router.post( '/:orgId/increment',
    requireAuth(INTERNAL_AUTH_OPTS) as RequestHandler,
    authorizeOrg() as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;

      const validation = validateBody(req, IncrementQuotaSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const { quotaType, amount } = validation.value;

      try {
        const typedType = quotaType as QuotaType;
        const result = await quotaService.incrementUsage(targetOrgId, typedType, amount, isSystemAdmin(req));

        if (result.exceeded) {
          return sendQuotaExceeded( res,
            quotaType,
            {
              type: result.quota.type,
              limit: result.quota.limit,
              used: result.quota.used,
              remaining: result.quota.remaining,
            },
            result.quota.resetAt,
          );
        }

        ctx.log('COMPLETED', 'Incremented quota usage', { orgId: targetOrgId, quotaType, amount });
        return sendSuccess(res, 200, { quota: result.quota }, 'Usage incremented successfully');
      } catch (error) {
        if (error instanceof OrgNotFoundError) throw new NotFoundError('Organization not found.');
        throw error;
      }
    }),
  );

  // POST /quotas/:orgId/decrement  roll back a previously reserved increment.
  // Internal-only, same auth as /increment. Used by routes that adopt the
  // "reserve before action, rollback on failure" pattern to give the
  // quota slot back when the action they were gating fails.

  router.post( '/:orgId/decrement',
    requireAuth(INTERNAL_AUTH_OPTS) as RequestHandler,
    authorizeOrg() as RequestHandler,
    withRoute(async ({ req, res, ctx }) => {
      const targetOrgId = getParam(req.params, 'orgId')!;

      const validation = validateBody(req, DecrementQuotaSchema);
      if (!validation.ok) return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
      const { quotaType, amount } = validation.value;

      const typedType = quotaType as QuotaType;
      const result = await quotaService.decrementUsage(targetOrgId, typedType, amount);

      // Org not found is reported via 200 + `quota: null` rather than 404 so
      // that fire-and-forget rollback paths don't add a spurious error when
      // the original action's failure was already org-not-found.
      if (!result) {
        ctx.log('WARN', 'Decrement skipped: org not found', { orgId: targetOrgId, quotaType });
        return sendSuccess(res, 200, { quota: null }, 'Org not found, decrement skipped');
      }

      ctx.log('COMPLETED', 'Decremented quota usage', { orgId: targetOrgId, quotaType, amount });
      return sendSuccess(res, 200, { quota: result.quota }, 'Usage decremented successfully');
    }),
  );

  return router;
}
