/**
 * @module services/pipeline-service
 * @description Service layer for pipeline CRUD operations with access control.
 *
 * Extends the generic CrudService to provide pipeline-specific implementations.
 */

import {
  CrudService,
  buildPipelineConditions,
  schema,
  db,
  type PipelineFilter,
} from '@mwashburn160/pipeline-core';
import { SQL, or, ilike, eq, and } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * Pipeline entity type (inferred from schema)
 */
export type Pipeline = typeof schema.pipeline.$inferSelect;

/**
 * Pipeline insert DTO (data for creating new pipeline)
 */
export type PipelineInsert = typeof schema.pipeline.$inferInsert;

/**
 * Pipeline update DTO (partial data for updating pipeline)
 */
export type PipelineUpdate = Partial<Omit<Pipeline, 'id' | 'createdAt' | 'createdBy'>>;

/**
 * Pipeline service with CRUD operations and access control.
 *
 * Features:
 * - Multi-tenant access control (public/private/org-scoped)
 * - Type-safe CRUD operations
 * - Default pipeline management per project/org
 * - Inherits transaction support from base class
 *
 * @example
 * ```typescript
 * const pipelineService = new PipelineService();
 *
 * // Find pipelines for an organization
 * const pipelines = await pipelineService.find(
 *   { project: 'my-project', isActive: true },
 *   'org-123'
 * );
 *
 * // Create a new pipeline
 * const newPipeline = await pipelineService.create({
 *   orgId: 'org-123',
 *   project: 'my-project',
 *   organization: 'my-org',
 *   pipelineName: 'my-pipeline',
 *   props: { ... },
 *   accessModifier: 'private',
 *   isDefault: true,
 *   isActive: true,
 * }, 'user-456');
 *
 * // Set a pipeline as default for a project
 * await pipelineService.setDefaultForProject(
 *   'my-project',
 *   'my-org',
 *   'pipeline-id',
 *   'user-456'
 * );
 * ```
 */
export class PipelineService extends CrudService<
  Pipeline,
  PipelineFilter,
  PipelineInsert,
  PipelineUpdate
> {
  /**
   * Get the pipeline schema table
   */
  protected get schema(): PgTable {
    return schema.pipeline as PgTable;
  }

  /**
   * Build SQL conditions for filtering pipelines
   *
   * Uses the existing buildPipelineConditions function which handles:
   * - Access control (public/private/org-and-public)
   * - UUID prefix matching
   * - Project, organization, and boolean filters
   *
   * @param filter - Filter criteria from query parameters
   * @param orgId - User's organization ID for access control
   * @returns Array of SQL conditions
   */
  protected buildConditions(filter: Partial<PipelineFilter>, orgId: string): SQL[] {
    return buildPipelineConditions(filter, orgId);
  }

  /**
   * Get sortable column from schema
   *
   * @param sortBy - Sort field name
   * @returns Schema column or null if not sortable
   */
  protected getSortColumn(sortBy: string): any | null {
    const sortableColumns: Record<string, any> = {
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

  /**
   * Build search conditions for fuzzy matching
   *
   * Searches across: project, organization, pipelineName
   *
   * @param query - Search query string
   * @param orgId - User's organization ID for access control
   * @returns Array of SQL conditions
   */
  protected buildSearchConditions(query: string, orgId: string): SQL[] {
    const normalizedQuery = `%${query.toLowerCase()}%`;

    // Search across project, organization, and pipelineName
    const searchCondition = or(
      ilike(schema.pipeline.project, normalizedQuery),
      ilike(schema.pipeline.organization, normalizedQuery),
      ilike(schema.pipeline.pipelineName, normalizedQuery),
    )!;

    // Add access control (user's org or public)
    const accessCondition = or(
      eq(schema.pipeline.orgId, orgId.toLowerCase()),
      eq(schema.pipeline.accessModifier, 'public'),
    )!;

    return [searchCondition, accessCondition];
  }

  /**
   * Set a pipeline as the default for a project/organization
   *
   * Convenience method that calls the base setDefault with correct field names.
   *
   * @param project - Project identifier
   * @param organization - Organization identifier
   * @param pipelineId - Pipeline ID to set as default
   * @param userId - User ID performing the operation
   * @returns Promise resolving to updated pipeline
   */
  async setDefaultForProject(
    project: string,
    organization: string,
    pipelineId: string,
    userId: string,
  ): Promise<Pipeline> {
    return this.setDefault(
      'project',
      'organization',
      project,
      organization,
      pipelineId,
      userId,
    );
  }

  /**
   * Find pipelines for a specific project
   *
   * Convenience method for common use case.
   *
   * @param project - Project identifier
   * @param orgId - Organization ID
   * @returns Promise resolving to array of pipelines
   */
  async findByProject(project: string, orgId: string): Promise<Pipeline[]> {
    return this.find({ project, isActive: true }, orgId);
  }

  /**
   * Get the active default pipeline for a project
   *
   * @param project - Project identifier
   * @param organization - Organization identifier
   * @param orgId - User's organization ID for access control
   * @returns Promise resolving to default pipeline or null
   */
  async getDefaultForProject(
    project: string,
    organization: string,
    orgId: string,
  ): Promise<Pipeline | null> {
    const pipelines = await this.find(
      {
        project,
        organization,
        isDefault: true,
        isActive: true,
      },
      orgId,
    );

    return pipelines[0] || null;
  }

  /**
   * Create a new pipeline and set it as the default for the project
   *
   * Atomically:
   * 1. Sets all existing default pipelines for the project/organization to non-default
   * 2. Creates the new pipeline with isDefault: true
   *
   * @param data - Pipeline data to insert
   * @param userId - User ID performing the operation
   * @param project - Project identifier
   * @param organization - Organization identifier
   * @returns Promise resolving to created pipeline
   */
  async createAsDefault(
    data: PipelineInsert,
    userId: string,
    project: string,
    organization: string,
  ): Promise<Pipeline> {
    return db.transaction(async (tx) => {
      // Clear existing defaults for this project/organization
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

      // Create new pipeline as default
      const [result] = await tx
        .insert(schema.pipeline)
        .values({ ...data, isDefault: true, isActive: true })
        .returning();

      return result as unknown as Pipeline;
    });
  }
}

/**
 * Singleton instance of PipelineService
 *
 * Use this for consistent service access across the application.
 *
 * @example
 * ```typescript
 * import { pipelineService } from './services/pipeline-service';
 *
 * // In route handler
 * const pipelines = await pipelineService.find(filter, orgId);
 * ```
 */
export const pipelineService = new PipelineService();
