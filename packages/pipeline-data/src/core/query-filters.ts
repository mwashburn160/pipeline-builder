/**
 * @module core/query-filters
 * @description Defines TypeScript filter interfaces used to specify query criteria for pipelines, plugins, and messages.
 */

import { AccessModifier } from '@mwashburn160/api-core';

/**
 * Base filter interface containing common filter properties shared across all entity types.
 *
 * @example
 * ```typescript
 * const filter: CommonFilter = {
 *   id: '123',
 *   orgId: 'my-org',
 *   accessModifier: AccessModifier.PUBLIC,
 *   isDefault: true,
 *   isActive: true
 * };
 * ```
 */
export interface CommonFilter {
  /**
   * Unique identifier for the entity
   * Can be a single ID or array of IDs for batch filtering
   */
  readonly id?: string | string[];

  /**
   * Organization identifier to filter entities by organization
   * Can be a single org ID or array for multi-org filtering
   */
  readonly orgId?: string | string[];

  /**
   * Access modifier to filter by visibility/permissions
   * Use AccessModifier enum for type safety
   * @see AccessModifier
   */
  readonly accessModifier?: AccessModifier | string;

  /**
   * Filter by default status
   * - true: Only default entities
   * - false: Only non-default entities
   * - undefined: All entities
   */
  readonly isDefault?: boolean;

  /**
   * Filter by active/inactive status
   * - true: Only active entities
   * - false: Only inactive entities
   * - undefined: All entities
   */
  readonly isActive?: boolean;

  /**
   * Number of results to return
   * @minimum 1
   * @maximum 1000
   */
  readonly limit?: number;

  /**
   * Number of results to skip (for pagination)
   * @minimum 0
   */
  readonly offset?: number;

  /**
   * Sort field and direction
   * @example "name:asc", "createdAt:desc"
   */
  readonly sort?: string;
}

/**
 * Filter interface for plugin-specific properties.
 * Extends CommonFilter to include plugin-related filter options.
 *
 * @example
 * ```typescript
 * const filter: PluginFilter = {
 *   name: 'nodejs-build',
 *   version: '1.0.0',
 *   isActive: true
 * };
 * ```
 */
export interface PluginFilter extends CommonFilter {
  /**
   * Plugin name to filter by
   */
  readonly name?: string;

  /**
   * Plugin version to filter by
   * Supports semantic versioning
   * @example "1.0.0", "^2.0.0", "~1.2.3"
   */
  readonly version?: string;

  /**
   * Docker image tag associated with the plugin
   */
  readonly imageTag?: string;
}

/**
 * Filter interface for pipeline-specific properties.
 * Extends CommonFilter to include pipeline-related filter options.
 *
 * @example
 * ```typescript
 * const filter: PipelineFilter = {
 *   project: 'my-app',
 *   organization: 'my-org',
 *   pipelineName: 'my-pipeline',
 *   isActive: true
 * };
 * ```
 */
export interface PipelineFilter extends CommonFilter {
  /**
   * Project name associated with the pipeline
   */
  readonly project?: string;

  /**
   * Organization name associated with the pipeline
   */
  readonly organization?: string;

  /**
   * Pipeline name to filter by
   */
  readonly pipelineName?: string;
}

/**
 * Filter interface for message-specific properties.
 * Extends CommonFilter to include message-related filter options.
 */
export interface MessageFilter extends CommonFilter {
  /**
   * Thread ID to filter by (for fetching thread replies).
   * Pass `null` to filter for root messages only (threadId IS NULL).
   */
  readonly threadId?: string | null;

  /**
   * Recipient organization ID to filter by
   * Use '*' for broadcast announcements
   */
  readonly recipientOrgId?: string;

  /**
   * Message type filter
   */
  readonly messageType?: 'announcement' | 'conversation';

  /**
   * Filter by read status
   */
  readonly isRead?: boolean;

  /**
   * Filter by priority level
   */
  readonly priority?: 'normal' | 'high' | 'urgent';
}

/**
 * Validates common filter properties
 * @throws Error if validation fails
 */
export function validateCommonFilter(filter: CommonFilter): void {
  const errors: string[] = [];

  // Validate limit - accept both number and string
  if (filter.limit !== undefined) {
    const limit = typeof filter.limit === 'string'
      ? parseInt(filter.limit, 10)
      : filter.limit;

    if (isNaN(limit) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      errors.push('limit must be an integer between 1 and 1000');
    }
  }

  // Validate offset - accept both number and string
  if (filter.offset !== undefined) {
    const offset = typeof filter.offset === 'string'
      ? parseInt(filter.offset, 10)
      : filter.offset;

    if (isNaN(offset) || !Number.isInteger(offset) || offset < 0) {
      errors.push('offset must be a non-negative integer');
    }
  }

  // Validate sort format
  if (filter.sort !== undefined) {
    const sortPattern = /^[a-zA-Z_][a-zA-Z0-9_]*:(asc|desc)$/;
    if (!sortPattern.test(filter.sort)) {
      errors.push('sort must be in format "field:asc" or "field:desc"');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Filter validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
}

/**
 * Validates plugin filter properties
 * @throws Error if validation fails
 */
export function validatePluginFilter(filter: PluginFilter): void {
  validateCommonFilter(filter);

  const errors: string[] = [];

  // Validate version format (semantic versioning)
  if (filter.version !== undefined) {
    const versionPattern = /^(\^|~)?(\d+)\.(\d+)\.(\d+)(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
    if (!versionPattern.test(filter.version)) {
      errors.push(`Invalid version format: "${filter.version}". Expected semantic versioning (e.g., "1.0.0", "^2.1.0")`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Plugin filter validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
}

/**
 * Validates pipeline filter properties
 * @throws Error if validation fails
 */
export function validatePipelineFilter(filter: PipelineFilter): void {
  validateCommonFilter(filter);
}

/**
 * Validates message filter properties.
 * Returns a result object with `valid` flag and `errors` array.
 */
export function validateMessageFilter(filter: Partial<MessageFilter>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (filter.messageType && !['announcement', 'conversation'].includes(filter.messageType)) {
    errors.push(`Invalid messageType: "${filter.messageType}". Must be "announcement" or "conversation"`);
  }
  if (filter.priority && !['normal', 'high', 'urgent'].includes(filter.priority)) {
    errors.push(`Invalid priority: "${filter.priority}". Must be "normal", "high", or "urgent"`);
  }
  if (filter.threadId !== undefined && filter.threadId !== null && typeof filter.threadId !== 'string') {
    errors.push('threadId must be a string UUID or null');
  }

  return { valid: errors.length === 0, errors };
}
