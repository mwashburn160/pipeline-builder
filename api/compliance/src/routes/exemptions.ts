// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendEntityNotFound, ErrorCode, getParam, parsePaginationParams, validateBody } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { schema, db, buildComplianceExemptionConditions, drizzleCount } from '@pipeline-builder/pipeline-core';
import { and, eq, desc, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';

/**
 * Feature #3: Exemption CRUD routes.
 */

const ExemptionCreateSchema = z.object({
  ruleId: z.string().uuid(),
  entityType: z.enum(['plugin', 'pipeline']),
  entityId: z.string().uuid(),
  entityName: z.string().max(255).optional(),
  reason: z.string().min(1).max(2000),
  expiresAt: z.string().datetime().optional(),
});

const ExemptionReviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().max(2000).optional(),
});

export function createExemptionRoutes(): Router {
  const router = Router();

  // GET / — list exemptions (paginated, filterable)
  router.get('/', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query);
    const filter = {
      ruleId: req.query.ruleId as string | undefined,
      entityType: req.query.entityType as 'plugin' | 'pipeline' | undefined,
      entityId: req.query.entityId as string | undefined,
      status: req.query.status as 'pending' | 'approved' | 'rejected' | 'expired' | undefined,
    };

    const conditions = buildComplianceExemptionConditions(filter, orgId);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceExemption)
      .where(whereClause).then(r => drizzleCount(r));

    const exemptions = await db
      .select()
      .from(schema.complianceExemption)
      .where(whereClause)
      .orderBy(desc(schema.complianceExemption.createdAt))
      .limit(limit)
      .offset(offset);

    const total = countResult?.count ?? 0;
    ctx.log('COMPLETED', 'Listed exemptions', { count: exemptions.length });
    return sendSuccess(res, 200, {
      exemptions,
      pagination: { total, limit, offset, hasMore: offset + exemptions.length < total },
    });
  }));

  // POST / — request a new exemption
  router.post('/', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, ExemptionCreateSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const [exemption] = await db
      .insert(schema.complianceExemption)
      .values({
        ...validation.value,
        orgId,
        expiresAt: validation.value.expiresAt ? new Date(validation.value.expiresAt) : null,
        status: 'pending',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();

    ctx.log('COMPLETED', 'Requested exemption', { id: exemption.id, ruleId: validation.value.ruleId });
    return sendSuccess(res, 201, { exemption });
  }));

  // PUT /:id/review — approve or reject an exemption
  router.put('/:id/review', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Exemption ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, ExemptionReviewSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const [updated] = await db
      .update(schema.complianceExemption)
      .set({
        status: validation.value.status,
        approvedBy: validation.value.status === 'approved' ? userId : undefined,
        rejectionReason: validation.value.rejectionReason ?? null,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.complianceExemption.id, id),
        eq(schema.complianceExemption.orgId, orgId),
        eq(schema.complianceExemption.status, 'pending'),
      ))
      .returning();

    if (!updated) return sendEntityNotFound(res, 'Exemption');

    ctx.log('COMPLETED', `Exemption ${validation.value.status}`, { id, status: validation.value.status });
    return sendSuccess(res, 200, { exemption: updated });
  }));

  // DELETE /:id — revoke an exemption
  router.delete('/:id', withRoute(async ({ req, res, ctx, orgId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Exemption ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const [deleted] = await db
      .delete(schema.complianceExemption)
      .where(and(
        eq(schema.complianceExemption.id, id),
        eq(schema.complianceExemption.orgId, orgId),
      ))
      .returning();

    if (!deleted) return sendEntityNotFound(res, 'Exemption');

    ctx.log('COMPLETED', 'Deleted exemption', { id });
    return sendSuccess(res, 200, undefined, 'Exemption deleted');
  }));

  return router;
}
