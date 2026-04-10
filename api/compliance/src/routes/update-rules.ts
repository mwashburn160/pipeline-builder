// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam, validateBody } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { ComplianceRuleUpdateSchema } from './rule-schemas';
import { validateRuleRegexPatterns } from '../engine/rule-operators';
import { complianceRuleService } from '../services/compliance-rule-service';

export function createUpdateRuleRoutes(): Router {
  const router = Router();

  router.put('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Rule ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, ComplianceRuleUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    const regexError = validateRuleRegexPatterns(body);
    if (regexError) return sendBadRequest(res, regexError, ErrorCode.VALIDATION_ERROR);

    const updateData: Record<string, unknown> = { ...body };

    if (body.effectiveFrom !== undefined) {
      updateData.effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : null;
    }
    if (body.effectiveUntil !== undefined) {
      updateData.effectiveUntil = body.effectiveUntil ? new Date(body.effectiveUntil) : null;
    }

    const updated = await complianceRuleService.update(id, updateData, orgId, userId);
    if (!updated) return sendEntityNotFound(res, 'Rule');

    ctx.log('COMPLETED', 'Updated compliance rule', { id: updated.id, name: updated.name });
    return sendSuccess(res, 200, { rule: updated });
  }));

  return router;
}
