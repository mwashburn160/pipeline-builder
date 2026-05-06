// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  sendSuccess,
  sendPaginatedNested,
  sendBadRequest,
  sendEntityNotFound,
  ErrorCode,
  errorMessage,
  getParam,
  parsePaginationParams,
  validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import {
  complianceExemptionService,
  CE_NOT_FOUND,
  CE_SELF_APPROVE,
} from '../services/compliance-exemption-service';

/** Feature #3: Exemption CRUD routes. */

const ExemptionCreateSchema = z.object({
  ruleId: z.string().uuid(),
  entityType: z.enum(['plugin', 'pipeline']),
  entityId: z.string().uuid(),
  entityName: z.string().max(255).optional(),
  reason: z.string().min(1).max(2000),
  expiresAt: z.string().datetime().optional(),
});

const ExemptionReviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().max(2000).optional(),
});

const BulkExemptionsSchema = z.object({
  exemptions: z.array(ExemptionCreateSchema).min(1).max(500),
});

export function createExemptionRoutes(): Router {
  const router = Router();

  // GET / — list exemptions (paginated, filterable)
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const filter = {
      ruleId: req.query.ruleId as string | undefined,
      entityType: req.query.entityType as 'plugin' | 'pipeline' | undefined,
      entityId: req.query.entityId as string | undefined,
      status: req.query.status as 'pending' | 'approved' | 'rejected' | 'expired' | undefined,
    };

    const { exemptions, total } = await complianceExemptionService.list(filter, orgId, limit, offset);
    ctx.log('COMPLETED', 'Listed exemptions', { count: exemptions.length });
    return sendPaginatedNested(res, 'exemptions', exemptions, {
      total, limit, offset, hasMore: offset + exemptions.length < total,
    });
  }));

  // POST /bulk — bulk-create exemptions in one request (up to 500).
  // Skips any (ruleId, entityType, entityId) combination that already has an
  // active exemption for this org. Returns counts of created vs skipped.
  router.post('/bulk', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, BulkExemptionsSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const ids = await complianceExemptionService.bulkCreate(validation.value.exemptions, orgId, userId);

    ctx.log('COMPLETED', 'Bulk exemption insert', {
      requested: validation.value.exemptions.length,
      created: ids.length,
    });
    return sendSuccess(res, 201, {
      created: ids.length,
      skipped: validation.value.exemptions.length - ids.length,
      ids,
    });
  }));

  // POST / — request a new exemption
  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ExemptionCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const exemption = await complianceExemptionService.create(validation.value, orgId, userId);
    ctx.log('COMPLETED', 'Requested exemption', { id: exemption.id, ruleId: validation.value.ruleId });
    return sendSuccess(res, 201, { exemption });
  }));

  // PUT /:id/review — approve or reject an exemption.
  router.put('/:id/review', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Exemption ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, ExemptionReviewSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    try {
      const updated = await complianceExemptionService.review(
        id, orgId, userId,
        validation.value.status,
        validation.value.rejectionReason,
      );
      ctx.log('COMPLETED', `Exemption ${validation.value.status}`, { id, status: validation.value.status });
      return sendSuccess(res, 200, { exemption: updated });
    } catch (err) {
      const code = errorMessage(err);
      if (code === CE_NOT_FOUND) return sendEntityNotFound(res, 'Exemption');
      if (code === CE_SELF_APPROVE) {
        return sendBadRequest(
          res,
          'Cannot approve an exemption you requested. Another reviewer must approve.',
          ErrorCode.INSUFFICIENT_PERMISSIONS,
        );
      }
      throw err;
    }
  }));

  // DELETE /:id — revoke an exemption
  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Exemption ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const deleted = await complianceExemptionService.delete(id, orgId);
    if (!deleted) return sendEntityNotFound(res, 'Exemption');

    ctx.log('COMPLETED', 'Deleted exemption', { id });
    return sendSuccess(res, 200, undefined, 'Exemption deleted');
  }));

  return router;
}
