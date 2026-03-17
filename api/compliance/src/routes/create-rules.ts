import { Router } from 'express';
import { sendSuccess, sendBadRequest, sendError, ErrorCode, validateBody } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { z } from 'zod';
import { complianceRuleService } from '../services/compliance-rule-service';
import { validateRegexPattern } from '../engine/rule-operators';

const ConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.string().min(1),
  value: z.unknown().optional(),
  dependsOnRule: z.string().uuid().optional(),
});

const ComplianceRuleCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  policyId: z.string().uuid().optional(),
  priority: z.number().int().min(0).max(10000).default(0),
  target: z.enum(['plugin', 'pipeline']),
  severity: z.enum(['warning', 'error', 'critical']).default('error'),
  tags: z.array(z.string()).default([]),
  effectiveFrom: z.string().datetime().optional(),
  effectiveUntil: z.string().datetime().optional(),
  scope: z.enum(['org', 'global']).default('org'),
  suppressNotification: z.boolean().default(false),
  field: z.string().max(100).optional(),
  operator: z.string().max(20).optional(),
  value: z.unknown().optional(),
  conditions: z.array(ConditionSchema).optional(),
  conditionMode: z.enum(['all', 'any']).default('all'),
});

export function createCreateRuleRoutes(): Router {
  const router = Router();

  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ComplianceRuleCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const body = validation.value;

    // Global rules can only be created by system org
    if (body.scope === 'global' && orgId !== 'system') {
      return sendError(res, 403, 'Only system org can create global rules', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // Validate regex patterns
    if (body.operator === 'regex' && typeof body.value === 'string') {
      const regexError = validateRegexPattern(body.value);
      if (regexError) return sendBadRequest(res, regexError, ErrorCode.VALIDATION_ERROR);
    }

    const rule = await complianceRuleService.create({
      ...body,
      orgId,
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
      effectiveUntil: body.effectiveUntil ? new Date(body.effectiveUntil) : undefined,
      createdBy: userId || 'system',
      updatedBy: userId || 'system',
    } as any, userId || 'system');

    ctx.log('COMPLETED', 'Created compliance rule', { id: rule.id, name: rule.name });
    return sendSuccess(res, 201, { rule });
  }));

  return router;
}
