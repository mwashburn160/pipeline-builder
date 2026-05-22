// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendError, ErrorCode, isSystemAdmin, validateBody } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { withTenantTx } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { z } from 'zod';
import { complianceRuleService } from '../services/compliance-rule-service';
import { compliancePolicyService } from '../services/policy-service';

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

    // Template policies are operator-curated content that ships to every
    // org; only sysadmins may create them.
    if (body.isTemplate && !isSystemAdmin(req)) {
      return sendError(res, 403, 'Only sysadmins can create template policies', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // Use a transaction so policy creation + rule linking are atomic.
    // withTenantTx adds the SET LOCAL `app.org_id` + `app.is_sysadmin` GUCs
    // from the request's AsyncLocalStorage scope so the inner CrudService
    // calls (compliancePolicyService.create, complianceRuleService.update)
    // are RLS-clean once policies are FORCE'd.
    const policy = await withTenantTx(async () => {
      const created = await compliancePolicyService.create({
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
            await complianceRuleService.update(rule.id, { policyId: created.id }, orgId, userId);
          }
        }
      }

      return created;
    });

    ctx.log('COMPLETED', 'Created compliance policy', { id: policy.id, name: policy.name });
    return sendSuccess(res, 201, { policy });
  }));

  return router;
}
