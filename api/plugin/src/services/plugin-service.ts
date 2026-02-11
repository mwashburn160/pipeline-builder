/**
 * @module services/plugin-service
 * @description Service layer for plugin CRUD operations with access control.
 *
 * Extends the generic CrudService to provide plugin-specific implementations.
 */

import {
  CrudService,
  buildPluginConditions,
  schema,
  type PluginFilter,
} from '@mwashburn160/pipeline-core';
import { SQL, or, ilike, eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * Plugin entity type (inferred from schema)
 */
export type Plugin = typeof schema.plugin.$inferSelect;

/**
 * Plugin insert DTO (data for creating new plugin)
 */
export type PluginInsert = typeof schema.plugin.$inferInsert;

/**
 * Plugin update DTO (partial data for updating plugin)
 */
export type PluginUpdate = Partial<Omit<Plugin, 'id' | 'createdAt' | 'createdBy'>>;

/**
 * Plugin service with CRUD operations and access control.
 *
 * Features:
 * - Multi-tenant access control (public/private/org-scoped)
 * - Type-safe CRUD operations
 * - Default plugin management per org
 * - Inherits transaction support from base class
 *
 * @example
 * ```typescript
 * const pluginService = new PluginService();
 *
 * // Find plugins for an organization
 * const plugins = await pluginService.find(
 *   { name: 'nodejs-build', isActive: true },
 *   'org-123'
 * );
 *
 * // Create a new plugin
 * const newPlugin = await pluginService.create({
 *   orgId: 'org-123',
 *   name: 'nodejs-build',
 *   description: 'Node.js build plugin',
 *   version: '1.0.0',
 *   imageTag: 'nodejs-build:1.0.0',
 *   accessModifier: 'private',
 *   isDefault: true,
 *   isActive: true,
 * }, 'user-456');
 *
 * // Set a plugin as default for an organization
 * await pluginService.setDefaultForOrg(
 *   'org-123',
 *   'plugin-id',
 *   'user-456'
 * );
 * ```
 */
export class PluginService extends CrudService<
  Plugin,
  PluginFilter,
  PluginInsert,
  PluginUpdate
> {
  /**
   * Get the plugin schema table
   */
  protected get schema(): PgTable {
    return schema.plugin as PgTable;
  }

  /**
   * Build SQL conditions for filtering plugins
   *
   * Uses the existing buildPluginConditions function which handles:
   * - Access control (public/private/org-and-public)
   * - UUID prefix matching
   * - Name, version, imageTag filters
   *
   * @param filter - Filter criteria from query parameters
   * @param orgId - User's organization ID for access control
   * @returns Array of SQL conditions
   */
  protected buildConditions(filter: Partial<PluginFilter>, orgId: string): SQL[] {
    return buildPluginConditions(filter, orgId);
  }

  /**
   * Get sortable column from schema
   *
   * @param sortBy - Sort field name
   * @returns Schema column or null if not sortable
   */
  protected getSortColumn(sortBy: string): any | null {
    const sortableColumns: Record<string, any> = {
      id: schema.plugin.id,
      name: schema.plugin.name,
      version: schema.plugin.version,
      createdAt: schema.plugin.createdAt,
      updatedAt: schema.plugin.updatedAt,
      isActive: schema.plugin.isActive,
      isDefault: schema.plugin.isDefault,
    };

    return sortableColumns[sortBy] || null;
  }

  /**
   * Build search conditions for fuzzy matching
   *
   * Searches across: name, description, version
   *
   * @param query - Search query string
   * @param orgId - User's organization ID for access control
   * @returns Array of SQL conditions
   */
  protected buildSearchConditions(query: string, orgId: string): SQL[] {
    const normalizedQuery = `%${query.toLowerCase()}%`;

    // Search across name, description, and version
    const searchCondition = or(
      ilike(schema.plugin.name, normalizedQuery),
      ilike(schema.plugin.description, normalizedQuery),
      ilike(schema.plugin.version, normalizedQuery),
    )!;

    // Add access control (user's org or public)
    const accessCondition = or(
      eq(schema.plugin.orgId, orgId.toLowerCase()),
      eq(schema.plugin.accessModifier, 'public'),
    )!;

    return [searchCondition, accessCondition];
  }

  /**
   * Set a plugin as the default for an organization
   *
   * Convenience method that calls the base setDefault with correct field names.
   * Note: Plugins use 'orgId' instead of separate project/organization fields.
   *
   * @param orgId - Organization identifier
   * @param pluginId - Plugin ID to set as default
   * @param userId - User ID performing the operation
   * @returns Promise resolving to updated plugin
   */
  async setDefaultForOrg(
    orgId: string,
    pluginId: string,
    userId: string,
  ): Promise<Plugin> {
    // Plugins use orgId for both project and organization scoping
    return this.setDefault(
      'orgId',
      'orgId',
      orgId,
      orgId,
      pluginId,
      userId,
    );
  }

  /**
   * Find plugins by name
   *
   * Convenience method for common use case.
   *
   * @param name - Plugin name
   * @param orgId - Organization ID
   * @returns Promise resolving to array of plugins
   */
  async findByName(name: string, orgId: string): Promise<Plugin[]> {
    return this.find({ name, isActive: true }, orgId);
  }

  /**
   * Find a specific plugin version
   *
   * @param name - Plugin name
   * @param version - Plugin version
   * @param orgId - Organization ID
   * @returns Promise resolving to plugin or null
   */
  async findByNameAndVersion(
    name: string,
    version: string,
    orgId: string,
  ): Promise<Plugin | null> {
    const plugins = await this.find(
      {
        name,
        version,
        isActive: true,
      },
      orgId,
    );

    return plugins[0] || null;
  }

  /**
   * Get the active default plugin for an organization
   *
   * @param orgId - Organization identifier
   * @returns Promise resolving to default plugin or null
   */
  async getDefaultForOrg(orgId: string): Promise<Plugin | null> {
    const plugins = await this.find(
      {
        orgId,
        isDefault: true,
        isActive: true,
      },
      orgId,
    );

    return plugins[0] || null;
  }
}

/**
 * Singleton instance of PluginService
 *
 * Use this for consistent service access across the application.
 *
 * @example
 * ```typescript
 * import { pluginService } from './services/plugin-service';
 *
 * // In route handler
 * const plugins = await pluginService.find(filter, orgId);
 * ```
 */
export const pluginService = new PluginService();
