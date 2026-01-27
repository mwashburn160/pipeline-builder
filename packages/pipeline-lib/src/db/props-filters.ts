import { AccessModifier } from '../pipeline/types';

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
         'organization' in filter;
}

/**
 * Validates common filter properties
 * @throws Error if validation fails
 */
export function validateCommonFilter(filter: CommonFilter): void {
  const errors: string[] = [];

  // Validate limit
  if (filter.limit !== undefined) {
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 1000) {
      errors.push('limit must be an integer between 1 and 1000');
    }
  }

  // Validate offset
  if (filter.offset !== undefined) {
    if (!Number.isInteger(filter.offset) || filter.offset < 0) {
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
  const sanitized: any = {};

  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null) {
      sanitized[key] = value;
    }
  }

  return sanitized;
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

  withId(id: string | string[]): this {
    (this.filter as any).id = id;
    return this;
  }

  withOrgId(orgId: string | string[]): this {
    (this.filter as any).orgId = orgId;
    return this;
  }

  withAccessModifier(accessModifier: AccessModifier | string): this {
    (this.filter as any).accessModifier = accessModifier;
    return this;
  }

  withIsDefault(isDefault: boolean): this {
    (this.filter as any).isDefault = isDefault;
    return this;
  }

  withIsActive(isActive: boolean): this {
    (this.filter as any).isActive = isActive;
    return this;
  }

  withLimit(limit: number): this {
    (this.filter as any).limit = limit;
    return this;
  }

  withOffset(offset: number): this {
    (this.filter as any).offset = offset;
    return this;
  }

  withSort(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    (this.filter as any).sort = `${field}:${direction}`;
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
    (this as any).filter.name = name;
    return this;
  }

  withNamePattern(pattern: string): this {
    (this as any).filter.namePattern = pattern;
    return this;
  }

  withVersion(version: string): this {
    (this as any).filter.version = version;
    return this;
  }

  withVersionRange(min?: string, max?: string): this {
    (this as any).filter.versionRange = { min, max };
    return this;
  }

  withImageTag(imageTag: string): this {
    (this as any).filter.imageTag = imageTag;
    return this;
  }

  withPluginType(pluginType: string): this {
    (this as any).filter.pluginType = pluginType;
    return this;
  }
}

/**
 * Builder for pipeline filters with pipeline-specific methods
 */
export class PipelineFilterBuilder extends FilterBuilder<PipelineFilter> {
  withProject(project: string): this {
    (this as any).filter.project = project;
    return this;
  }

  withProjectPattern(pattern: string): this {
    (this as any).filter.projectPattern = pattern;
    return this;
  }

  withOrganization(organization: string): this {
    (this as any).filter.organization = organization;
    return this;
  }

  withOrganizationPattern(pattern: string): this {
    (this as any).filter.organizationPattern = pattern;
    return this;
  }
}