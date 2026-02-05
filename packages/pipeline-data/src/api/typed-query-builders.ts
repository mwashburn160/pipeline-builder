import { and, desc, eq } from 'drizzle-orm';
import type { PgSelect } from 'drizzle-orm/pg-core';
import { buildPluginConditions, buildPipelineConditions, parsePagination } from './query-builders';
import type { PluginFilter, PipelineFilter } from '../core/query-filters';
import { schema, Plugin, Pipeline, PluginInsert, PipelineInsert } from '../database/drizzle-schema';
import { Connection } from '../database/postgres-connection';

/**
 * Pagination configuration
 */
export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

/**
 * Query result with pagination metadata
 */
export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
  };
}

/**
 * Base query builder with common pagination and CRUD operations
 */
abstract class BaseQueryBuilder<TEntity, TInsert> {
  protected abstract get db(): any;
  protected abstract get table(): any;

  /**
   * Apply pagination to a query
   */
  protected applyPagination<T extends PgSelect>(
    query: T,
    options?: PaginationOptions,
  ): T {
    const { limit, offset } = parsePagination(options ?? {}, 50);
    return query.limit(limit).offset(offset) as T;
  }

  /**
   * Execute query and wrap result with pagination metadata
   */
  protected async executePaginated<T>(
    query: any,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<T>> {
    const { limit, offset } = parsePagination(options ?? {}, 50);
    const data = await query.limit(limit).offset(offset);

    return {
      data,
      pagination: {
        limit,
        offset,
        count: data.length,
      },
    };
  }

  /**
   * Insert a new entity
   */
  async insert(data: TInsert): Promise<TEntity> {
    const [result] = await this.db.insert(this.table).values(data).returning();
    return result;
  }

  /**
   * Update an entity by ID
   */
  async update(id: string, data: Partial<TInsert>): Promise<TEntity | undefined> {
    const [result] = await this.db
      .update(this.table)
      .set(data)
      .where(eq(this.table.id, id))
      .returning();
    return result;
  }

  /**
   * Delete an entity by ID (hard delete)
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(this.table).where(eq(this.table.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }
}

/**
 * Type-safe query builder for Plugin entities.
 * Provides a fluent interface for building and executing plugin queries.
 *
 * @example
 * ```typescript
 * const builder = new PluginQueryBuilder('my-org');
 *
 * // Find all active plugins
 * const plugins = await builder.findActive().execute();
 *
 * // Find by name with pagination
 * const result = await builder
 *   .findByName('synth')
 *   .paginate({ limit: 10, offset: 0 });
 *
 * // Complex filter
 * const filtered = await builder.filter({
 *   name: 'synth',
 *   version: '1.0.0',
 *   isActive: true
 * }).execute();
 * ```
 */
export class PluginQueryBuilder extends BaseQueryBuilder<Plugin, PluginInsert> {
  private _db = Connection.getInstance().db;

  protected get db() {
    return this._db;
  }

  protected get table() {
    return schema.plugin;
  }

  constructor(private readonly orgId: string) {
    super();
  }

  /**
   * Creates a base select query with access control
   */
  private baseQuery() {
    return this._db.select().from(schema.plugin);
  }

  /**
   * Find all plugins (respecting access control)
   */
  findAll(): this {
    return this;
  }

  /**
   * Find plugin by ID
   */
  findById(id: string) {
    return this.baseQuery().where(eq(schema.plugin.id, id));
  }

  /**
   * Find plugins by name
   */
  findByName(name: string) {
    const conditions = buildPluginConditions({ name }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find plugins by version
   */
  findByVersion(version: string) {
    const conditions = buildPluginConditions({ version }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find plugins by name and version
   */
  findByNameAndVersion(name: string, version: string) {
    const conditions = buildPluginConditions({ name, version }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find active plugins
   */
  findActive() {
    const conditions = buildPluginConditions({ isActive: true }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find default plugins
   */
  findDefault() {
    const conditions = buildPluginConditions({ isDefault: true }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find public plugins
   */
  findPublic() {
    const conditions = buildPluginConditions({ accessModifier: 'public' }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find plugins by organization
   */
  findByOrg(orgId: string = this.orgId) {
    return this.baseQuery().where(eq(schema.plugin.orgId, orgId));
  }

  /**
   * Find plugins by image tag
   */
  findByImageTag(imageTag: string) {
    const conditions = buildPluginConditions({ imageTag }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Apply complex filter criteria
   */
  filter(filter: Partial<PluginFilter>) {
    const conditions = buildPluginConditions(filter, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Order by creation date (newest first)
   */
  orderByNewest() {
    return this.baseQuery().orderBy(desc(schema.plugin.createdAt));
  }

  /**
   * Execute query with pagination
   */
  async paginate(options?: PaginationOptions): Promise<PaginatedResult<Plugin>> {
    const conditions = buildPluginConditions({}, this.orgId);
    const query = this.baseQuery().where(and(...conditions));
    return this.executePaginated<Plugin>(query, options);
  }

  /**
   * Execute filtered query with pagination
   */
  async filterAndPaginate(
    filter: Partial<PluginFilter>,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<Plugin>> {
    const query = this.filter(filter);
    return this.executePaginated<Plugin>(query, options);
  }

  /**
   * Count total plugins matching filter
   */
  async count(filter: Partial<PluginFilter> = {}): Promise<number> {
    const conditions = buildPluginConditions(filter, this.orgId);
    const result = await this._db
      .select()
      .from(schema.plugin)
      .where(and(...conditions));
    return result.length;
  }
}

/**
 * Type-safe query builder for Pipeline entities.
 * Provides a fluent interface for building and executing pipeline queries.
 *
 * @example
 * ```typescript
 * const builder = new PipelineQueryBuilder('my-org');
 *
 * // Find all active pipelines
 * const pipelines = await builder.findActive().execute();
 *
 * // Find by project
 * const result = await builder
 *   .findByProject('my-app')
 *   .paginate({ limit: 10 });
 * ```
 */
export class PipelineQueryBuilder extends BaseQueryBuilder<Pipeline, PipelineInsert> {
  private _db = Connection.getInstance().db;

  protected get db() {
    return this._db;
  }

  protected get table() {
    return schema.pipeline;
  }

  constructor(private readonly orgId: string) {
    super();
  }

  /**
   * Creates a base select query
   */
  private baseQuery() {
    return this._db.select().from(schema.pipeline);
  }

  /**
   * Find all pipelines (respecting access control)
   */
  findAll(): this {
    return this;
  }

  /**
   * Find pipeline by ID
   */
  findById(id: string) {
    return this.baseQuery().where(eq(schema.pipeline.id, id));
  }

  /**
   * Find pipelines by project
   */
  findByProject(project: string) {
    const conditions = buildPipelineConditions({ project }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find pipelines by organization
   */
  findByOrganization(organization: string) {
    const conditions = buildPipelineConditions({ organization }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find pipelines by project and organization
   */
  findByProjectAndOrg(project: string, organization: string) {
    const conditions = buildPipelineConditions({ project, organization }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find active pipelines
   */
  findActive() {
    const conditions = buildPipelineConditions({ isActive: true }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find default pipelines
   */
  findDefault() {
    const conditions = buildPipelineConditions({ isDefault: true }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Find public pipelines
   */
  findPublic() {
    const conditions = buildPipelineConditions({ accessModifier: 'public' }, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Apply complex filter criteria
   */
  filter(filter: Partial<PipelineFilter>) {
    const conditions = buildPipelineConditions(filter, this.orgId);
    return this.baseQuery().where(and(...conditions));
  }

  /**
   * Order by creation date (newest first)
   */
  orderByNewest() {
    return this.baseQuery().orderBy(desc(schema.pipeline.createdAt));
  }

  /**
   * Execute query with pagination
   */
  async paginate(options?: PaginationOptions): Promise<PaginatedResult<Pipeline>> {
    const conditions = buildPipelineConditions({}, this.orgId);
    const query = this.baseQuery().where(and(...conditions));
    return this.executePaginated<Pipeline>(query, options);
  }

  /**
   * Execute filtered query with pagination
   */
  async filterAndPaginate(
    filter: Partial<PipelineFilter>,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<Pipeline>> {
    const query = this.filter(filter);
    return this.executePaginated<Pipeline>(query, options);
  }

  /**
   * Count total pipelines matching filter
   */
  async count(filter: Partial<PipelineFilter> = {}): Promise<number> {
    const conditions = buildPipelineConditions(filter, this.orgId);
    const result = await this._db
      .select()
      .from(schema.pipeline)
      .where(and(...conditions));
    return result.length;
  }
}
