// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, audited, getParam, requirePermission, actorId } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { rejectIfInheritedRule } from '../helpers/inherited-rule-guard.js';
import { emitComplianceAudit } from '../services/audit.js';
import { complianceRuleService } from '../services/compliance-rule-service.js';

export function createDeleteRuleRoutes(): Router {
  const router = Router();

  router.delete('/:id', requirePermission('compliance:write'), audited('compliance.rule.delete'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Rule ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const deleted = await complianceRuleService.delete(id, orgId, userId);
    if (!deleted) {
      // Not in the caller's org — a team deleting its parent's propagated rule gets a clear 403.
      if (await rejectIfInheritedRule(req, res, id)) return;
      return sendEntityNotFound(res, 'Rule');
    }

    ctx.log('COMPLETED', 'Deleted compliance rule', { id, name: deleted.name });

    // Best-effort attributed audit — the rule delete succeeded.
    emitComplianceAudit({
      action: 'compliance.rule.delete',
      actorId: actorId({ userId }),
      orgId,
      targetType: 'rule',
      targetId: id,
      details: { name: deleted.name },
    });

    return sendSuccess(res, 200, undefined, 'Rule deleted');
  }));

  return router;
}
