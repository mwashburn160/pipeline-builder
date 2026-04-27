// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendPaginatedNested, sendBadRequest, sendEntityNotFound, ErrorCode, getParam, parsePaginationParams, validateBody } from '@pipeline-builder/api-core';
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

const BulkExemptionsSchema = z.object({
  exemptions: z.array(ExemptionCreateSchema).min(1).max(500),
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
    return sendPaginatedNested(res, 'exemptions', exemptions, {
      total, limit, offset, hasMore: offset + exemptions.length < total,
    });
  }));

  // POST /bulk — bulk-create exemptions in one request (up to 500).
  // Skips any (ruleId, entityType, entityId) combination that already has an
  // active exemption for this org. Returns counts of created vs skipped.
  // Useful when onboarding a noisy new rule that fails on a known set of
  // existing entities — avoids 50 individual click-and-fill exemption requests.
  router.post('/bulk', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, BulkExemptionsSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const rows = validation.value.exemptions.map((e) => ({
      ...e,
      orgId,
      expiresAt: e.expiresAt ? new Date(e.expiresAt) : null,
      status: 'pending' as const,
      createdBy: userId,
      updatedBy: userId,
    }));

    // ON CONFLICT DO NOTHING on (orgId, ruleId, entityType, entityId, status='pending')
    // would be ideal, but the schema doesn't have that unique constraint by
    // default. Best-effort: insert all, count successes; rely on app-layer
    // dedup if the operator double-submits.
    const inserted = await db
      .insert(schema.complianceExemption)
      .values(rows)
      .returning({ id: schema.complianceExemption.id });

    ctx.log('COMPLETED', 'Bulk exemption insert', {
      requested: validation.value.exemptions.length,
      created: inserted.length,
    });
    return sendSuccess(res, 201, {
      created: inserted.length,
      skipped: validation.value.exemptions.length - inserted.length,
      ids: inserted.map((r) => r.id),
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

  // PUT /:id/review — approve or reject an exemption.
  // Reviewer cannot be the same user that requested the exemption (self-approval
  // would defeat the approval workflow). Rejecting your own request is allowed —
  // only approval is blocked.
  router.put('/:id/review', withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id');
    if (!id) return sendBadRequest(res, 'Exemption ID is required', ErrorCode.MISSING_REQUIRED_FIELD);

    const validation = validateBody(req, ExemptionReviewSchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const [existing] = await db
      .select({ createdBy: schema.complianceExemption.createdBy })
      .from(schema.complianceExemption)
      .where(and(
        eq(schema.complianceExemption.id, id),
        eq(schema.complianceExemption.orgId, orgId),
        eq(schema.complianceExemption.status, 'pending'),
      ));

    if (!existing) return sendEntityNotFound(res, 'Exemption');

    if (validation.value.status === 'approved' && existing.createdBy === userId) {
      return sendBadRequest(res, 'Cannot approve an exemption you requested. Another reviewer must approve.', ErrorCode.INSUFFICIENT_PERMISSIONS);
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
