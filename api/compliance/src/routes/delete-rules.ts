import { Router } from 'express';
import { sendSuccess, sendEntityNotFound, getParam } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { complianceRuleService } from '../services/compliance-rule-service';

export function createDeleteRuleRoutes(): Router {
  const router = Router();

  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Rule');

    const deleted = await complianceRuleService.delete(id, orgId, userId || 'system');
    if (!deleted) return sendEntityNotFound(res, 'Rule');

    ctx.log('COMPLETED', 'Deleted compliance rule', { id, name: deleted.name });
    return sendSuccess(res, 200, undefined, 'Rule deleted');
  }));

  return router;
}
