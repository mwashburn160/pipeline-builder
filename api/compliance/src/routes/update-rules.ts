import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam, validateBody } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { complianceRuleService } from '../services/compliance-rule-service';

const VALID_OPERATORS = [
  'eq', 'neq', 'contains', 'notContains', 'regex',
  'gt', 'gte', 'lt', 'lte', 'in', 'notIn',
  'exists', 'notExists', 'countGt', 'countLt', 'lengthGt', 'lengthLt',
] as const;

const OperatorEnum = z.enum(VALID_OPERATORS);

const ComplianceRuleUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  policyId: z.string().uuid().nullable().optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  severity: z.enum(['warning', 'error', 'critical']).optional(),
  tags: z.array(z.string()).optional(),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveUntil: z.string().datetime().nullable().optional(),
  suppressNotification: z.boolean().optional(),
  field: z.string().max(100).optional(),
  operator: OperatorEnum.optional(),
  value: z.unknown().optional(),
  conditions: z.array(z.object({
    field: z.string().min(1).max(100),
    operator: OperatorEnum,
    value: z.unknown().optional(),
    dependsOnRule: z.string().uuid().optional(),
  })).optional(),
  conditionMode: z.enum(['all', 'any']).optional(),
  isActive: z.boolean().optional(),
});

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
