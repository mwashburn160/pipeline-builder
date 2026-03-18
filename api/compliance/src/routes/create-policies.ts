import { sendSuccess, sendBadRequest, sendError, ErrorCode, SYSTEM_ORG_ID, validateBody } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { compliancePolicyService } from '../services/policy-service';
import { complianceRuleService } from '../services/compliance-rule-service';

const CompliancePolicyCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  version: z.string().max(50).default('1.0.0'),
  isTemplate: z.boolean().default(false),
  isActive: z.boolean().default(true),
  tags: z.array(z.string()).optional(),
  rules: z.array(z.string()).optional(),
});

export function createCreatePolicyRoutes(): Router {
  const router = Router();

  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, CompliancePolicyCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { rules: ruleNames, tags, ...body } = validation.value;

    // Template policies can only be created by system org
    if (body.isTemplate && orgId !== SYSTEM_ORG_ID) {
      return sendError(res, 403, 'Only system org can create template policies', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    const policy = await compliancePolicyService.create({
      ...body,
      orgId,
      createdBy: userId,
      updatedBy: userId,
    } as unknown as Parameters<typeof compliancePolicyService.create>[0], userId);

    // Link existing rules by name to this policy
    if (ruleNames && ruleNames.length > 0) {
      const allRules = await complianceRuleService.find({}, orgId);
      for (const ruleName of ruleNames) {
        const rule = allRules.find(r => r.name === ruleName);
        if (rule) {
          await complianceRuleService.update(rule.id, { policyId: policy.id }, orgId, userId);
        }
      }
    }

    ctx.log('COMPLETED', 'Created compliance policy', { id: policy.id, name: policy.name });
    return sendSuccess(res, 201, { policy });
  }));

  return router;
}
