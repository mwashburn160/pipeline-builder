import { eq, or, sql, SQL } from 'drizzle-orm';
import { PipelineFilter, PluginFilter } from '../core/query-filters';
import { schema } from '../database/drizzle-schema';

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
 * Build SQL conditions for pipeline queries
 *
 * Access control behavior:
 * - accessModifier='public': Only public records
 * - accessModifier='private': Only user's org records
 * - accessModifier not set: User's org records + public records
 *
 * @param filter - Pipeline filter criteria
 * @param orgId - User's organization ID
 * @returns Array of SQL conditions
 */
export function buildPipelineConditions(
  filter: Partial<PipelineFilter>,
  orgId: string,
): SQL[] {
  const conditions: SQL[] = [];
  const normalizedOrgId = orgId.toLowerCase();

  // Access control
  const accessBehavior = getAccessBehavior(filter.accessModifier as string | undefined);

  switch (accessBehavior) {
    case 'public':
      conditions.push(eq(schema.pipeline.accessModifier, 'public'));
      break;
    case 'private':
      conditions.push(eq(schema.pipeline.orgId, normalizedOrgId));
      break;
    default:
      conditions.push(
        or(
          eq(schema.pipeline.orgId, normalizedOrgId),
          eq(schema.pipeline.accessModifier, 'public'),
        )!,
      );
  }

  // ID filter (supports partial UUID prefix matching)
  if (filter.id !== undefined) {
    const id = (filter.id as string).toLowerCase();
    if (FULL_UUID.test(id)) {
      conditions.push(eq(schema.pipeline.id, id));
    } else {
      conditions.push(sql`${schema.pipeline.id}::text LIKE ${id + '%'}`);
    }
  }

  // Project filter
  if (filter.project !== undefined) {
    conditions.push(eq(schema.pipeline.project, normalizeStringFilter(filter.project)));
  }

  // Organization filter
  if (filter.organization !== undefined) {
    conditions.push(eq(schema.pipeline.organization, normalizeStringFilter(filter.organization)));
  }

  // Boolean filters
  if (filter.isDefault !== undefined) {
    conditions.push(eq(schema.pipeline.isDefault, parseBooleanFilter(filter.isDefault)));
  }

  if (filter.isActive !== undefined) {
    conditions.push(eq(schema.pipeline.isActive, parseBooleanFilter(filter.isActive)));
  }

  // Explicit accessModifier filter
  if (filter.accessModifier !== undefined) {
    conditions.push(
      sql`${schema.pipeline.accessModifier} = ${normalizeStringFilter(filter.accessModifier)}`,
    );
  }

  return conditions;
}

/**
 * Build SQL conditions for plugin queries
 *
 * Access control behavior:
 * - accessModifier='public': Only public records
 * - accessModifier='private': Only user's org records
 * - accessModifier not set: User's org records + public records
 *
 * @param filter - Plugin filter criteria
 * @param orgId - User's organization ID
 * @returns Array of SQL conditions
 */
export function buildPluginConditions(
  filter: Partial<PluginFilter>,
  orgId: string,
): SQL[] {
  const conditions: SQL[] = [];
  const normalizedOrgId = orgId.toLowerCase();

  // Access control
  const accessBehavior = getAccessBehavior(filter.accessModifier as string | undefined);

  switch (accessBehavior) {
    case 'public':
      conditions.push(eq(schema.plugin.accessModifier, 'public'));
      break;
    case 'private':
      conditions.push(eq(schema.plugin.orgId, normalizedOrgId));
      break;
    default:
      conditions.push(
        or(
          eq(schema.plugin.orgId, normalizedOrgId),
          eq(schema.plugin.accessModifier, 'public'),
        )!,
      );
  }

  // ID filter (supports partial UUID prefix matching)
  if (filter.id !== undefined) {
    const id = (filter.id as string).toLowerCase();
    if (FULL_UUID.test(id)) {
      conditions.push(eq(schema.plugin.id, id));
    } else {
      conditions.push(sql`${schema.plugin.id}::text LIKE ${id + '%'}`);
    }
  }

  // OrgId filter (explicit)
  if (filter.orgId !== undefined) {
    conditions.push(eq(schema.plugin.orgId, normalizeStringFilter(filter.orgId)));
  }

  // Name filter
  if (filter.name !== undefined) {
    conditions.push(eq(schema.plugin.name, normalizeStringFilter(filter.name)));
  }

  // Version filter
  if (filter.version !== undefined) {
    conditions.push(eq(schema.plugin.version, filter.version as string));
  }

  // Image tag filter
  if (filter.imageTag !== undefined) {
    conditions.push(eq(schema.plugin.imageTag, filter.imageTag as string));
  }

  // Boolean filters
  if (filter.isDefault !== undefined) {
    conditions.push(eq(schema.plugin.isDefault, parseBooleanFilter(filter.isDefault)));
  }

  if (filter.isActive !== undefined) {
    conditions.push(eq(schema.plugin.isActive, parseBooleanFilter(filter.isActive)));
  }

  // Explicit accessModifier filter
  if (filter.accessModifier !== undefined) {
    conditions.push(
      sql`${schema.plugin.accessModifier} = ${normalizeStringFilter(filter.accessModifier)}`,
    );
  }

  return conditions;
}

/**
 * Parse pagination parameters from filter
 */
export function parsePagination(
  filter: { limit?: number | string; offset?: number | string },
  defaultLimit: number = 50,
): { limit: number; offset: number } {
  const limit = filter.limit ? parseInt(String(filter.limit)) : defaultLimit;
  const offset = filter.offset ? parseInt(String(filter.offset)) : 0;

  return { limit, offset };
}
