/**
 * @module api/crud-service
 * @description Abstract base class for CRUD operations with access control.
 *
 * Provides generic implementation of common database operations (Create, Read, Update, Delete)
 * with multi-tenant access control, pagination, and sorting.
 */

import { createLogger } from '@mwashburn160/api-core';
import { SQL, eq, and, asc, desc, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db } from '../database/postgres-connection';

const logger = createLogger('CrudService');

/**
 * Base interface for entities with common fields
 */
export interface BaseEntity {
  id: string;
  orgId: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

/**
 * Pagination and sorting options
 */
export interface QueryOptions {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated result with metadata
 */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Abstract CRUD service with access control and common operations.
 *
 * @typeParam TEntity - Entity type extending BaseEntity
 * @typeParam TFilter - Filter type for query parameters
 * @typeParam TInsert - Insert DTO type
 * @typeParam TUpdate - Update DTO type
 *
 * Type assertions (`as any`, `as unknown as T`) are used throughout for Drizzle ORM compatibility.
 * This is safe because: access control filters by orgId, schema validation is at the DB level,
 * and each subclass is tested for type correctness.
 *
 * @example
 * ```typescript
 * class PipelineService extends CrudService<Pipeline, PipelineFilter, PipelineInsert, PipelineUpdate> {
 *   protected get schema() { return schema.pipeline; }
 *   protected buildConditions(filter, orgId) { return buildPipelineConditions(filter, orgId); }
 *   protected getSortColumn(sortBy) { return sortColumnMap[sortBy] ?? null; }
 *   protected getProjectColumn() { return schema.pipeline.project; }
 *   protected getOrgColumn() { return schema.pipeline.organization; }
 * }
 * ```
 */
export abstract class CrudService<
  TEntity extends BaseEntity,
  TFilter,
  TInsert,
  TUpdate,
> {
  /** Drizzle schema table for this entity */
  protected abstract get schema(): PgTable;

  /** Build SQL conditions for filtering entities */
  protected abstract buildConditions(filter: Partial<TFilter>, orgId: string): SQL[];

  /** Get the schema column for sorting by field name */
  protected abstract getSortColumn(sortBy: string): AnyColumn | null;

  /** Get the project column for setDefault scoping (null if entity has no project scope) */
  protected abstract getProjectColumn(): AnyColumn | null;

  /** Get the organization column for setDefault scoping */
  protected abstract getOrgColumn(): AnyColumn;

  /**
   * Find entities matching filter criteria
   */
  async find(filter: Partial<TFilter>, orgId: string): Promise<TEntity[]> {
    try {
      const conditions = this.buildConditions(filter, orgId);

      return await db
        .select()
        .from(this.schema)
        .where(and(...conditions)) as unknown as TEntity[];
    } catch (error) {
      logger.error('Find operation failed', { filter, orgId, error });
      throw error;
    }
  }

  /**
   * Find entities with pagination and sorting
   */
  async findPaginated(
    filter: Partial<TFilter>,
    orgId: string,
    options: QueryOptions = {},
  ): Promise<PaginatedResult<TEntity>> {
    try {
      const { limit: rawLimit = 50, offset = 0, sortBy, sortOrder = 'asc' } = options;
      const limit = Math.min(Math.max(1, rawLimit), 1000);

      const conditions = this.buildConditions(filter, orgId);

      // Get total count
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(this.schema)
        .where(and(...conditions)) as unknown as [{ count: number }];

      const total = countResult?.count || 0;

      // Build query with sorting
      let query = db
        .select()
        .from(this.schema)
        .where(and(...conditions));

      if (sortBy) {
        const sortColumn = this.getSortColumn(sortBy);
        if (sortColumn) {
          query = query.orderBy(sortOrder === 'desc' ? desc(sortColumn) : asc(sortColumn)) as any;
        }
      }

      const results = await query
        .limit(limit)
        .offset(offset) as unknown as TEntity[];

      return {
        data: results,
        total,
        limit,
        offset,
        hasMore: offset + results.length < total,
      };
    } catch (error) {
      logger.error('FindPaginated operation failed', { filter, orgId, options, error });
      throw error;
    }
  }

  /**
   * Count entities matching filter criteria
   */
  async count(filter: Partial<TFilter>, orgId: string): Promise<number> {
    try {
      const conditions = this.buildConditions(filter, orgId);

      const [result] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(this.schema)
        .where(and(...conditions)) as unknown as [{ count: number }];

      return result?.count || 0;
    } catch (error) {
      logger.error('Count operation failed', { filter, orgId, error });
      throw error;
    }
  }

  /**
   * Find a single entity by ID
   */
  async findById(id: string, orgId: string): Promise<TEntity | null> {
    try {
      const conditions = this.buildConditions({ id } as unknown as Partial<TFilter>, orgId);

      const results = await db
        .select()
        .from(this.schema)
        .where(and(...conditions))
        .limit(1) as unknown as TEntity[];

      return results[0] || null;
    } catch (error) {
      logger.error('FindById operation failed', { id, orgId, error });
      throw error;
    }
  }

  /**
   * Create a new entity
   */
  async create(data: TInsert, userId: string): Promise<TEntity> {
    try {
      const [created] = await db
        .insert(this.schema)
        .values({
          ...data,
          createdBy: userId || 'system',
          updatedBy: userId || 'system',
        } as any)
        .returning() as unknown as TEntity[];

      return created;
    } catch (error) {
      logger.error('Create operation failed', { data, userId, error });
      throw error;
    }
  }

  /**
   * Update an existing entity
   */
  async update(
    id: string,
    data: Partial<TUpdate>,
    orgId: string,
    userId: string,
  ): Promise<TEntity | null> {
    try {
      const conditions = this.buildConditions({ id } as unknown as Partial<TFilter>, orgId);

      const [updated] = await db
        .update(this.schema)
        .set({
          ...data,
          updatedAt: new Date(),
          updatedBy: userId || 'system',
        } as any)
        .where(and(...conditions))
        .returning() as unknown as TEntity[];

      return updated || null;
    } catch (error) {
      logger.error('Update operation failed', { id, data, orgId, userId, error });
      throw error;
    }
  }

  /**
   * Delete an entity (soft delete by setting isActive = false)
   */
  async delete(id: string, orgId: string, userId: string): Promise<TEntity | null> {
    try {
      const conditions = this.buildConditions({ id } as unknown as Partial<TFilter>, orgId);

      const [deleted] = await db
        .update(this.schema)
        .set({
          isActive: false,
          updatedAt: new Date(),
          updatedBy: userId || 'system',
        } as any)
        .where(and(...conditions))
        .returning() as unknown as TEntity[];

      return deleted || null;
    } catch (error) {
      logger.error('Delete operation failed', { id, orgId, userId, error });
      throw error;
    }
  }

  /**
   * Set an entity as the default for a project/organization scope.
   * Marks all other entities as non-default, then sets the specified entity.
   * Uses a transaction to ensure atomicity.
   */
  async setDefault(
    project: string,
    org: string,
    id: string,
    userId: string,
  ): Promise<TEntity> {
    try {
      return await db.transaction(async (tx) => {
        const orgColumn = this.getOrgColumn();
        const projectColumn = this.getProjectColumn();

        // Build scoping conditions for clearing defaults
        const scopeConditions = [
          eq(orgColumn, org),
          eq((this.schema as any).isDefault, true),
        ];
        if (projectColumn) {
          scopeConditions.push(eq(projectColumn, project));
        }

        // Mark all entities in scope as non-default
        await tx
          .update(this.schema)
          .set({
            isDefault: false,
            updatedAt: new Date(),
            updatedBy: userId || 'system',
          } as any)
          .where(and(...scopeConditions));

        // Set the specified entity as default
        const [updated] = await tx
          .update(this.schema)
          .set({
            isDefault: true,
            updatedAt: new Date(),
            updatedBy: userId || 'system',
          } as any)
          .where(
            and(
              eq((this.schema as any).id, id),
              eq(orgColumn, org),
            ),
          )
          .returning() as unknown as TEntity[];

        if (!updated) {
          throw new Error(`Entity with id ${id} not found`);
        }

        return updated;
      });
    } catch (error) {
      logger.error('SetDefault operation failed', { project, org, id, userId, error });
      throw error;
    }
  }

  /**
   * Update multiple entities matching filter
   */
  async updateMany(
    filter: Partial<TFilter>,
    data: Partial<TUpdate>,
    orgId: string,
    userId: string,
  ): Promise<TEntity[]> {
    try {
      const conditions = this.buildConditions(filter, orgId);

      return await db
        .update(this.schema)
        .set({
          ...data,
          updatedAt: new Date(),
          updatedBy: userId || 'system',
        } as any)
        .where(and(...conditions))
        .returning() as unknown as TEntity[];
    } catch (error) {
      logger.error('UpdateMany operation failed', { filter, data, orgId, userId, error });
      throw error;
    }
  }
}
