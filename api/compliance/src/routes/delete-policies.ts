import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { compliancePolicyService } from '../services/policy-service';

export function createDeletePolicyRoutes(): Router {
  const router = Router();

  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Policy ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const deleted = await compliancePolicyService.delete(id, orgId, userId);
    if (!deleted) return sendEntityNotFound(res, 'Policy');

    ctx.log('COMPLETED', 'Deleted compliance policy', { id, name: deleted.name });
    return sendSuccess(res, 200, undefined, 'Policy deleted');
  }));

  return router;
}
