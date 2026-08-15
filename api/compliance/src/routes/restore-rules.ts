// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam, requireStepUp } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { complianceRuleService } from '../services/compliance-rule-service.js';
import { emitComplianceAudit } from '../services/remote-audit-client.js';

/**
 * Restore route — undo a soft-delete within the retention window. `requireStepUp`
 * is on the route (the composite `/compliance/rules` router supplies auth + orgId
 * + `compliance:write`, not step-up). The rule service's `onAfterRestore` hook
 * re-invalidates caches + rescans so a restored rule re-enters evaluation.
 */
export function createRestoreRuleRoutes(): Router {
  const router = Router();

  router.post('/:id/restore', requireStepUp, withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Rule ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const existing = await complianceRuleService.findDeletedById(id, orgId);
    if (!existing) return sendEntityNotFound(res, 'Rule');

    const restored = await complianceRuleService.restore(id, orgId, userId);
    if (!restored) return sendEntityNotFound(res, 'Rule');

    ctx.log('COMPLETED', 'Restored compliance rule', { id, name: restored.name });

    emitComplianceAudit({
      action: 'compliance.rule.restore',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      affectedOrgId: existing.orgId,
      targetType: 'rule',
      targetId: id,
      details: { name: restored.name },
    });

    return sendSuccess(res, 200, undefined, 'Rule restored');
  }));

  return router;
}
