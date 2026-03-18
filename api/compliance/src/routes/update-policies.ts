import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam, validateBody } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { z } from 'zod';
import { compliancePolicyService } from '../services/policy-service';

const CompliancePolicyUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  version: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
});

export function createUpdatePolicyRoutes(): Router {
  const router = Router();

  router.put('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Policy ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, CompliancePolicyUpdateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const updated = await compliancePolicyService.update(id, validation.value, orgId, userId);
    if (!updated) return sendEntityNotFound(res, 'Policy');

    ctx.log('COMPLETED', 'Updated compliance policy', { id: updated.id, name: updated.name });
    return sendSuccess(res, 200, { policy: updated });
  }));

  return router;
}
