// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, audited, getParam, requirePermission, validateBody, actorId, recordAudit } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { ComplianceRuleUpdateSchema } from './rule-schemas.js';
import { rejectIfInheritedRule } from '../helpers/inherited-rule-guard.js';
import { complianceRuleService, InvalidRuleRegexError, InvalidSetTagError } from '../services/compliance-rule-service.js';

export function createUpdateRuleRoutes(): Router {
  const router = Router();

  router.put('/:id', requirePermission('compliance:write'), audited('compliance.rule.update'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Rule ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, ComplianceRuleUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;
    const updateData: Record<string, unknown> = { ...body };

    if (body.effectiveFrom !== undefined) {
      updateData.effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : null;
    }
    if (body.effectiveUntil !== undefined) {
      updateData.effectiveUntil = body.effectiveUntil ? new Date(body.effectiveUntil) : null;
    }

    try {
      const updated = await complianceRuleService.update(id, updateData, orgId, userId);
      if (!updated) {
        // Not in the caller's org — a team editing its parent's propagated rule gets a clear 403.
        if (await rejectIfInheritedRule(req, res, id)) return;
        return sendEntityNotFound(res, 'Rule');
      }

      ctx.log('COMPLETED', 'Updated compliance rule', { id: updated.id, name: updated.name });

      // Best-effort attributed audit — the rule update succeeded. Safe scalar
      // metadata only; never the full rule definition.
      recordAudit({
        action: 'compliance.rule.update',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'rule',
        targetId: updated.id,
        details: { name: updated.name, target: updated.target, scope: updated.scope },
      });

      return sendSuccess(res, 200, { rule: updated });
    } catch (err) {
      if (err instanceof InvalidRuleRegexError || err instanceof InvalidSetTagError) {
        return sendBadRequest(res, err.message, ErrorCode.VALIDATION_ERROR);
      }
      throw err;
    }
  }));

  return router;
}
