import { SYSTEM_ORG_ID } from '@mwashburn160/api-core';
import { eq, ilike, isNull, or, sql, SQL } from 'drizzle-orm';
import {
  AccessControlQueryBuilder,
  escapeLikeWildcards,
  normalizeStringFilter,
  parseBooleanFilter,
} from './access-control-builder';
import { MessageFilter, PipelineFilter, PluginFilter } from '../core/query-filters';
import { schema, type MessagePriority, type MessageType } from '../database/drizzle-schema';

// Query builder instances
const pipelineBuilder = new AccessControlQueryBuilder(schema.pipeline);
const pluginBuilder = new AccessControlQueryBuilder(schema.plugin);

/**
 * Build SQL conditions for pipeline queries
 *
 * Access control behavior:
 * - No orgId: system org public only
 * - accessModifier='private': Own org private only
 * - accessModifier='public': Own org public only
 * - No accessModifier (default): Own org public + system org public
 *
 * @param filter - Pipeline filter criteria
 * @param orgId - User's organization ID (optional — anonymous gets system public only)
 * @returns Array of SQL conditions
 */
export function buildPipelineConditions(
  filter: Partial<PipelineFilter>,
  orgId?: string,
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

  if (filter.keyword !== undefined) {
    const escaped = escapeLikeWildcards(normalizeStringFilter(filter.keyword));
    conditions.push(sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${schema.pipeline.keywords}) AS kw WHERE lower(kw) LIKE ${'%' + escaped + '%'})`);
  }

  return conditions;
}

/**
 * Build SQL conditions for plugin queries
 *
 * Access control behavior:
 * - No orgId: system org public only
 * - accessModifier='private': Own org private only
 * - accessModifier='public': Own org public only
 * - No accessModifier (default): Own org public + system org public
 *
 * @param filter - Plugin filter criteria
 * @param orgId - User's organization ID (optional — anonymous gets system public only)
 * @returns Array of SQL conditions
 */
export function buildPluginConditions(
  filter: Partial<PluginFilter>,
  orgId?: string,
): SQL[] {
  // Use generic builder for common conditions (access control, ID, booleans, accessModifier)
  const conditions = pluginBuilder.buildCommonConditions(filter, orgId);

  // Add plugin-specific filters
  if (filter.orgId !== undefined) {
    conditions.push(eq(schema.plugin.orgId, normalizeStringFilter(filter.orgId)));
  }

  if (filter.name !== undefined) {
    conditions.push(ilike(schema.plugin.name, `%${escapeLikeWildcards(normalizeStringFilter(filter.name))}%`));
  }

  if (filter.version !== undefined) {
    conditions.push(eq(schema.plugin.version, filter.version as string));
  }

  if (filter.imageTag !== undefined) {
    conditions.push(eq(schema.plugin.imageTag, filter.imageTag as string));
  }

  if (filter.keyword !== undefined) {
    const escaped = escapeLikeWildcards(normalizeStringFilter(filter.keyword));
    conditions.push(sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${schema.plugin.keywords}) AS kw WHERE lower(kw) LIKE ${'%' + escaped + '%'})`);
  }

  return conditions;
}

/**
 * Build SQL conditions for message queries.
 *
 * Custom access control for messages:
 * - Messages are visible to the sender org (orgId) OR the recipient org (recipientOrgId)
 * - Broadcast announcements (recipientOrgId = '*') are visible to all orgs
 * - System org can see all messages
 *
 * @param filter - Message filter criteria
 * @param orgId - User's organization ID
 * @returns Array of SQL conditions
 */
export function buildMessageConditions(
  filter: Partial<MessageFilter>,
  orgId: string,
): SQL[] {
  const conditions: SQL[] = [];
  const normalizedOrgId = orgId.toLowerCase();

  // Custom access control: sender OR recipient OR broadcast
  if (normalizedOrgId === SYSTEM_ORG_ID) {
    // System org can see all messages
  } else {
    conditions.push(
      or(
        eq(schema.message.orgId, normalizedOrgId),
        eq(schema.message.recipientOrgId, normalizedOrgId),
        eq(schema.message.recipientOrgId, '*'),
      )!,
    );
  }

  // Active filter (default to active only)
  if (filter.isActive !== undefined) {
    conditions.push(eq(schema.message.isActive, parseBooleanFilter(filter.isActive)));
  } else {
    conditions.push(eq(schema.message.isActive, true));
  }

  // Thread filter (null = root messages only via IS NULL)
  if (filter.threadId !== undefined) {
    if (filter.threadId === null) {
      conditions.push(isNull(schema.message.threadId));
    } else {
      conditions.push(eq(schema.message.threadId, filter.threadId));
    }
  }

  // Recipient org filter
  if (filter.recipientOrgId !== undefined) {
    conditions.push(eq(schema.message.recipientOrgId, normalizeStringFilter(filter.recipientOrgId)));
  }

  // Message type filter
  if (filter.messageType !== undefined) {
    conditions.push(eq(schema.message.messageType, filter.messageType as MessageType));
  }

  // Read status filter
  if (filter.isRead !== undefined) {
    conditions.push(eq(schema.message.isRead, parseBooleanFilter(filter.isRead)));
  }

  // Priority filter
  if (filter.priority !== undefined) {
    conditions.push(eq(schema.message.priority, filter.priority as MessagePriority));
  }

  // ID filter
  if (filter.id !== undefined) {
    const id = typeof filter.id === 'string' ? filter.id : filter.id[0];
    conditions.push(eq(schema.message.id, id));
  }

  return conditions;
}
