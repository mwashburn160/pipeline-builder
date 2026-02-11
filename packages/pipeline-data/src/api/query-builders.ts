import { eq, SQL } from 'drizzle-orm';
import {
  AccessControlQueryBuilder,
  normalizeStringFilter,
} from './access-control-builder';
import { PipelineFilter, PluginFilter } from '../core/query-filters';
import { schema } from '../database/drizzle-schema';

// Query builder instances
const pipelineBuilder = new AccessControlQueryBuilder(schema.pipeline);
const pluginBuilder = new AccessControlQueryBuilder(schema.plugin);

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
  // Use generic builder for common conditions (access control, ID, booleans, accessModifier)
  const conditions = pipelineBuilder.buildCommonConditions(filter, orgId);

  // Add pipeline-specific filters
  if (filter.project !== undefined) {
    conditions.push(eq(schema.pipeline.project, normalizeStringFilter(filter.project)));
  }

  if (filter.organization !== undefined) {
    conditions.push(eq(schema.pipeline.organization, normalizeStringFilter(filter.organization)));
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
  // Use generic builder for common conditions (access control, ID, booleans, accessModifier)
  const conditions = pluginBuilder.buildCommonConditions(filter, orgId);

  // Add plugin-specific filters
  if (filter.orgId !== undefined) {
    conditions.push(eq(schema.plugin.orgId, normalizeStringFilter(filter.orgId)));
  }

  if (filter.name !== undefined) {
    conditions.push(eq(schema.plugin.name, normalizeStringFilter(filter.name)));
  }

  if (filter.version !== undefined) {
    conditions.push(eq(schema.plugin.version, filter.version as string));
  }

  if (filter.imageTag !== undefined) {
    conditions.push(eq(schema.plugin.imageTag, filter.imageTag as string));
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
