// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendError, ErrorCode, isSystemAdmin, validateBody } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { emitComplianceAudit } from '../services/audit.js';
import { compliancePolicyService } from '../services/policy-service.js';

const CompliancePolicyCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  version: z.string().max(50).default('1.0.0'),
  isTemplate: z.boolean().default(false),
  isActive: z.boolean().default(true),
  rules: z.array(z.string()).optional(),
});

export function createCreatePolicyRoutes(): Router {
  const router = Router();

  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, CompliancePolicyCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { rules: ruleNames, ...body } = validation.value;

    // Template policies are operator-curated content that ships to every
    // org; only sysadmins may create them.
    if (body.isTemplate && !isSystemAdmin(req)) {
      return sendError(res, 403, 'Only sysadmins can create template policies', ErrorCode.INSUFFICIENT_PERMISSIONS);
    }

    // Policy insert + rule linking are atomic (one transaction) — see createWithRules.
    const policy = await compliancePolicyService.createWithRules({
      ...body,
      orgId,
      createdBy: userId,
      updatedBy: userId,
    } as unknown as Parameters<typeof compliancePolicyService.createWithRules>[0], ruleNames, userId);

    ctx.log('COMPLETED', 'Created compliance policy', { id: policy.id, name: policy.name });

    // Best-effort attributed audit — the policy create succeeded. Safe scalar
    // metadata only (name/version/template flag), never linked rule bodies.
    emitComplianceAudit({
      action: 'compliance.policy.create',
      actorId: req.user?.sub ?? userId ?? 'system',
      orgId,
      targetType: 'policy',
      targetId: policy.id,
      details: { name: policy.name, version: policy.version, isTemplate: policy.isTemplate },
    });

    return sendSuccess(res, 201, { policy });
  }));

  return router;
}
