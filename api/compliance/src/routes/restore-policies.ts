// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam, requireStepUp } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { compliancePolicyService } from '../services/policy-service.js';
import { emitComplianceAudit } from '../services/remote-audit-client.js';

/**
 * Restore route — undo a soft-delete within the retention window. `requireStepUp`
 * is applied on the route itself (the composite `/compliance/policies` router
 * already supplies auth + orgId + `compliance:write`, but not step-up), matching
 * the pipeline restore's "re-verify before reversing a destructive action".
 */
export function createRestorePolicyRoutes(): Router {
  const router = Router();

  router.post('/:id/restore', requireStepUp, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Policy ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const existing = await compliancePolicyService.findDeletedById(id, orgId);
    if (!existing) return sendEntityNotFound(res, 'Policy');

    const restored = await compliancePolicyService.restore(id, orgId, userId);
    if (!restored) return sendEntityNotFound(res, 'Policy');

    ctx.log('COMPLETED', 'Restored compliance policy', { id, name: restored.name });

    emitComplianceAudit({
      action: 'compliance.policy.restore',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'policy',
      targetId: id,
      details: { name: restored.name },
    });

    return sendSuccess(res, 200, undefined, 'Policy restored');
  }));

  return router;
}
