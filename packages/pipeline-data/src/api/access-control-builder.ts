import { eq, or, sql, SQL } from 'drizzle-orm';

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Access control behavior based on accessModifier filter
 */
export type AccessBehavior = 'public' | 'private' | 'org-and-public';

/**
 * Determine access behavior from filter
 */
export function getAccessBehavior(accessModifier?: string): AccessBehavior {
  if (accessModifier === undefined) {
    return 'org-and-public';
  }

  const normalized = typeof accessModifier === 'string'
    ? accessModifier.toLowerCase()
    : String(accessModifier).toLowerCase();

  if (normalized === 'public') return 'public';
  if (normalized === 'private') return 'private';
  return 'org-and-public';
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
  id: any;
  orgId: any;
  accessModifier: any;
  isDefault: any;
  isActive: any;
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
   * Build access control conditions based on accessModifier filter
   *
   * Behavior:
   * - accessModifier='public': Only public records
   * - accessModifier='private': Only user's org records
   * - accessModifier not set: User's org records + public records
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID
   * @returns Array of SQL conditions for access control
   */
  protected buildAccessControl(filter: Partial<TFilter>, orgId: string): SQL[] {
    const conditions: SQL[] = [];
    const normalizedOrgId = orgId.toLowerCase();
    const accessBehavior = getAccessBehavior(filter.accessModifier as string | undefined);

    switch (accessBehavior) {
      case 'public':
        conditions.push(eq(this.schema.accessModifier, 'public'));
        break;
      case 'private':
        conditions.push(eq(this.schema.orgId, normalizedOrgId));
        break;
      default:
        conditions.push(
          or(
            eq(this.schema.orgId, normalizedOrgId),
            eq(this.schema.accessModifier, 'public'),
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
      return sql`${this.schema.id}::text LIKE ${idString + '%'}`;
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
   * Build all common conditions (access control + ID + booleans + accessModifier)
   *
   * This combines all the generic filters that apply to any access-controlled entity.
   * Subclasses should call this and add entity-specific conditions.
   *
   * @param filter - Filter criteria
   * @param orgId - User's organization ID
   * @returns Array of SQL conditions
   */
  public buildCommonConditions(filter: Partial<TFilter>, orgId: string): SQL[] {
    const conditions: SQL[] = [];

    // Access control (multi-tenant)
    conditions.push(...this.buildAccessControl(filter, orgId));

    // ID filter with prefix matching
    const idCondition = this.buildIdFilter(filter.id);
    if (idCondition) conditions.push(idCondition);

    // Boolean filters
    conditions.push(...this.buildBooleanFilters(filter));

    // Explicit accessModifier filter
    const accessModifierCondition = this.buildAccessModifierFilter(filter.accessModifier);
    if (accessModifierCondition) conditions.push(accessModifierCondition);

    return conditions;
  }
}
