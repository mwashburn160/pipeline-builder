import { sendSuccess, sendEntityNotFound, getParam, parsePaginationParams } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { Router } from 'express';
import { complianceRuleService } from '../services/compliance-rule-service';

export function createReadRuleRoutes(): Router {
  const router = Router();

  // GET / — list rules with pagination and filters
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset, sortBy, sortOrder } = parsePaginationParams(req.query);
    const filter = {
      name: req.query.name as string | undefined,
      policyId: req.query.policyId as string | undefined,
      target: req.query.target as 'plugin' | 'pipeline' | undefined,
      severity: req.query.severity as 'warning' | 'error' | 'critical' | undefined,
      scope: req.query.scope as 'org' | 'published' | undefined,
      tag: req.query.tag as string | undefined,
    };

    const result = await complianceRuleService.findPaginated(
      filter, orgId, { limit, offset, sortBy: sortBy || 'priority', sortOrder: sortOrder || 'desc' },
    );

    ctx.log('COMPLETED', 'Listed compliance rules', { count: result.data.length });
    return sendSuccess(res, 200, {
      rules: result.data,
      pagination: { total: result.total, limit: result.limit, offset: result.offset, hasMore: result.hasMore },
    });
  }));

  // GET /:id — single rule by ID
  router.get('/:id', withRoute(async ({ req, res, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Rule');

    const rule = await complianceRuleService.findById(id, orgId);
    if (!rule) return sendEntityNotFound(res, 'Rule');

    return sendSuccess(res, 200, { rule });
  }));

  // GET /:id/history — rule change history (org-scoped, paginated)
  router.get('/:id/history', withRoute(async ({ req, res, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Rule');

    const { limit, offset } = parsePaginationParams(req.query);
    const { history, total } = await complianceRuleService.findRuleHistory(id, orgId, { limit, offset });

    return sendSuccess(res, 200, {
      history,
      pagination: { total, limit, offset, hasMore: offset + history.length < total },
    });
  }));

  return router;
}
