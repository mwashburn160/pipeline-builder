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
  requirePermission,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { emitComplianceAudit } from '../services/audit.js';
import {
  complianceExemptionService,
  CE_NOT_FOUND,
  CE_SELF_APPROVE,
} from '../services/compliance-exemption-service.js';

/** Exemption CRUD routes. */

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
  // The schema has no unique constraint on (ruleId, entityType, entityId), so
  // duplicates are NOT deduplicated server-side — every input row produces a
  // row in the table. Callers are responsible for not double-submitting.
  router.post('/bulk', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, BulkExemptionsSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const ids = await complianceExemptionService.bulkCreate(validation.value.exemptions, orgId, userId);

    const requested = validation.value.exemptions.length;
    const created = ids.length;
    ctx.log('COMPLETED', 'Bulk exemption insert', { requested, created });
    return sendSuccess(res, 201, {
      created,
      skipped: requested - created,
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

  // PUT /:id/review — approve or reject an exemption. Approval is a governance
  // decision, so it requires an org admin/owner (any member may *request* an
  // exemption via POST /, but only an admin reviews it). The service still
  // blocks self-approval (CE_SELF_APPROVE) so an admin can't approve their own.
  router.put('/:id/review', requirePermission('compliance:write'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
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

      // Best-effort attributed audit — only the APPROVE direction is a
      // posture-weakening governance decision worth recording as an approval.
      if (validation.value.status === 'approved') {
        emitComplianceAudit({
          action: 'compliance.exemption.approve',
          actorId: userId,
          orgId,
          targetType: 'exemption',
          targetId: id,
        });
      }

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

  // DELETE /:id — revoke an exemption. Admin-gated like PUT /:id/review: revoking
  // re-imposes a rule (can block a previously-compliant entity), so it's an
  // admin action, not something any member should do.
  router.delete('/:id', requirePermission('compliance:write'), withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Exemption ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const deleted = await complianceExemptionService.delete(id, orgId);
    if (!deleted) return sendEntityNotFound(res, 'Exemption');

    ctx.log('COMPLETED', 'Deleted exemption', { id });
    return sendSuccess(res, 200, undefined, 'Exemption deleted');
  }));

  return router;
}
