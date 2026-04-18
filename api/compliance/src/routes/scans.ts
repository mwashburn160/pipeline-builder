// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam, parsePaginationParams, validateBody } from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { schema, db, buildComplianceScanConditions, drizzleCount } from '@mwashburn160/pipeline-core';
import { and, eq, desc, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';

/**
 * Feature #7: Compliance scan implementation.
 * Scans re-evaluate existing entities against current rules.
 */

const ScanCreateSchema = z.object({
  target: z.enum(['plugin', 'pipeline', 'all']),
  filter: z.record(z.string(), z.unknown()).optional(),
  dryRun: z.boolean().optional(),
});

export function createScanRoutes(): Router {
  const router = Router();

  // GET / — list scans (paginated, filterable)
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const filter = {
      target: req.query.target as 'plugin' | 'pipeline' | 'all' | undefined,
      status: req.query.status as 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | undefined,
      triggeredBy: req.query.triggeredBy as 'manual' | 'scheduled' | 'rule-change' | 'rule-dry-run' | undefined,
    };

    const conditions = buildComplianceScanConditions(filter, orgId);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceScan)
      .where(whereClause).then(r => drizzleCount(r));

    const scans = await db
      .select()
      .from(schema.complianceScan)
      .where(whereClause)
      .orderBy(desc(schema.complianceScan.createdAt))
      .limit(limit)
      .offset(offset);

    const total = countResult?.count ?? 0;
    ctx.log('COMPLETED', 'Listed compliance scans', { count: scans.length });
    return sendSuccess(res, 200, {
      scans,
      pagination: { total, limit, offset, hasMore: offset + scans.length < total },
    });
  }));

  // GET /:id — get scan by ID
  router.get('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendEntityNotFound(res, 'Scan');

    const [scan] = await db
      .select()
      .from(schema.complianceScan)
      .where(and(
        eq(schema.complianceScan.id, id),
        eq(schema.complianceScan.orgId, orgId),
      ));

    if (!scan) return sendEntityNotFound(res, 'Scan');
    ctx.log('COMPLETED', 'Fetched compliance scan', { scanId: id });
    return sendSuccess(res, 200, { scan });
  }));

  // POST / — trigger a new scan
  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ScanCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const triggeredBy = validation.value.dryRun ? 'rule-dry-run' : 'manual';

    const [scan] = await db
      .insert(schema.complianceScan)
      .values({
        orgId,
        target: validation.value.target,
        filter: validation.value.filter as Record<string, unknown> ?? null,
        status: 'pending',
        triggeredBy,
        userId,
      })
      .returning();

    ctx.log('COMPLETED', 'Triggered compliance scan', { scanId: scan.id, target: validation.value.target });
    return sendSuccess(res, 201, { scan });
  }));

  // POST /:id/cancel — cancel a running scan
  router.post('/:id/cancel', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Scan ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const [updated] = await db
      .update(schema.complianceScan)
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: userId })
      .where(and(
        eq(schema.complianceScan.id, id),
        eq(schema.complianceScan.orgId, orgId),
        eq(schema.complianceScan.status, 'running'),
      ))
      .returning();

    if (!updated) return sendEntityNotFound(res, 'Running scan');

    ctx.log('COMPLETED', 'Cancelled compliance scan', { scanId: id });
    return sendSuccess(res, 200, { scan: updated });
  }));

  return router;
}
