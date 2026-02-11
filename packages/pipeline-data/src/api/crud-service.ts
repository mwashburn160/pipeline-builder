/**
 * @module api/crud-service
 * @description Abstract base class for CRUD operations with access control.
 *
 * Provides generic implementation of common database operations (Create, Read, Update, Delete)
 * with multi-tenant access control, pagination, sorting, and caching.
 */

import { createLogger } from '@mwashburn160/api-core';
import { SQL, eq, and, asc, desc, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db } from '../database/postgres-connection';

const log = createLogger('CrudService');

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
 * Simple in-memory cache entry
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Cache options
 */
export interface CacheOptions {
  enabled: boolean;
  ttl: number; // Time to live in milliseconds
}

/**
 * Abstract CRUD service with access control and common operations.
 *
 * Features:
 * - Multi-tenant access control
 * - Generic find/findById/create/update/delete operations
 * - Default entity management (setDefault)
 * - Transaction support
 * - Extensible filter and condition building
 *
 * @typeParam TEntity - Entity type extending BaseEntity
 * @typeParam TFilter - Filter type for query parameters
 * @typeParam TInsert - Insert DTO type
 * @typeParam TUpdate - Update DTO type
 *
 * ## Type Safety Notes
 *
 * This class uses type assertions (`as any`, `as unknown as T`) throughout for Drizzle ORM compatibility.
 * These assertions are necessary because:
 *
 * 1. **Query Result Types**: Drizzle's query builder returns generic `PgSelectBase` types that don't
 *    directly match our entity types. We use `as unknown as TEntity[]` to safely bridge this gap.
 *    Example: `.where(and(...conditions)) as unknown as TEntity[]`
 *
 * 2. **Dynamic Schema Field Access**: When accessing schema fields dynamically (e.g., `schema[fieldName]`),
 *    TypeScript cannot infer the correct type, requiring `(this.schema as any)[field]`.
 *    This occurs in `setDefault()` which needs to access project/org fields by name.
 *
 * 3. **Insert/Update Value Spreading**: Drizzle expects exact schema types for `.values()` and `.set()`,
 *    but we add `createdBy`/`updatedBy` fields dynamically. TypeScript cannot verify this is safe,
 *    so we use `as any` to allow the spread operation.
 *    Example: `.values({ ...data, createdBy, updatedBy } as any)`
 *
 * 4. **Query Builder Chainability**: Some Drizzle query builder methods (like `.orderBy()`) return
 *    complex union types that lose type information when chained. We use `as any` to maintain
 *    chainability without TypeScript errors.
 *    Example: `query.orderBy(sortColumn) as any`
 *
 * 5. **Generic Type Constraints**: The generic type parameters (TEntity, TFilter, TInsert, TUpdate)
 *    are runtime-determined by subclasses, but Drizzle's type system is compile-time only. The
 *    type assertions bridge this gap safely since:
 *    - Subclasses provide correct schema types via `protected get schema()`
 *    - Access control ensures queries only return valid entities for the orgId
 *    - Database constraints enforce data integrity
 *
 * **Why This Is Safe:**
 * - All database operations are protected by access control (orgId filtering)
 * - Schema validation happens at the database level via Drizzle migrations
 * - Type assertions only relax TypeScript's compile-time checks, not runtime safety
 * - Each subclass implementation is tested to ensure type correctness
 *
 * **Alternative Approaches Considered:**
 * - Explicit type parameters for every Drizzle method: Too verbose, reduced readability
 * - Separate type-safe wrappers for each operation: Duplicated code, increased maintenance
 * - Current approach (type assertions): Best balance of type safety and maintainability
 *
 * @example
 * ```typescript
 * class PipelineService extends CrudService<Pipeline, PipelineFilter, PipelineInsert, PipelineUpdate> {
 *   protected get schema() { return schema.pipeline; }
 *
 *   protected buildConditions(filter: Partial<PipelineFilter>, orgId: string): SQL[] {
 *     return buildPipelineConditions(filter, orgId);
 *   }
 * }
 * ```
 */
export abstract class CrudService<
  TEntity extends BaseEntity,
  TFilter,
  TInsert,
  TUpdate,
> {
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private cacheOptions: CacheOptions = { enabled: false, ttl: 60000 }; // 1 minute default

  /**
   * Drizzle schema table for this entity
   * Must be implemented by subclass
   */
  protected abstract get schema(): PgTable;

  /**
   * Build SQL conditions for filtering entities
   * Must be implemented by subclass using entity-specific filter logic
   *
   * @param filter - Filter criteria from query parameters
   * @param orgId - User's organization ID for access control
   * @returns Array of SQL conditions
   */
  protected abstract buildConditions(filter: Partial<TFilter>, orgId: string): SQL[];

  /**
   * Get the schema column for sorting
   * Must be implemented by subclass to map sort field names to schema columns
   *
   * @param sortBy - Sort field name
   * @returns Schema column or null if not sortable
   */
  protected abstract getSortColumn(sortBy: string): any | null;

  /**
   * Enable caching for this service
   *
   * @param ttl - Time to live in milliseconds (default: 60000)
   */
  enableCache(ttl: number = 60000): void {
    this.cacheOptions = { enabled: true, ttl };
  }

  /**
   * Disable caching for this service
   */
  disableCache(): void {
    this.cacheOptions.enabled = false;
    this.cache.clear();
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get data from cache
   */
  private getFromCache<T>(key: string): T | null {
    if (!this.cacheOptions.enabled) return null;

    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.cacheOptions.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Store data in cache
   */
  private setInCache<T>(key: string, data: T): void {
    if (!this.cacheOptions.enabled) return;

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Generate cache key from filter and orgId
   */
  private getCacheKey(prefix: string, filter: Partial<TFilter>, orgId: string, options?: QueryOptions): string {
    return `${prefix}:${orgId}:${JSON.stringify(filter)}:${JSON.stringify(options || {})}`;
  }

  /**
   * Find entities matching filter criteria
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID
   * @returns Promise resolving to array of matching entities
   */
  async find(filter: Partial<TFilter>, orgId: string): Promise<TEntity[]> {
    try {
      const cacheKey = this.getCacheKey('find', filter, orgId);
      const cached = this.getFromCache<TEntity[]>(cacheKey);
      if (cached) {
        log.debug('Cache hit for find', { filter, orgId });
        return cached;
      }

      const conditions = this.buildConditions(filter, orgId);

      const results = await db
        .select()
        .from(this.schema)
        .where(and(...conditions)) as unknown as TEntity[];

      this.setInCache(cacheKey, results);
      return results;
    } catch (error) {
      log.error('Find operation failed', { filter, orgId, error });
      throw error;
    }
  }

  /**
   * Find entities with pagination and sorting
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID
   * @param options - Pagination and sorting options
   * @returns Promise resolving to paginated result
   */
  async findPaginated(
    filter: Partial<TFilter>,
    orgId: string,
    options: QueryOptions = {},
  ): Promise<PaginatedResult<TEntity>> {
    try {
      const { limit = 50, offset = 0, sortBy, sortOrder = 'asc' } = options;

      const cacheKey = this.getCacheKey('findPaginated', filter, orgId, options);
      const cached = this.getFromCache<PaginatedResult<TEntity>>(cacheKey);
      if (cached) {
        log.debug('Cache hit for findPaginated', { filter, orgId, options });
        return cached;
      }

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

      // Apply sorting if specified
      if (sortBy) {
        const sortColumn = this.getSortColumn(sortBy);
        if (sortColumn) {
          query = query.orderBy(sortOrder === 'desc' ? desc(sortColumn) : asc(sortColumn)) as any;
        }
      }

      // Apply pagination
      const results = await query
        .limit(limit)
        .offset(offset) as unknown as TEntity[];

      const result: PaginatedResult<TEntity> = {
        data: results,
        total,
        limit,
        offset,
        hasMore: offset + results.length < total,
      };

      this.setInCache(cacheKey, result);
      return result;
    } catch (error) {
      log.error('FindPaginated operation failed', { filter, orgId, options, error });
      throw error;
    }
  }

  /**
   * Count entities matching filter criteria
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID
   * @returns Promise resolving to count
   */
  async count(filter: Partial<TFilter>, orgId: string): Promise<number> {
    try {
      const cacheKey = this.getCacheKey('count', filter, orgId);
      const cached = this.getFromCache<number>(cacheKey);
      if (cached !== null) {
        log.debug('Cache hit for count', { filter, orgId });
        return cached;
      }

      const conditions = this.buildConditions(filter, orgId);

      const [result] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(this.schema)
        .where(and(...conditions)) as unknown as [{ count: number }];

      const count = result?.count || 0;
      this.setInCache(cacheKey, count);
      return count;
    } catch (error) {
      log.error('Count operation failed', { filter, orgId, error });
      throw error;
    }
  }

  /**
   * Find a single entity by ID
   *
   * @param id - Entity ID
   * @param orgId - User's organization ID
   * @returns Promise resolving to entity or null if not found
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
      log.error('FindById operation failed', { id, orgId, error });
      throw error;
    }
  }

  /**
   * Create a new entity
   *
   * @param data - Entity data to insert
   * @param userId - User ID creating the entity
   * @returns Promise resolving to created entity
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

      // Clear cache on mutation
      this.clearCache();

      return created;
    } catch (error) {
      log.error('Create operation failed', { data, userId, error });
      throw error;
    }
  }

  /**
   * Update an existing entity
   *
   * @param id - Entity ID to update
   * @param data - Partial entity data to update
   * @param orgId - User's organization ID
   * @param userId - User ID performing the update
   * @returns Promise resolving to updated entity or null if not found
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

      // Clear cache on mutation
      if (updated) {
        this.clearCache();
      }

      return updated || null;
    } catch (error) {
      log.error('Update operation failed', { id, data, orgId, userId, error });
      throw error;
    }
  }

  /**
   * Delete an entity (soft delete by setting isActive = false)
   *
   * @param id - Entity ID to delete
   * @param orgId - User's organization ID
   * @param userId - User ID performing the deletion
   * @returns Promise resolving to deleted entity or null if not found
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

      // Clear cache on mutation
      if (deleted) {
        this.clearCache();
      }

      return deleted || null;
    } catch (error) {
      log.error('Delete operation failed', { id, orgId, userId, error });
      throw error;
    }
  }

  /**
   * Set an entity as the default for a project/organization
   *
   * Marks all other entities as non-default, then sets the specified entity as default.
   * Uses a transaction to ensure atomicity.
   *
   * @param projectField - Name of the project field in the schema
   * @param orgField - Name of the organization field in the schema
   * @param project - Project identifier
   * @param org - Organization identifier
   * @param id - Entity ID to set as default
   * @param userId - User ID performing the operation
   * @returns Promise resolving to updated entity
   */
  async setDefault(
    projectField: string,
    orgField: string,
    project: string,
    org: string,
    id: string,
    userId: string,
  ): Promise<TEntity> {
    try {
      return await db.transaction(async (tx) => {
        // Mark all entities for this project/org as non-default
        await tx
          .update(this.schema)
          .set({
            isDefault: false,
            updatedAt: new Date(),
            updatedBy: userId || 'system',
          } as any)
          .where(
            and(
              eq((this.schema as any)[projectField], project),
              eq((this.schema as any)[orgField], org),
              eq((this.schema as any).isDefault, true),
            ),
          );

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
              eq((this.schema as any)[orgField], org),
            ),
          )
          .returning() as unknown as TEntity[];

        if (!updated) {
          throw new Error(`Entity with id ${id} not found`);
        }

        // Clear cache on mutation
        this.clearCache();

        return updated;
      });
    } catch (error) {
      log.error('SetDefault operation failed', { project, org, id, userId, error });
      throw error;
    }
  }

  /**
   * Create multiple entities in a single transaction
   *
   * @param dataArray - Array of entity data to insert
   * @param userId - User ID creating the entities
   * @returns Promise resolving to array of created entities
   */
  async createMany(dataArray: TInsert[], userId: string): Promise<TEntity[]> {
    try {
      if (dataArray.length === 0) return [];

      const values = dataArray.map(data => ({
        ...data,
        createdBy: userId || 'system',
        updatedBy: userId || 'system',
      }));

      const created = await db
        .insert(this.schema)
        .values(values as any)
        .returning() as unknown as TEntity[];

      // Clear cache on mutation
      this.clearCache();

      return created;
    } catch (error) {
      log.error('CreateMany operation failed', { count: dataArray.length, userId, error });
      throw error;
    }
  }

  /**
   * Update multiple entities matching filter
   *
   * @param filter - Filter criteria
   * @param data - Partial entity data to update
   * @param orgId - User's organization ID
   * @param userId - User ID performing the update
   * @returns Promise resolving to array of updated entities
   */
  async updateMany(
    filter: Partial<TFilter>,
    data: Partial<TUpdate>,
    orgId: string,
    userId: string,
  ): Promise<TEntity[]> {
    try {
      const conditions = this.buildConditions(filter, orgId);

      const updated = await db
        .update(this.schema)
        .set({
          ...data,
          updatedAt: new Date(),
          updatedBy: userId || 'system',
        } as any)
        .where(and(...conditions))
        .returning() as unknown as TEntity[];

      // Clear cache on mutation
      if (updated.length > 0) {
        this.clearCache();
      }

      return updated;
    } catch (error) {
      log.error('UpdateMany operation failed', { filter, data, orgId, userId, error });
      throw error;
    }
  }

  /**
   * Stream entities matching filter (useful for large datasets)
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID
   * @param batchSize - Number of records to fetch per batch
   * @returns Async generator yielding entities
   */
  async *findStream(
    filter: Partial<TFilter>,
    orgId: string,
    batchSize: number = 100,
  ): AsyncGenerator<TEntity, void, unknown> {
    try {
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const result = await this.findPaginated(filter, orgId, {
          limit: batchSize,
          offset,
        });

        for (const entity of result.data) {
          yield entity;
        }

        hasMore = result.hasMore;
        offset += batchSize;
      }
    } catch (error) {
      log.error('FindStream operation failed', { filter, orgId, batchSize, error });
      throw error;
    }
  }

  /**
   * Search entities with fuzzy matching on searchable fields
   * Must be implemented by subclass to define searchable fields
   *
   * @param query - Search query string
   * @param orgId - User's organization ID
   * @param options - Pagination and sorting options
   * @returns Promise resolving to paginated search results
   */
  async search(
    query: string,
    orgId: string,
    options: QueryOptions = {},
  ): Promise<PaginatedResult<TEntity>> {
    try {
      const { limit = 50, offset = 0, sortBy, sortOrder = 'asc' } = options;

      const cacheKey = this.getCacheKey('search', { query } as any, orgId, options);
      const cached = this.getFromCache<PaginatedResult<TEntity>>(cacheKey);
      if (cached) {
        log.debug('Cache hit for search', { query, orgId, options });
        return cached;
      }

      // Get search conditions from subclass
      const searchConditions = this.buildSearchConditions(query, orgId);

      // Get total count
      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(this.schema)
        .where(and(...searchConditions)) as unknown as [{ count: number }];

      const total = countResult?.count || 0;

      // Build query with sorting
      let dbQuery = db
        .select()
        .from(this.schema)
        .where(and(...searchConditions));

      // Apply sorting if specified
      if (sortBy) {
        const sortColumn = this.getSortColumn(sortBy);
        if (sortColumn) {
          dbQuery = dbQuery.orderBy(sortOrder === 'desc' ? desc(sortColumn) : asc(sortColumn)) as any;
        }
      }

      // Apply pagination
      const results = await dbQuery
        .limit(limit)
        .offset(offset) as unknown as TEntity[];

      const result: PaginatedResult<TEntity> = {
        data: results,
        total,
        limit,
        offset,
        hasMore: offset + results.length < total,
      };

      this.setInCache(cacheKey, result);
      return result;
    } catch (error) {
      log.error('Search operation failed', { query, orgId, options, error });
      throw error;
    }
  }

  /**
   * Build search conditions for fuzzy matching
   * Should be overridden by subclass to define searchable fields
   *
   * Default implementation returns empty conditions (no results)
   *
   * @param _query - Search query string
   * @param _orgId - User's organization ID for access control
   * @returns Array of SQL conditions
   */
  protected buildSearchConditions(_query: string, _orgId: string): SQL[] {
    // Default implementation - subclasses should override
    log.warn('buildSearchConditions not implemented for this service');
    return [sql`1 = 0`]; // Return no results by default
  }

  /**
   * Execute a custom database transaction
   *
   * @param callback - Transaction callback function
   * @returns Promise resolving to transaction result
   */
  async transaction<T>(
    callback: Parameters<typeof db.transaction>[0],
  ): Promise<T> {
    return await db.transaction(callback) as T;
  }
}
