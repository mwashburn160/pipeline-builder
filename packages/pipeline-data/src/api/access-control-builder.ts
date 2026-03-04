import { AccessModifier, SYSTEM_ORG_ID } from '@mwashburn160/api-core';
import { eq, or, sql, SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm/column';

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Escape SQL LIKE wildcard characters to prevent wildcard injection.
 * Replaces `%` → `\\%`, `_` → `\\_`, and `\\` → `\\\\`.
 */
export function escapeLikeWildcards(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Parse boolean filter value from string or boolean
 */
export function parseBooleanFilter(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true';
  return Boolean(value);
}

/**
 * Normalize string filter value to lowercase
 */
export function normalizeStringFilter(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : String(value).toLowerCase();
}

/**
 * Schema table interface for access control queries
 */
export interface AccessControlSchema {
  id: AnyColumn;
  orgId: AnyColumn;
  accessModifier: AnyColumn;
  isDefault: AnyColumn;
  isActive: AnyColumn;
}

/**
 * Base filter interface with common access control fields
 */
export interface BaseAccessFilter {
  id?: string | string[];
  accessModifier?: string;
  isDefault?: boolean | string;
  isActive?: boolean | string;
}

/**
 * Generic access control query builder for multi-tenant entities.
 *
 * Consolidates duplicate access control logic shared across pipeline and plugin queries.
 * Handles:
 * - Multi-tenant access control (public/private/org-and-public)
 * - UUID prefix matching for ID filters
 * - Boolean field normalization
 *
 * @typeParam TSchema - Schema table type with access control fields
 * @typeParam TFilter - Filter type extending BaseAccessFilter
 */
export class AccessControlQueryBuilder<
  TSchema extends AccessControlSchema,
  TFilter extends BaseAccessFilter,
> {
  constructor(
    private schema: TSchema,
  ) {}

  /**
   * Build access control conditions based on orgId and accessModifier filter.
   *
   * Without orgId (anonymous):
   *   orgId='system' AND accessModifier='public'
   *
   * With orgId:
   *   - accessModifier='private': orgId=$org AND accessModifier='private'
   *   - accessModifier='public':  orgId=$org AND accessModifier='public'
   *   - no accessModifier:        accessModifier='public' AND (orgId=$org OR orgId='system')
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID (optional)
   * @returns Array of SQL conditions for access control
   */
  protected buildAccessControl(filter: Partial<TFilter>, orgId?: string): SQL[] {
    const conditions: SQL[] = [];

    if (!orgId) {
      // No org context — only system org's public records
      conditions.push(eq(this.schema.orgId, SYSTEM_ORG_ID));
      conditions.push(eq(this.schema.accessModifier, AccessModifier.PUBLIC));
      return conditions;
    }

    const normalizedOrgId = orgId.toLowerCase();
    const accessModifier = filter.accessModifier as string | undefined;

    if (accessModifier !== undefined) {
      // Explicit filter: scope to user's org + requested access modifier
      const normalized = typeof accessModifier === 'string'
        ? accessModifier.toLowerCase()
        : String(accessModifier).toLowerCase();
      conditions.push(eq(this.schema.orgId, normalizedOrgId));
      conditions.push(eq(this.schema.accessModifier, normalized));
    } else {
      // Default: user's org public + system org public
      conditions.push(eq(this.schema.accessModifier, AccessModifier.PUBLIC));
      conditions.push(
        or(
          eq(this.schema.orgId, normalizedOrgId),
          eq(this.schema.orgId, SYSTEM_ORG_ID),
        )!,
      );
    }

    return conditions;
  }

  /**
   * Build ID filter with UUID prefix matching support
   *
   * - Full UUID: Exact match
   * - Partial UUID: Prefix match using SQL LIKE
   *
   * @param id - ID filter value (full or partial UUID)
   * @returns SQL condition or null if no ID filter
   */
  protected buildIdFilter(id: unknown): SQL | null {
    if (id === undefined) return null;

    const idString = (id as string).toLowerCase();
    if (FULL_UUID.test(idString)) {
      return eq(this.schema.id, idString);
    } else {
      // Escape SQL LIKE wildcards to prevent wildcard injection
      const escaped = escapeLikeWildcards(idString);
      return sql`${this.schema.id}::text LIKE ${escaped + '%'} ESCAPE '\\'`;
    }
  }

  /**
   * Build boolean field conditions (isDefault, isActive)
   *
   * @param filter - Filter criteria
   * @returns Array of SQL conditions for boolean fields
   */
  protected buildBooleanFilters(filter: Partial<TFilter>): SQL[] {
    const conditions: SQL[] = [];

    if (filter.isDefault !== undefined) {
      conditions.push(eq(this.schema.isDefault, parseBooleanFilter(filter.isDefault)));
    }

    if (filter.isActive !== undefined) {
      conditions.push(eq(this.schema.isActive, parseBooleanFilter(filter.isActive)));
    } else {
      // Default to active records only to exclude soft-deleted entities
      conditions.push(eq(this.schema.isActive, true));
    }

    return conditions;
  }

  /**
   * Build explicit accessModifier filter
   *
   * Note: This is separate from access control logic - it filters by the exact
   * accessModifier value rather than applying multi-tenant access rules.
   *
   * @param accessModifier - Access modifier filter value
   * @returns SQL condition or null if no accessModifier filter
   */
  protected buildAccessModifierFilter(accessModifier: unknown): SQL | null {
    if (accessModifier === undefined) return null;
    return sql`${this.schema.accessModifier} = ${normalizeStringFilter(accessModifier)}`;
  }

  /**
   * Build all common conditions (access control + ID + booleans)
   *
   * This combines all the generic filters that apply to any access-controlled entity.
   * Subclasses should call this and add entity-specific conditions.
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID (optional — falls back to system-public-only)
   * @returns Array of SQL conditions
   */
  public buildCommonConditions(filter: Partial<TFilter>, orgId?: string): SQL[] {
    const conditions: SQL[] = [];

    // Access control (multi-tenant) — handles accessModifier internally
    conditions.push(...this.buildAccessControl(filter, orgId));

    // ID filter with prefix matching
    const idCondition = this.buildIdFilter(filter.id);
    if (idCondition) conditions.push(idCondition);

    // Boolean filters
    conditions.push(...this.buildBooleanFilters(filter));

    return conditions;
  }
}
