import { NotFoundError, createLogger } from '@mwashburn160/api-core';
import { SQL, eq, and, asc, desc, sql, inArray } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db } from '../database/postgres-connection';

/** Pagination defaults — read from env to match CoreConstants in pipeline-core. */
const DEFAULT_PAGE_LIMIT = parseInt(process.env.DEFAULT_PAGE_LIMIT || '100', 10);
const MAX_PAGE_LIMIT = parseInt(process.env.MAX_PAGE_LIMIT || '1000', 10);

/**
 * Cast Drizzle query results to a typed array.
 * Drizzle's generic return type (`PgSelectBase<...>`) doesn't narrow to our
 * entity generics, so an explicit cast is needed. Centralised here so every
 * call-site stays one-liner clean and the cast is documented in one place.
 */
export function drizzleRows<T>(rows: unknown): T[] {
  return rows as T[];
}

/** Cast a Drizzle aggregate result to extract `[{ count: number }]`. */
export function drizzleCount(rows: unknown): [{ count: number }] {
  return rows as [{ count: number }];
}

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
  [key: string]: unknown;
}

/**
 * Pagination and sorting options
 */
export interface QueryOptions {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /** When true, runs a separate COUNT(*) query to include exact total. Default: false. */
  includeTotal?: boolean;
  /** Cursor-based pagination: fetch rows after this cursor value (uses sortBy column). */
  cursor?: string;
  /** Sparse fieldset: column names to select. Returns all columns when omitted. */
  fields?: string[];
}

/**
 * Paginated result with metadata
 */
export interface PaginatedResult<T> {
  data: T[];
  /** Total count of matching entities. Only present when includeTotal is true. */
  total?: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Cursor pointing to the last item, for cursor-based pagination. */
  nextCursor?: string;
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
 * Errors are not caught here — they propagate to the route-level error handler (`withRoute`)
 * which provides consistent logging with request context.
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
  protected abstract buildConditions(filter: Partial<TFilter>, orgId?: string): SQL[];

  /** Get the schema column for sorting by field name */
  protected abstract getSortColumn(sortBy: string): AnyColumn | null;

  /** Get the project column for setDefault scoping (null if entity has no project scope) */
  protected abstract getProjectColumn(): AnyColumn | null;

  /** Get the organization column for setDefault scoping */
  protected abstract getOrgColumn(): AnyColumn;

  /** Get the unique constraint columns for onConflictDoUpdate */
  protected abstract get conflictTarget(): AnyColumn[];

  private readonly _logger = createLogger('CrudService');

  /** Build conditions for a single entity by ID. */
  private idConditions(id: string, orgId?: string): SQL[] {
    return this.buildConditions({ id } as unknown as Partial<TFilter>, orgId);
  }

  // Lifecycle hooks — override in subclasses to react to mutations
  // These are fire-and-forget: errors are logged but never block the caller.

  /** Called after a new entity is created */
  protected async onAfterCreate(_entity: TEntity, _userId: string): Promise<void> {}

  /** Called after an entity is updated */
  protected async onAfterUpdate(_id: string, _entity: TEntity, _userId: string): Promise<void> {}

  /** Called after an entity is soft-deleted */
  protected async onAfterDelete(_id: string, _entity: TEntity, _userId: string): Promise<void> {}

  /**
   * Find entities matching filter criteria
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID (optional — omit for anonymous/system-public-only access)
   */
  async find(filter: Partial<TFilter>, orgId?: string): Promise<TEntity[]> {
    const conditions = this.buildConditions(filter, orgId);

    return db
      .select()
      .from(this.schema)
      .where(and(...conditions)).then(r => drizzleRows<TEntity>(r));
  }

  /**
   * Find entities with pagination and sorting
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID (optional — omit for anonymous/system-public-only access)
   * @param options - Pagination and sorting options
   */
  async findPaginated(
    filter: Partial<TFilter>,
    orgId?: string,
    options: QueryOptions = {},
  ): Promise<PaginatedResult<TEntity>> {
    const { limit: rawLimit = DEFAULT_PAGE_LIMIT, offset = 0, sortBy, sortOrder = 'asc', includeTotal = false, cursor, fields } = options;
    const limit = Math.min(Math.max(1, rawLimit), MAX_PAGE_LIMIT);

    // Cursor and offset are mutually exclusive — cursor takes precedence
    const useCursor = !!(cursor && sortBy);

    const conditions = this.buildConditions(filter, orgId);

    // Cursor-based pagination: add WHERE clause for keyset pagination
    if (useCursor) {
      const sortColumn = this.getSortColumn(sortBy);
      if (sortColumn) {
        const op = sortOrder === 'desc'
          ? sql`${sortColumn} < ${cursor}`
          : sql`${sortColumn} > ${cursor}`;
        conditions.push(op);
      }
    }

    // Build SELECT — sparse fieldset when fields are specified
    const selectSpec = fields ? this.buildFieldSelect(fields) : undefined;
    let query = selectSpec
      ? db.select(selectSpec as any).from(this.schema).where(and(...conditions))
      : db.select().from(this.schema).where(and(...conditions));

    if (sortBy) {
      const sortColumn = this.getSortColumn(sortBy);
      if (sortColumn) {
        query = query.orderBy(sortOrder === 'desc' ? desc(sortColumn) : asc(sortColumn)) as any;
      }
    }

    // Fetch limit+1 to detect hasMore without COUNT(*)
    const effectiveOffset = useCursor ? 0 : offset;
    const rows = await query
      .limit(limit + 1)
      .offset(effectiveOffset).then(r => drizzleRows<TEntity>(r));

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    const result: PaginatedResult<TEntity> = { data, limit, offset: effectiveOffset, hasMore };

    // Provide next cursor from last item's sort column value
    if (data.length > 0 && sortBy) {
      const lastItem = data[data.length - 1] as Record<string, unknown>;
      const cursorValue = lastItem[sortBy];
      if (cursorValue !== undefined) {
        result.nextCursor = cursorValue instanceof Date ? cursorValue.toISOString() : String(cursorValue);
      }
    }

    // Only run the COUNT(*) query when the caller explicitly needs the total
    if (includeTotal) {
      const baseConditions = this.buildConditions(filter, orgId);
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(this.schema)
        .where(and(...baseConditions)).then(r => drizzleCount(r));
      result.total = countResult?.count || 0;
    }

    return result;
  }

  /**
   * Build a column selection map for sparse fieldsets.
   * Falls back to full select if no matching columns found.
   */
  private buildFieldSelect(fields: string[]): Record<string, unknown> | undefined {
    if (fields.length === 0) return undefined;

    const columns: Record<string, unknown> = {};
    // Always include id for entity identity
    columns.id = (this.schema as any).id;

    for (const field of fields) {
      if (field === 'id') continue; // Already included
      const col = (this.schema as any)[field];
      if (col) columns[field] = col;
    }

    // At minimum we'll have { id }, which is valid
    return columns;
  }

  /**
   * Count entities matching filter criteria
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID (optional — omit for anonymous/system-public-only access)
   */
  async count(filter: Partial<TFilter>, orgId?: string): Promise<number> {
    const conditions = this.buildConditions(filter, orgId);

    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(this.schema)
      .where(and(...conditions)).then(r => drizzleCount(r));

    return result?.count || 0;
  }

  /**
   * Find a single entity by ID
   *
   * @param id - Entity ID
   * @param orgId - User's organization ID (optional — omit for anonymous/system-public-only access)
   */
  async findById(id: string, orgId?: string): Promise<TEntity | null> {
    const conditions = this.idConditions(id, orgId);

    const results = await db
      .select()
      .from(this.schema)
      .where(and(...conditions))
      .limit(1).then(r => drizzleRows<TEntity>(r));

    return results[0] || null;
  }

  // Mutation operations

  /**
   * Create a new entity
   */
  async create(data: TInsert, userId: string): Promise<TEntity> {
    const [created] = await db
      .insert(this.schema)
      .values({
        ...data,
        createdBy: userId || 'system',
        updatedBy: userId || 'system',
      } as any)
      .onConflictDoUpdate({
        target: this.conflictTarget as any,
        set: {
          ...data,
          updatedAt: new Date(),
          updatedBy: userId || 'system',
        } as any,
      })
      .returning().then(r => drizzleRows<TEntity>(r));

    this.onAfterCreate(created, userId).catch(err => this._logger.warn('Lifecycle hook failed', { error: String(err) }));

    return created;
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
    const conditions = this.idConditions(id, orgId);

    const [updated] = await db
      .update(this.schema)
      .set({
        ...data,
        updatedAt: new Date(),
        updatedBy: userId || 'system',
      } as any)
      .where(and(...conditions))
      .returning().then(r => drizzleRows<TEntity>(r));

    if (updated) {
      this.onAfterUpdate(id, updated, userId).catch(err => this._logger.warn('Lifecycle hook failed', { error: String(err) }));
    }

    return updated || null;
  }

  /**
   * Delete an entity (soft delete by setting isActive = false)
   */
  async delete(id: string, orgId: string, userId: string): Promise<TEntity | null> {
    const conditions = this.idConditions(id, orgId);

    const [deleted] = await db
      .update(this.schema)
      .set({
        isActive: false,
        updatedAt: new Date(),
        updatedBy: userId || 'system',
        deletedAt: new Date(),
        deletedBy: userId || 'system',
      } as any)
      .where(and(...conditions))
      .returning().then(r => drizzleRows<TEntity>(r));

    if (deleted) {
      this.onAfterDelete(id, deleted, userId).catch(err => this._logger.warn('Lifecycle hook failed', { error: String(err) }));
    }

    return deleted || null;
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
    return db.transaction(async (tx) => {
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

      // Lock existing defaults with FOR UPDATE to prevent concurrent setDefault races
      await tx.execute(
        sql`SELECT id FROM ${this.schema}
            WHERE ${orgColumn} = ${org}
              AND ${(this.schema as any).isDefault} = true
            ${projectColumn ? sql`AND ${projectColumn} = ${project}` : sql``}
            FOR UPDATE`,
      );

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
        .returning().then(r => drizzleRows<TEntity>(r));

      if (!updated) {
        throw new NotFoundError(`Entity with id ${id} not found`);
      }

      return updated;
    });
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
    const conditions = this.buildConditions(filter, orgId);

    return db
      .update(this.schema)
      .set({
        ...data,
        updatedAt: new Date(),
        updatedBy: userId || 'system',
      } as any)
      .where(and(...conditions))
      .returning().then(r => drizzleRows<TEntity>(r));
  }

  /**
   * Create multiple entities in a single batch insert.
   * Uses upsert (onConflictDoUpdate) — all rows are inserted in one query per chunk.
   * Chunks of 100 to stay within PostgreSQL parameter limits.
   */
  async bulkCreate(items: TInsert[], userId: string): Promise<TEntity[]> {
    if (items.length === 0) return [];

    const CHUNK_SIZE = 100;
    const now = new Date();
    const user = userId || 'system';

    const results = await db.transaction(async (tx) => {
      const allCreated: TEntity[] = [];

      for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        const chunk = items.slice(i, i + CHUNK_SIZE);
        const values = chunk.map(data => ({
          ...data,
          createdBy: user,
          updatedBy: user,
        } as any));

        const created = await tx
          .insert(this.schema)
          .values(values)
          .onConflictDoUpdate({
            target: this.conflictTarget as any,
            set: {
              updatedAt: now,
              updatedBy: user,
            } as any,
          })
          .returning().then(r => drizzleRows<TEntity>(r));

        allCreated.push(...created);
      }

      return allCreated;
    });

    for (const entity of results) {
      this.onAfterCreate(entity, userId).catch(err => this._logger.warn('Lifecycle hook failed', { error: String(err) }));
    }

    return results;
  }

  /**
   * Soft-delete multiple entities by IDs in a single batch operation.
   */
  async bulkDelete(
    ids: string[],
    orgId: string,
    userId: string,
  ): Promise<TEntity[]> {
    if (ids.length === 0) return [];

    const now = new Date();
    const user = userId || 'system';
    const conditions = [
      inArray((this.schema as any).id, ids),
      ...this.buildConditions({} as Partial<TFilter>, orgId),
    ];

    const deleted = await db
      .update(this.schema)
      .set({
        isActive: false,
        updatedAt: now,
        updatedBy: user,
        deletedAt: now,
        deletedBy: user,
      } as any)
      .where(and(...conditions))
      .returning().then(r => drizzleRows<TEntity>(r));

    for (const entity of deleted) {
      this.onAfterDelete(entity.id, entity, userId).catch(err => this._logger.warn('Lifecycle hook failed', { error: String(err) }));
    }

    return deleted;
  }
}
