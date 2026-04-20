// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendError, ErrorCode, isSystemOrg, validateBody } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { ComplianceRuleCreateSchema } from './rule-schemas';
import { validateRuleRegexPatterns } from '../engine/rule-operators';
import { complianceRuleService } from '../services/compliance-rule-service';

export function createCreateRuleRoutes(): Router {
  const router = Router();

  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ComplianceRuleCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    // Published rules can only be created by system org
    if (body.scope === 'published' && !isSystemOrg(req)) {
      return sendError(res, 403, 'Only system org can create published rules', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const regexError = validateRuleRegexPatterns(body);
    if (regexError) return sendBadRequest(res, regexError, ErrorCode.VALIDATION_ERROR);

    const rule = await complianceRuleService.create({
      ...body,
      orgId,
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
      effectiveUntil: body.effectiveUntil ? new Date(body.effectiveUntil) : undefined,
      createdBy: userId,
      updatedBy: userId,
    } as unknown as Parameters<typeof complianceRuleService.create>[0], userId);

    ctx.log('COMPLETED', 'Created compliance rule', { id: rule.id, name: rule.name });
    return sendSuccess(res, 201, { rule });
  }));

  return router;
}
