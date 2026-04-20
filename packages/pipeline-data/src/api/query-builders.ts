// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { eq, ilike, isNull, or, gte, lte, SQL } from 'drizzle-orm';
import {
  AccessControlQueryBuilder,
  buildJsonbKeywordCondition,
  escapeLikeWildcards,
  normalizeStringFilter,
  parseBooleanFilter,
} from './access-control-builder';
import {
  MessageFilter,
  PipelineFilter,
  PluginFilter,
  CompliancePolicyFilter,
  ComplianceRuleFilter,
  ComplianceExemptionFilter,
  ComplianceAuditFilter,
  ComplianceScanFilter,
  ComplianceRuleSubscriptionFilter,
} from '../core/query-filters';
import {
  schema,
  type MessagePriority,
  type MessageType,
  type RuleTarget,
  type RuleSeverity,
  type RuleScope,
} from '../database/drizzle-schema';

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
    conditions.push(buildJsonbKeywordCondition(schema.pipeline.keywords, normalizeStringFilter(filter.keyword)));
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
    conditions.push(buildJsonbKeywordCondition(schema.plugin.keywords, normalizeStringFilter(filter.keyword)));
  }

  if (filter.category !== undefined) {
    conditions.push(eq(schema.plugin.category, filter.category as string));
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

// ========================================
// Compliance Query Builders
// ========================================

/**
 * Build SQL conditions for compliance policy queries.
 * Org-scoped: always filters by orgId.
 */
export function buildCompliancePolicyConditions(
  filter: Partial<CompliancePolicyFilter>,
  orgId?: string,
): SQL[] {
  const conditions: SQL[] = [];

  if (orgId) {
    conditions.push(eq(schema.compliancePolicy.orgId, orgId));
  }

  if (filter.id !== undefined) {
    const id = typeof filter.id === 'string' ? filter.id : filter.id[0];
    conditions.push(eq(schema.compliancePolicy.id, id));
  }

  if (filter.name !== undefined) {
    conditions.push(ilike(schema.compliancePolicy.name, `%${escapeLikeWildcards(normalizeStringFilter(filter.name))}%`));
  }

  if (filter.isTemplate !== undefined) {
    conditions.push(eq(schema.compliancePolicy.isTemplate, parseBooleanFilter(filter.isTemplate)));
  }

  if (filter.isActive !== undefined) {
    conditions.push(eq(schema.compliancePolicy.isActive, parseBooleanFilter(filter.isActive)));
  } else {
    conditions.push(eq(schema.compliancePolicy.isActive, true));
  }

  return conditions;
}

/**
 * Build SQL conditions for compliance rule queries.
 * Returns only the requesting org's own rules (org-scoped).
 */
export function buildComplianceRuleConditions(
  filter: Partial<ComplianceRuleFilter>,
  orgId?: string,
): SQL[] {
  const conditions: SQL[] = [];

  if (orgId) {
    conditions.push(eq(schema.complianceRule.orgId, orgId));
  }

  if (filter.id !== undefined) {
    const id = typeof filter.id === 'string' ? filter.id : filter.id[0];
    conditions.push(eq(schema.complianceRule.id, id));
  }

  if (filter.name !== undefined) {
    conditions.push(ilike(schema.complianceRule.name, `%${escapeLikeWildcards(normalizeStringFilter(filter.name))}%`));
  }

  if (filter.policyId !== undefined) {
    conditions.push(eq(schema.complianceRule.policyId, filter.policyId));
  }

  if (filter.target !== undefined) {
    conditions.push(eq(schema.complianceRule.target, filter.target as RuleTarget));
  }

  if (filter.severity !== undefined) {
    conditions.push(eq(schema.complianceRule.severity, filter.severity as RuleSeverity));
  }

  if (filter.scope !== undefined) {
    conditions.push(eq(schema.complianceRule.scope, filter.scope as RuleScope));
  }

  if (filter.tag !== undefined) {
    conditions.push(buildJsonbKeywordCondition(schema.complianceRule.tags, normalizeStringFilter(filter.tag)));
  }

  if (filter.isActive !== undefined) {
    conditions.push(eq(schema.complianceRule.isActive, parseBooleanFilter(filter.isActive)));
  } else if (filter.id === undefined) {
    // Only default to active=true for list queries, not single-entity lookups by ID
    conditions.push(eq(schema.complianceRule.isActive, true));
  }

  return conditions;
}

/**
 * Build SQL conditions for browsing the published rules catalog.
 * Only returns system-org published rules.
 */
export function buildPublishedRuleCatalogConditions(
  filter: Partial<ComplianceRuleFilter>,
): SQL[] {
  const conditions: SQL[] = [];

  // Only scope='published' is needed — the create endpoint already enforces
  // that only the system org can create published rules, so filtering by orgId
  // is redundant and breaks when the system org's DB ID differs from SYSTEM_ORG_ID.
  conditions.push(eq(schema.complianceRule.scope, 'published' as RuleScope));

  if (filter.name !== undefined) {
    conditions.push(ilike(schema.complianceRule.name, `%${escapeLikeWildcards(normalizeStringFilter(filter.name))}%`));
  }

  if (filter.target !== undefined) {
    conditions.push(eq(schema.complianceRule.target, filter.target as RuleTarget));
  }

  if (filter.severity !== undefined) {
    conditions.push(eq(schema.complianceRule.severity, filter.severity as RuleSeverity));
  }

  if (filter.tag !== undefined) {
    conditions.push(buildJsonbKeywordCondition(schema.complianceRule.tags, normalizeStringFilter(filter.tag)));
  }

  if (filter.isActive !== undefined) {
    conditions.push(eq(schema.complianceRule.isActive, parseBooleanFilter(filter.isActive)));
  } else {
    conditions.push(eq(schema.complianceRule.isActive, true));
  }

  return conditions;
}

/**
 * Build SQL conditions for compliance rule subscription queries.
 */
export function buildComplianceRuleSubscriptionConditions(
  filter: Partial<ComplianceRuleSubscriptionFilter>,
  orgId?: string,
): SQL[] {
  const conditions: SQL[] = [];

  if (orgId) {
    conditions.push(eq(schema.complianceRuleSubscription.orgId, orgId));
  }

  if (filter.ruleId !== undefined) {
    conditions.push(eq(schema.complianceRuleSubscription.ruleId, filter.ruleId));
  }

  if (filter.isActive !== undefined) {
    conditions.push(eq(schema.complianceRuleSubscription.isActive, parseBooleanFilter(filter.isActive)));
  } else {
    conditions.push(eq(schema.complianceRuleSubscription.isActive, true));
  }

  return conditions;
}

/**
 * Build SQL conditions for compliance exemption queries.
 */
export function buildComplianceExemptionConditions(
  filter: Partial<ComplianceExemptionFilter>,
  orgId?: string,
): SQL[] {
  const conditions: SQL[] = [];

  if (orgId) {
    conditions.push(eq(schema.complianceExemption.orgId, orgId));
  }

  if (filter.ruleId !== undefined) {
    conditions.push(eq(schema.complianceExemption.ruleId, filter.ruleId));
  }

  if (filter.entityType !== undefined) {
    conditions.push(eq(schema.complianceExemption.entityType, filter.entityType as RuleTarget));
  }

  if (filter.entityId !== undefined) {
    conditions.push(eq(schema.complianceExemption.entityId, filter.entityId));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(schema.complianceExemption.status, filter.status));
  }

  return conditions;
}

/**
 * Build SQL conditions for compliance audit log queries.
 */
export function buildComplianceAuditConditions(
  filter: Partial<ComplianceAuditFilter>,
  orgId?: string,
): SQL[] {
  const conditions: SQL[] = [];

  if (orgId) {
    conditions.push(eq(schema.complianceAuditLog.orgId, orgId));
  }

  if (filter.target !== undefined) {
    conditions.push(eq(schema.complianceAuditLog.target, filter.target as RuleTarget));
  }

  if (filter.action !== undefined) {
    conditions.push(eq(schema.complianceAuditLog.action, filter.action));
  }

  if (filter.result !== undefined) {
    conditions.push(eq(schema.complianceAuditLog.result, filter.result));
  }

  if (filter.scanId !== undefined) {
    conditions.push(eq(schema.complianceAuditLog.scanId, filter.scanId));
  }

  if (filter.dateFrom !== undefined) {
    conditions.push(gte(schema.complianceAuditLog.createdAt, new Date(filter.dateFrom)));
  }

  if (filter.dateTo !== undefined) {
    conditions.push(lte(schema.complianceAuditLog.createdAt, new Date(filter.dateTo)));
  }

  return conditions;
}

/**
 * Build SQL conditions for compliance scan queries.
 */
export function buildComplianceScanConditions(
  filter: Partial<ComplianceScanFilter>,
  orgId?: string,
): SQL[] {
  const conditions: SQL[] = [];

  if (orgId) {
    conditions.push(eq(schema.complianceScan.orgId, orgId));
  }

  if (filter.target !== undefined) {
    conditions.push(eq(schema.complianceScan.target, filter.target));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(schema.complianceScan.status, filter.status));
  }

  if (filter.triggeredBy !== undefined) {
    conditions.push(eq(schema.complianceScan.triggeredBy, filter.triggeredBy));
  }

  return conditions;
}
