import { sendSuccess, sendBadRequest, sendError, ErrorCode, SYSTEM_ORG_ID, validateBody } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { ComplianceRuleCreateSchema } from './rule-schemas';
import { validateRegexPattern } from '../engine/rule-operators';
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
    if (body.scope === 'published' && orgId !== SYSTEM_ORG_ID) {
      return sendError(res, 403, 'Only system org can create published rules', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // Validate regex patterns in single-field and cross-field conditions
    if (body.operator === 'regex' && typeof body.value === 'string') {
      const regexError = validateRegexPattern(body.value);
      if (regexError) return sendBadRequest(res, regexError, ErrorCode.VALIDATION_ERROR);
    }
    if (body.conditions) {
      for (const c of body.conditions) {
        if (c.operator === 'regex' && typeof c.value === 'string') {
          const regexError = validateRegexPattern(c.value);
          if (regexError) return sendBadRequest(res, `Condition "${c.field}": ${regexError}`, ErrorCode.VALIDATION_ERROR);
        }
      }
    }

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
