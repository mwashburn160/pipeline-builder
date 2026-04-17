// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, parsePaginationParams } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { schema, db, buildComplianceAuditConditions, drizzleCount } from '@pipeline-builder/pipeline-core';
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
      target: req.query.target as 'plugin' | 'pipeline' | undefined,
      action: req.query.action as string | undefined,
      result: req.query.result as 'pass' | 'warn' | 'block' | undefined,
      scanId: req.query.scanId as string | undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
    };

    const conditions = buildComplianceAuditConditions(filter, orgId);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceAuditLog)
      .where(whereClause).then(r => drizzleCount(r));

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
