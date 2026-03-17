import { sendSuccess, sendEntityNotFound, getParam, parsePaginationParams } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { schema, db } from '@mwashburn160/pipeline-core';
import { eq, and, desc, sql } from 'drizzle-orm';
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
      scope: req.query.scope as 'org' | 'global' | undefined,
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

    const conditions = and(
      eq(schema.complianceRuleHistory.ruleId, id),
      eq(schema.complianceRuleHistory.orgId, orgId),
    );

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceRuleHistory)
      .where(conditions) as unknown as [{ count: number }];

    const history = await db
      .select()
      .from(schema.complianceRuleHistory)
      .where(conditions)
      .orderBy(desc(schema.complianceRuleHistory.changedAt))
      .limit(limit)
      .offset(offset);

    return sendSuccess(res, 200, {
      history,
      pagination: { total: countResult?.count ?? 0, limit, offset, hasMore: offset + history.length < (countResult?.count ?? 0) },
    });
  }));

  return router;
}
