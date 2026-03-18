import { sendSuccess, parsePaginationParams } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { schema, db, buildComplianceAuditConditions } from '@mwashburn160/pipeline-core';
import { and, desc, sql } from 'drizzle-orm';
import { Router } from 'express';

/**
 * Feature #2: Audit log read endpoint.
 */
export function createAuditRoutes(): Router {
  const router = Router();

  // GET / — list audit log entries (paginated, filterable)
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const filter = {
      target: req.query.target as string | undefined,
      action: req.query.action as string | undefined,
      result: req.query.result as string | undefined,
      scanId: req.query.scanId as string | undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
    };

    const conditions = buildComplianceAuditConditions(filter, orgId);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceAuditLog)
      .where(whereClause) as unknown as [{ count: number }];

    const entries = await db
      .select()
      .from(schema.complianceAuditLog)
      .where(whereClause)
      .orderBy(desc(schema.complianceAuditLog.createdAt))
      .limit(limit)
      .offset(offset);

    const total = countResult?.count ?? 0;
    ctx.log('COMPLETED', 'Listed compliance audit log', { count: entries.length });
    return sendSuccess(res, 200, {
      entries,
      pagination: { total, limit, offset, hasMore: offset + entries.length < total },
    });
  }));

  return router;
}
