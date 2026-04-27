// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sendSuccess, sendBadRequest, sendError, sendPaginatedNested, ErrorCode, hashAccountInArn, hashId, parsePaginationParams, validateBody } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { db, schema } from '@pipeline-builder/pipeline-core';
import { and, eq, desc, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';

const PipelineRegistrySchema = z.object({
  pipelineId: z.string().min(1, 'pipelineId is required'),
  pipelineArn: z.string().min(1, 'pipelineArn is required'),
  pipelineName: z.string().min(1, 'pipelineName is required'),
  accountId: z.string().optional(),
  region: z.string().optional(),
  project: z.string().optional(),
  organization: z.string().optional(),
  stackName: z.string().optional(),
});

/**
 * Register pipeline registry routes.
 * - POST /pipelines/registry — upsert a pipeline ARN mapping for event reporting.
 * - GET  /pipelines/registry — list registry entries owned by the caller's org.
 *   Used by the dashboard's "deployed pipelines" panel and by drift-detection
 *   tools (the `pipeline-manager audit-stacks` CLI joins this against live
 *   CloudFormation stacks tagged `pipeline-builder` to surface orphans).
 */
export function createRegistryRoutes(): Router {
  const router = Router();

  router.get('/registry', withRoute(async ({ req, res, ctx, orgId }) => {
    const { limit, offset } = parsePaginationParams(req.query as Record<string, unknown>);

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.pipelineRegistry)
      .where(eq(schema.pipelineRegistry.orgId, orgId));

    const rows = await db
      .select()
      .from(schema.pipelineRegistry)
      .where(eq(schema.pipelineRegistry.orgId, orgId))
      .orderBy(desc(schema.pipelineRegistry.lastDeployed))
      .limit(limit)
      .offset(offset);

    const total = countRow?.count ?? 0;
    ctx.log('COMPLETED', 'Listed pipeline registry', { count: rows.length });
    return sendPaginatedNested(res, 'registry', rows, {
      total, limit, offset, hasMore: offset + rows.length < total,
    });
  }));

  router.post('/registry', withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, PipelineRegistrySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error, ErrorCode.VALIDATION_ERROR);
    }

    const { pipelineId, pipelineArn, pipelineName, accountId, region, project, organization, stackName } = validation.value;

    // Ensure account is hashed before storing (defense in depth)
    const safeArn = hashAccountInArn(pipelineArn);
    const safeAccountId = accountId ? hashId(accountId) : undefined;

    // Tenancy guard #1: caller must own the pipelineId they're registering.
    // Without this an org could claim another org's pipelineId by guessing
    // the UUID and pointing it at their own ARN. Inlined query so this route
    // doesn't pull in the cached pipelineService construct.
    const [pipeline] = await db
      .select({ id: schema.pipeline.id })
      .from(schema.pipeline)
      .where(and(
        eq(schema.pipeline.id, pipelineId),
        eq(schema.pipeline.orgId, orgId),
      ));
    if (!pipeline) {
      return sendError(res, 404, 'Pipeline not found in your organization', ErrorCode.NOT_FOUND);
    }

    // Tenancy guard #2: if the ARN is already registered to a DIFFERENT org,
    // refuse the upsert. The unique constraint on pipelineArn would otherwise
    // let an attacker overwrite the existing org binding by replaying the ARN.
    const [existing] = await db
      .select({ orgId: schema.pipelineRegistry.orgId })
      .from(schema.pipelineRegistry)
      .where(eq(schema.pipelineRegistry.pipelineArn, safeArn));
    if (existing && existing.orgId !== orgId) {
      ctx.log('WARN', 'Rejected registry claim for ARN owned by another org', { pipelineArn: safeArn });
      return sendError(res, 409, 'Pipeline ARN is registered to a different organization', ErrorCode.CONFLICT);
    }

    ctx.log('INFO', 'Registering pipeline for event reporting', { pipelineArn: safeArn });

    // Upsert by pipeline_arn (unique constraint).
    // orgId is intentionally NOT in the conflict update set — once an ARN is
    // bound to an org, the binding cannot change without explicit re-registration.
    const [result] = await db
      .insert(schema.pipelineRegistry)
      .values({
        pipelineId,
        orgId,
        pipelineArn: safeArn,
        pipelineName,
        accountId: safeAccountId,
        region,
        project,
        organization,
        stackName,
        lastDeployed: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.pipelineRegistry.pipelineArn,
        set: {
          pipelineId,
          pipelineName,
          accountId: safeAccountId,
          region,
          project,
          organization,
          stackName,
          lastDeployed: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();

    ctx.log('COMPLETED', 'Pipeline registered', { id: result.id, arn: safeArn });

    sendSuccess(res, 200, { registry: result });
  }));

  return router;
}
