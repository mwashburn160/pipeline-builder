import { entityEvents, createCacheService } from '@mwashburn160/api-core';
import {
  CoreConstants,
  CrudService,
  buildPipelineConditions,
  schema,
  db,
  type PipelineFilter,
} from '@mwashburn160/pipeline-core';

/** Server-side cache for pipeline reads. */
const pipelineCache = createCacheService('pipeline:', CoreConstants.CACHE_TTL_ENTITY);
import { SQL, eq, and, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';

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

  protected getOrgColumn(): AnyColumn {
    return schema.pipeline.organization;
  }

  protected get conflictTarget(): AnyColumn[] {
    return [schema.pipeline.project, schema.pipeline.organization, schema.pipeline.orgId];
  }

  // -- Cached reads -----------------------------------------------------------

  /** findById with server-side cache (keyed by orgId:id). */
  async findById(id: string, orgId?: string): Promise<Pipeline | null> {
    const cacheKey = `${orgId || 'anon'}:id:${id}`;
    return pipelineCache.getOrSet(cacheKey, () => super.findById(id, orgId));
  }

  // -- Lifecycle hooks — emit events + invalidate cache ---------------------

  protected async onAfterCreate(entity: Pipeline): Promise<void> {
    pipelineCache.invalidatePattern(`${entity.orgId}:*`).catch(() => {});
    entityEvents.emit({
      eventType: 'created',
      target: 'pipeline',
      entityId: entity.id,
      orgId: entity.orgId,
      userId: entity.createdBy,
      timestamp: new Date(),
      attributes: entity as unknown as Record<string, unknown>,
    });
  }

  protected async onAfterUpdate(id: string, entity: Pipeline): Promise<void> {
    pipelineCache.invalidatePattern(`${entity.orgId}:*`).catch(() => {});
    entityEvents.emit({
      eventType: 'updated',
      target: 'pipeline',
      entityId: id,
      orgId: entity.orgId,
      userId: entity.updatedBy,
      timestamp: new Date(),
      attributes: entity as unknown as Record<string, unknown>,
    });
  }

  protected async onAfterDelete(id: string, entity: Pipeline): Promise<void> {
    pipelineCache.invalidatePattern(`${entity.orgId}:*`).catch(() => {});
    entityEvents.emit({
      eventType: 'deleted',
      target: 'pipeline',
      entityId: id,
      orgId: entity.orgId,
      userId: entity.updatedBy,
      timestamp: new Date(),
      attributes: entity as unknown as Record<string, unknown>,
    });
  }

  /** Atomically create a pipeline as the default for a project (clears existing defaults). */
  async createAsDefault(
    data: PipelineInsert,
    userId: string,
    project: string,
    organization: string,
  ): Promise<Pipeline> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM ${schema.pipeline}
            WHERE ${schema.pipeline.project} = ${project}
              AND ${schema.pipeline.organization} = ${organization}
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
      pipelineCache.invalidatePattern(`${data.orgId}:*`).catch(() => {});
      return pipeline;
    });
  }
}

export const pipelineService = new PipelineService();
