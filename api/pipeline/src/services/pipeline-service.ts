// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { entityEvents, createCacheService } from '@pipeline-builder/api-core';
import {
  CoreConstants,
  CrudService,
  buildPipelineConditions,
  getTenantContext,
  schema,
  withTenantTx,
  type PipelineFilter,
} from '@pipeline-builder/pipeline-core';
import { SQL, eq, and, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

/** Server-side cache for pipeline reads. */
const pipelineCache = createCacheService('pipeline:', CoreConstants.CACHE_TTL_ENTITY);

export type Pipeline = typeof schema.pipeline.$inferSelect;
export type PipelineInsert = typeof schema.pipeline.$inferInsert;
export type PipelineUpdate = Partial<Omit<Pipeline, 'id' | 'createdAt' | 'createdBy'>>;

/** Pipeline CRUD service with multi-tenant access control. */
export class PipelineService extends CrudService<
  Pipeline,
  PipelineFilter,
  PipelineInsert,
  PipelineUpdate
> {
  protected get schema(): PgTable {
    return schema.pipeline as PgTable;
  }

  protected buildConditions(filter: Partial<PipelineFilter>, orgId?: string): SQL[] {
    return buildPipelineConditions(filter, orgId);
  }

  protected getSortColumn(sortBy: string): AnyColumn | null {
    const sortableColumns: Record<string, AnyColumn> = {
      id: schema.pipeline.id,
      project: schema.pipeline.project,
      organization: schema.pipeline.organization,
      pipelineName: schema.pipeline.pipelineName,
      createdAt: schema.pipeline.createdAt,
      updatedAt: schema.pipeline.updatedAt,
      isActive: schema.pipeline.isActive,
      isDefault: schema.pipeline.isDefault,
    };

    return sortableColumns[sortBy] || null;
  }

  protected getProjectColumn(): AnyColumn {
    return schema.pipeline.project;
  }

  // setDefault scopes clear-others by this column against the tenant context's
  // orgId (a UUID). It must be the `orgId` tenant column — the `organization`
  // display-name column would never match the UUID, so old defaults wouldn't be
  // cleared (leaving multiple defaults per project/org).
  protected getOrgColumn(): AnyColumn {
    return schema.pipeline.orgId;
  }

  protected get conflictTarget(): AnyColumn[] {
    return [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId];
  }

  // -- Cached reads -----------------------------------------------------------

  /** findById with server-side cache (keyed by orgId:id). */
  async findById(id: string, orgId?: string): Promise<Pipeline | null> {
    // Skip caching for anonymous reads: cached entries from an authed caller
    // could leak across a visibility flip (private → public or vice versa),
    // and the anon path bypasses the orgId scoping the cache key relies on.
    if (!orgId) return super.findById(id, orgId);
    const cacheKey = `${orgId}:id:${id}`;
    return pipelineCache.getOrSet(cacheKey, () => super.findById(id, orgId));
  }

  // -- Lifecycle hooks — emit events + invalidate cache ---------------------

  private async invalidateAndEmit(eventType: 'created' | 'updated' | 'deleted', id: string, entity: Pipeline, userId: string): Promise<void> {
    await pipelineCache.invalidatePattern(`${entity.orgId}:*`);
    // Carry the owning org's parent (when the mutation ran under a team's tenant
    // context) so async compliance eval sees the same parent `propagateToChildren`
    // rules the live path does. Only trust the context parent when its org matches
    // the entity's — a cross-org mutation must not inherit the caller's parent.
    const tenant = getTenantContext();
    const parentOrgId = tenant?.orgId === entity.orgId ? tenant?.parentOrgId : undefined;
    entityEvents.emit({ eventType, target: 'pipeline', entityId: id, orgId: entity.orgId, parentOrgId, userId, timestamp: new Date(), attributes: entity });
  }

  protected async onAfterCreate(entity: Pipeline, userId: string): Promise<void> {
    await this.invalidateAndEmit('created', entity.id, entity, userId);
  }

  protected async onAfterUpdate(id: string, entity: Pipeline, userId: string): Promise<void> {
    await this.invalidateAndEmit('updated', id, entity, userId);
  }

  protected async onAfterDelete(id: string, entity: Pipeline, userId: string): Promise<void> {
    await this.invalidateAndEmit('deleted', id, entity, userId);
  }

  /** Atomically create a pipeline as the default for a project (clears existing defaults). */
  async createAsDefault(
    data: PipelineInsert,
    userId: string,
    project: string,
    organization: string,
  ): Promise<Pipeline> {
    // orgId is structurally optional on PipelineInsert but is required here —
    // the FOR UPDATE lock + clear-other-defaults UPDATE both predicate on it
    // (C23 fix). Refuse early instead of silently treating undefined as a
    // wildcard, which would risk clearing defaults across orgs.
    if (!data.orgId) {
      throw new Error('createAsDefault requires data.orgId');
    }
    const orgId = data.orgId;
    return withTenantTx(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM ${schema.pipeline}
            WHERE ${schema.pipeline.project} = ${project}
              AND ${schema.pipeline.organization} = ${organization}
              AND ${schema.pipeline.orgId} = ${orgId}
              AND ${schema.pipeline.isDefault} = true
            FOR UPDATE`,
      );

      await tx
        .update(schema.pipeline)
        .set({
          isDefault: false,
          updatedAt: new Date(),
          updatedBy: userId,
        })
        .where(
          and(
            eq(schema.pipeline.project, project),
            eq(schema.pipeline.organization, organization),
            eq(schema.pipeline.orgId, orgId),
            eq(schema.pipeline.isDefault, true),
          ),
        );

      const [result] = await tx
        .insert(schema.pipeline)
        .values({ ...data, isDefault: true, isActive: true })
        .onConflictDoUpdate({
          target: [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId],
          set: {
            ...data,
            isDefault: true,
            isActive: true,
            deletedAt: null,
            deletedBy: null,
            updatedAt: new Date(),
            updatedBy: userId,
          } as any,
        })
        .returning();

      const pipeline = result as unknown as Pipeline;
      await pipelineCache.invalidatePattern(`${data.orgId}:*`);
      return pipeline;
    });
  }

  /**
   * Like {@link createAsDefault}, but also reports whether the row was inserted
   * (new) or updated (existing). Uses Postgres's `xmax = 0` returning trick:
   * `xmax` is 0 on fresh inserts and non-zero on rows touched by the
   * onConflictDoUpdate path. Used by bulk-create to split the response into
   * `created` vs `updated` counts.
   */
  async createAsDefaultReportInserted(
    data: PipelineInsert,
    userId: string,
    project: string,
    organization: string,
  ): Promise<{ pipeline: Pipeline; inserted: boolean }> {
    // Same orgId requirement as createAsDefault — see that function for rationale.
    if (!data.orgId) {
      throw new Error('createAsDefaultReportInserted requires data.orgId');
    }
    const orgId = data.orgId;
    return withTenantTx(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM ${schema.pipeline}
            WHERE ${schema.pipeline.project} = ${project}
              AND ${schema.pipeline.organization} = ${organization}
              AND ${schema.pipeline.orgId} = ${orgId}
              AND ${schema.pipeline.isDefault} = true
            FOR UPDATE`,
      );

      await tx
        .update(schema.pipeline)
        .set({ isDefault: false, updatedAt: new Date(), updatedBy: userId })
        .where(
          and(
            eq(schema.pipeline.project, project),
            eq(schema.pipeline.organization, organization),
            eq(schema.pipeline.orgId, orgId),
            eq(schema.pipeline.isDefault, true),
          ),
        );

      // Build the upsert via Drizzle for typesafe param binding, then ask for
      // every column plus `(xmax = 0)::int AS inserted` in the RETURNING
      // clause. xmax is 0 only on rows produced by the INSERT branch, so it
      // cleanly distinguishes a fresh create from an ON CONFLICT update.
      const returningCols: Record<string, unknown> = {};
      for (const [key, col] of Object.entries(schema.pipeline)) {
        returningCols[key] = col;
      }
      returningCols.inserted = sql<number>`(xmax = 0)::int`;

      const [upserted] = await tx
        .insert(schema.pipeline)
        .values({ ...data, isDefault: true, isActive: true })
        .onConflictDoUpdate({
          target: [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId],
          set: {
            ...data,
            isDefault: true,
            isActive: true,
            deletedAt: null,
            deletedBy: null,
            updatedAt: new Date(),
            updatedBy: userId,
          } as any,
        })
        .returning(returningCols as any);

      const { inserted: insertedFlag, ...rest } = upserted as Record<string, unknown> & { inserted: number };
      const pipeline = rest as unknown as Pipeline;
      const inserted = insertedFlag === 1;

      await pipelineCache.invalidatePattern(`${data.orgId}:*`);
      return { pipeline, inserted };
    });
  }
}

export const pipelineService = new PipelineService();
