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
   * Supports exact match or pattern matching
   */
  readonly name?: string;

  /**
   * Plugin name pattern for fuzzy matching
   * @example "nodejs-*", "*-build"
   */
  readonly namePattern?: string;

  /**
   * Plugin version to filter by
   * Supports semantic versioning
   * @example "1.0.0", "^2.0.0", "~1.2.3"
   */
  readonly version?: string;

  /**
   * Version range for filtering
   * @example { min: "1.0.0", max: "2.0.0" }
   */
  readonly versionRange?: {
    readonly min?: string;
    readonly max?: string;
  };

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
   * Project name pattern for fuzzy matching
   * @example "app-*", "*-backend"
   */
  readonly projectPattern?: string;

  /**
   * Organization name associated with the pipeline
   */
  readonly organization?: string;

  /**
   * Organization pattern for fuzzy matching
   */
  readonly organizationPattern?: string;

  /**
   * Pipeline name to filter by
   */
  readonly pipelineName?: string;

  /**
   * Pipeline name pattern for fuzzy matching
   * @example "deploy-*", "*-prod"
   */
  readonly pipelineNamePattern?: string;
}

/**
 * Type guard to check if a filter is a PluginFilter
 */
export function isPluginFilter(filter: CommonFilter): filter is PluginFilter {
  return 'name' in filter ||
         'version' in filter ||
         'imageTag' in filter;
}

/**
 * Type guard to check if a filter is a PipelineFilter
 */
export function isPipelineFilter(filter: CommonFilter): filter is PipelineFilter {
  return 'project' in filter ||
         'organization' in filter ||
         'pipelineName' in filter;
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

  // Validate version range
  if (filter.versionRange !== undefined) {
    if (filter.versionRange.min && filter.versionRange.max) {
      // Compare versions (simple string comparison)
      if (filter.versionRange.min > filter.versionRange.max) {
        errors.push('versionRange.min must be less than or equal to versionRange.max');
      }
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

  const errors: string[] = [];

  if (errors.length > 0) {
    throw new Error(`Pipeline filter validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }
}

/**
 * Removes undefined and null values from a filter object
 * Useful for cleaning up filters before sending to API
 */
export function sanitizeFilter<T extends CommonFilter>(filter: T): Partial<T> {
  const sanitized = {} as Record<string, unknown>;

  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null) {
      sanitized[key] = value;
    }
  }

  return sanitized as Partial<T>;
}

/**
 * Merges multiple filters into one
 * Later filters take precedence over earlier ones
 */
export function mergeFilters<T extends CommonFilter>(...filters: Partial<T>[]): Partial<T> {
  return filters.reduce((acc, curr) => ({ ...acc, ...sanitizeFilter(curr) }), {});
}

/**
 * Converts a filter to a URL query string
 */
export function filterToQueryString(filter: CommonFilter): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(sanitizeFilter(filter))) {
    if (Array.isArray(value)) {
      value.forEach(v => params.append(key, String(v)));
    } else if (typeof value === 'object' && value !== null) {
      params.append(key, JSON.stringify(value));
    } else {
      params.append(key, String(value));
    }
  }

  return params.toString();
}

/**
 * Creates a default filter with common pagination settings
 */
export function createDefaultFilter<T extends CommonFilter>(overrides?: Partial<T>): T {
  return {
    limit: 50,
    offset: 0,
    sort: 'createdAt:desc',
    ...overrides,
  } as T;
}

/**
 * Builder pattern for constructing filters
 *
 * @example
 * ```typescript
 * const filter = new FilterBuilder<PluginFilter>()
 *   .withName('nodejs-build')
 *   .withVersion('1.0.0')
 *   .withIsActive(true)
 *   .withLimit(10)
 *   .build();
 * ```
 */
export class FilterBuilder<T extends CommonFilter> {
  protected filter: Partial<T> = {};

  /**
   * Set a filter property in a type-safe way
   */
  protected set<K extends keyof T>(key: K, value: T[K]): this {
    this.filter = { ...this.filter, [key]: value };
    return this;
  }

  withId(id: string | string[]): this {
    return this.set('id' as keyof T, id as T[keyof T]);
  }

  withOrgId(orgId: string | string[]): this {
    return this.set('orgId' as keyof T, orgId as T[keyof T]);
  }

  withAccessModifier(accessModifier: AccessModifier | string): this {
    return this.set('accessModifier' as keyof T, accessModifier as T[keyof T]);
  }

  withIsDefault(isDefault: boolean): this {
    return this.set('isDefault' as keyof T, isDefault as T[keyof T]);
  }

  withIsActive(isActive: boolean): this {
    return this.set('isActive' as keyof T, isActive as T[keyof T]);
  }

  withLimit(limit: number): this {
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
      throw new Error('Limit must be an integer between 0 and 1000');
    }
    return this.set('limit' as keyof T, limit as T[keyof T]);
  }

  withOffset(offset: number): this {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('Offset must be a non-negative integer');
    }
    return this.set('offset' as keyof T, offset as T[keyof T]);
  }

  withSort(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    return this.set('sort' as keyof T, `${field}:${direction}` as T[keyof T]);
  }

  /**
   * Get the current filter state (immutable copy)
   */
  getFilter(): Partial<T> {
    return { ...this.filter };
  }

  /**
   * Reset the builder to empty state
   */
  reset(): this {
    this.filter = {};
    return this;
  }

  build(): T {
    return sanitizeFilter(this.filter as T) as T;
  }
}

/**
 * Builder for plugin filters with plugin-specific methods
 */
export class PluginFilterBuilder extends FilterBuilder<PluginFilter> {
  withName(name: string): this {
    return this.set('name', name);
  }

  withNamePattern(pattern: string): this {
    return this.set('namePattern', pattern);
  }

  withVersion(version: string): this {
    return this.set('version', version);
  }

  withVersionRange(min?: string, max?: string): this {
    return this.set('versionRange', { min, max });
  }

  withImageTag(imageTag: string): this {
    return this.set('imageTag', imageTag);
  }
}

/**
 * Builder for pipeline filters with pipeline-specific methods
 */
export class PipelineFilterBuilder extends FilterBuilder<PipelineFilter> {
  withProject(project: string): this {
    return this.set('project', project);
  }

  withProjectPattern(pattern: string): this {
    return this.set('projectPattern', pattern);
  }

  withOrganization(organization: string): this {
    return this.set('organization', organization);
  }

  withOrganizationPattern(pattern: string): this {
    return this.set('organizationPattern', pattern);
  }

  withPipelineName(pipelineName: string): this {
    return this.set('pipelineName', pipelineName);
  }

  withPipelineNamePattern(pattern: string): this {
    return this.set('pipelineNamePattern', pattern);
  }
}