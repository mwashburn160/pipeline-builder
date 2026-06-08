// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { schema, withTenantTx } from '@pipeline-builder/pipeline-core';
import { and, desc, eq, sql } from 'drizzle-orm';

export const PR_PIPELINE_NOT_OWNED = 'PR_PIPELINE_NOT_OWNED';
export const PR_REGISTRY_OWNED_BY_OTHER_ORG = 'PR_REGISTRY_OWNED_BY_OTHER_ORG';

export interface RegistryUpsertInput {
  pipelineId: string;
  orgId: string;
  pipelineName: string;
  region?: string;
  project?: string;
  organization?: string;
  stackName?: string;
}

class PipelineRegistryService {
  /** Paginated list of registry rows for an org. */
  async list(orgId: string, limit: number, offset: number) {
    return withTenantTx(async (tx) => {
      const countQuery = tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.pipelineRegistry)
        .where(eq(schema.pipelineRegistry.orgId, orgId));

      const rowsQuery = tx
        .select()
        .from(schema.pipelineRegistry)
        .where(eq(schema.pipelineRegistry.orgId, orgId))
        .orderBy(desc(schema.pipelineRegistry.lastDeployed))
        .limit(limit)
        .offset(offset);

      const [countResult, rows] = await Promise.all([countQuery, rowsQuery]);
      return { rows, total: countResult[0]?.count ?? 0 };
    });
  }

  /**
   * Upsert a registry row by pipelineId (the stable key the events Lambda
   * resolves from the `PIPELINE_EVENT_ID` tag). Enforces two tenancy guards:
   *   1. The caller's org must own `pipelineId` (prevents claiming other orgs'
   *      pipeline IDs).
   *   2. Any existing registry row for `pipelineId` must belong to the caller's
   *      org (defense in depth against a re-bind under a withdrawn pipeline).
   * Throws PR_PIPELINE_NOT_OWNED or PR_REGISTRY_OWNED_BY_OTHER_ORG.
   */
  async upsert(input: RegistryUpsertInput) {
    const { pipelineId, orgId, pipelineName, region, project, organization, stackName } = input;

    // All operations run in one tx so an attacker can't race the gate checks
    // against the insert under a withdrawn pipeline binding.
    return withTenantTx(async (tx) => {
      const [pipeline] = await tx
        .select({ id: schema.pipeline.id })
        .from(schema.pipeline)
        .where(and(
          eq(schema.pipeline.id, pipelineId),
          eq(schema.pipeline.orgId, orgId),
        ));
      if (!pipeline) throw new Error(PR_PIPELINE_NOT_OWNED);

      const [existing] = await tx
        .select({ orgId: schema.pipelineRegistry.orgId })
        .from(schema.pipelineRegistry)
        .where(eq(schema.pipelineRegistry.pipelineId, pipelineId));
      if (existing && existing.orgId !== orgId) throw new Error(PR_REGISTRY_OWNED_BY_OTHER_ORG);

      const now = new Date();
      const [result] = await tx
        .insert(schema.pipelineRegistry)
        .values({
          pipelineId,
          orgId,
          pipelineName,
          region,
          project,
          organization,
          stackName,
          lastDeployed: now,
        })
        .onConflictDoUpdate({
          target: schema.pipelineRegistry.pipelineId,
          set: {
            pipelineName,
            region,
            project,
            organization,
            stackName,
            lastDeployed: now,
            updatedAt: now,
          },
        })
        .returning();
      return result;
    });
  }

  /** Hard-delete a registry row scoped to the caller's org. Returns the deleted row or null. */
  async delete(id: string, orgId: string) {
    const [deleted] = await withTenantTx(async (tx) => tx
      .delete(schema.pipelineRegistry)
      .where(and(
        eq(schema.pipelineRegistry.id, id),
        eq(schema.pipelineRegistry.orgId, orgId),
      ))
      .returning({
        id: schema.pipelineRegistry.id,
        pipelineId: schema.pipelineRegistry.pipelineId,
      }));
    return deleted ?? null;
  }
}

export const pipelineRegistryService = new PipelineRegistryService();
