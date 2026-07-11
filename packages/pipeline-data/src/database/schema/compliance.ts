// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AccessModifier, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { boolean, integer, varchar, pgTable, text, timestamp, uuid, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ========================================
// Compliance Service Tables
// ========================================

/**
 * Compliance rule severity levels.
 */
export type RuleSeverity = 'warning' | 'error' | 'critical';

/**
 * Compliance rule target entity types.
 */
export type RuleTarget = 'plugin' | 'pipeline';

/**
 * Compliance rule operators for field evaluation.
 */
export type RuleOperator =
  | 'eq' | 'neq'
  | 'contains' | 'notContains'
  | 'regex'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'notIn'
  | 'exists' | 'notExists' | 'notEmpty'
  | 'countGt' | 'countLt'
  | 'lengthGt' | 'lengthLt';

/**
 * Cross-field condition mode for multi-condition rules.
 */
export type RuleConditionMode = 'all' | 'any';

/**
 * Rule scope  org-level or published (system org only, opt-in via subscription).
 */
export type RuleScope = 'org' | 'published';

/**
 * A single condition in a cross-field rule.
 */
export interface RuleCondition {
  field?: string;
  operator?: RuleOperator;
  value?: unknown;
  dependsOnRule?: string; // rule ID  only evaluate if referenced rule passed
}

/**
 * Compliance policies group rules into named sets that can be enabled/disabled together.
 *
 * @table compliance_policies
 */
export const compliancePolicy = pgTable('compliance_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).default(SYSTEM_ORG_ID).notNull(),
  createdBy: text('created_by').default('system').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').default('system').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),

  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  version: varchar('version', { length: 50 }).default('1.0.0').notNull(),
  isTemplate: boolean('is_template').default(false).notNull(),

  accessModifier: varchar('access_modifier', { length: 10 })
    .$type<AccessModifier>().default('private' as AccessModifier).notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
}, (table) => ({
  orgActiveIdx: index('compliance_policy_org_active_idx').on(table.orgId, table.isActive),
  templateIdx: index('compliance_policy_template_idx').on(table.isTemplate),
  nameOrgVersionUnique: uniqueIndex('compliance_policy_name_org_version_unique')
    .on(table.orgId, table.name, table.version),
}));

/**
 * Compliance rules define individual checks against plugin/pipeline attributes.
 *
 * @table compliance_rules
 */
export const complianceRule = pgTable('compliance_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).default(SYSTEM_ORG_ID).notNull(),
  createdBy: text('created_by').default('system').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').default('system').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),

  // Rule identity
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  policyId: uuid('policy_id').references(() => compliancePolicy.id, { onDelete: 'set null' }),
  priority: integer('priority').default(0).notNull(),
  target: varchar('target', { length: 20 }).$type<RuleTarget>().notNull(),
  severity: varchar('severity', { length: 10 }).$type<RuleSeverity>().default('error').notNull(),

  // Categorization
  tags: jsonb('tags').$type<string[]>().default([]).notNull(),

  // Scheduling
  effectiveFrom: timestamp('effective_from', { withTimezone: true }),
  effectiveUntil: timestamp('effective_until', { withTimezone: true }),

  // Scope
  scope: varchar('scope', { length: 10 }).$type<RuleScope>().default('org').notNull(),

  // Forking  tracks which published rule this org rule was copied from
  forkedFromRuleId: uuid('forked_from_rule_id'),

  // Notification override
  suppressNotification: boolean('suppress_notification').default(false).notNull(),

  // Org → team hierarchy: when true, this (parent-org) rule is also enforced on
  // descendant team orgs during their compliance evaluation.
  propagateToChildren: boolean('propagate_to_children').default(false).notNull(),

  // Single-field condition
  field: varchar('field', { length: 100 }),
  operator: varchar('operator', { length: 20 }).$type<RuleOperator>(),
  value: jsonb('value'),

  // Cross-field conditions (overrides single-field when present)
  conditions: jsonb('conditions').$type<RuleCondition[]>(),
  conditionMode: varchar('condition_mode', { length: 5 }).$type<RuleConditionMode>().default('all'),

  // Access and visibility
  accessModifier: varchar('access_modifier', { length: 10 })
    .$type<AccessModifier>().default('private' as AccessModifier).notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
}, (table) => ({
  orgTargetActiveIdx: index('compliance_rule_org_target_active_idx')
    .on(table.orgId, table.target, table.isActive),
  orgPolicyIdx: index('compliance_rule_org_policy_idx').on(table.orgId, table.policyId),
  priorityIdx: index('compliance_rule_priority_idx').on(table.priority),
  scopeIdx: index('compliance_rule_scope_idx').on(table.scope),
  effectiveFromIdx: index('compliance_rule_effective_from_idx').on(table.effectiveFrom),
  nameOrgUnique: uniqueIndex('compliance_rule_name_org_unique').on(table.orgId, table.name),
}));

/**
 * Tracks every change to compliance rules for versioning and rollback.
 *
 * @table compliance_rule_history
 */
export const complianceRuleHistory = pgTable('compliance_rule_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  ruleId: uuid('rule_id').notNull().references(() => complianceRule.id, { onDelete: 'cascade' }),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  changeType: varchar('change_type', { length: 20 }).notNull(), // created | updated | deleted | restored
  previousState: jsonb('previous_state'), // full rule snapshot before change
  changedBy: text('changed_by').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  ruleChangedAtIdx: index('compliance_rule_history_rule_changed_idx')
    .on(table.ruleId, table.changedAt),
  orgChangedAtIdx: index('compliance_rule_history_org_changed_idx')
    .on(table.orgId, table.changedAt),
  ruleIdIdx: index('compliance_rule_history_rule_id_idx')
    .on(table.ruleId),
}));

/**
 * Compliance audit log  stores every compliance check result.
 *
 * @table compliance_audit_log
 */
export const complianceAuditLog = pgTable('compliance_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  userId: text('user_id').notNull(),
  target: varchar('target', { length: 20 }).$type<RuleTarget>().notNull(),
  action: varchar('action', { length: 20 }).notNull(), // upload | deploy | create | update | scan
  entityId: varchar('entity_id', { length: 255 }),
  entityName: varchar('entity_name', { length: 255 }),
  result: varchar('result', { length: 10 }).notNull(), // pass | warn | block
  violations: jsonb('violations').$type<Record<string, unknown>[]>().default([]),
  ruleCount: integer('rule_count').notNull(),
  scanId: uuid('scan_id'), // groups entries from the same bulk scan
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgCreatedAtIdx: index('compliance_audit_org_created_idx').on(table.orgId, table.createdAt),
  // DESC variant for the dominant "latest audit events per org" query
  // pattern (audit log UIs sort newest-first). Postgres can use the asc
  // index for desc scans, but a matching DESC index lets index-only scans
  // satisfy `ORDER BY created_at DESC LIMIT n` without a reverse step.
  // MIGRATION REQUIRED: run `pnpm drizzle-kit generate` after pulling.
  orgCreatedAtDescIdx: index('compliance_audit_org_created_desc_idx')
    .on(table.orgId, sql`${table.createdAt} DESC`),
  orgTargetResultIdx: index('compliance_audit_org_target_result_idx')
    .on(table.orgId, table.target, table.result),
  scanIdIdx: index('compliance_audit_scan_id_idx').on(table.scanId),
}));

/**
 * Per-entity exemptions from specific compliance rules.
 *
 * @table compliance_exemptions
 */
export const complianceExemption = pgTable('compliance_exemptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  ruleId: uuid('rule_id').notNull().references(() => complianceRule.id, { onDelete: 'cascade' }),
  entityType: varchar('entity_type', { length: 20 }).$type<RuleTarget>().notNull(),
  entityId: uuid('entity_id').notNull(),
  entityName: varchar('entity_name', { length: 255 }),
  reason: text('reason').notNull(),
  approvedBy: text('approved_by'),
  rejectionReason: text('rejection_reason'),
  status: varchar('status', { length: 20 }).default('pending').notNull(), // pending | approved | rejected | expired
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgRuleEntityUnique: uniqueIndex('compliance_exemption_org_rule_entity_unique')
    .on(table.orgId, table.ruleId, table.entityId),
  orgStatusIdx: index('compliance_exemption_org_status_idx').on(table.orgId, table.status),
  expiresAtIdx: index('compliance_exemption_expires_at_idx').on(table.expiresAt),
  entityIdIdx: index('compliance_exemption_entity_id_idx').on(table.entityId),
}));

/**
 * Tracks which orgs have opted into system-org published compliance rules.
 *
 * @table compliance_rule_subscriptions
 */
export const complianceRuleSubscription = pgTable('compliance_rule_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  ruleId: uuid('rule_id').notNull().references(() => complianceRule.id, { onDelete: 'cascade' }),
  subscribedBy: text('subscribed_by').notNull(),
  subscribedAt: timestamp('subscribed_at', { withTimezone: true }).defaultNow().notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  pinnedVersion: jsonb('pinned_version').$type<Record<string, unknown>>(),
  unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
  unsubscribedBy: text('unsubscribed_by'),
}, (table) => ({
  orgRuleUnique: uniqueIndex('compliance_rule_sub_org_rule_unique').on(table.orgId, table.ruleId),
  orgActiveIdx: index('compliance_rule_sub_org_active_idx').on(table.orgId, table.isActive),
  ruleIdx: index('compliance_rule_sub_rule_idx').on(table.ruleId),
}));

/**
 * Bulk compliance scans  tracks scheduled and on-demand scans.
 *
 * @table compliance_scans
 */
export const complianceScan = pgTable('compliance_scans', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  target: varchar('target', { length: 20 }).notNull(), // plugin | pipeline | all
  filter: jsonb('filter'), // optional entity filter for partial scans
  status: varchar('status', { length: 20 }).default('pending').notNull(), // pending | running | completed | failed | cancelled
  triggeredBy: varchar('triggered_by', { length: 20 }).notNull(), // manual | scheduled | rule-change | rule-dry-run
  userId: text('user_id').notNull(),
  totalEntities: integer('total_entities').default(0).notNull(),
  processedEntities: integer('processed_entities').default(0).notNull(),
  passCount: integer('pass_count').default(0).notNull(),
  warnCount: integer('warn_count').default(0).notNull(),
  blockCount: integer('block_count').default(0).notNull(),
  // True when the scan stopped early at a configured per-scan cap (so the
  // counts above represent a subset, not the full entity universe). Surfaced
  // in the scan-status UI so users know whether to widen the filter.
  // MIGRATION REQUIRED: run `pnpm drizzle-kit generate` after pulling.
  truncated: boolean('truncated').default(false).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: text('cancelled_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgCreatedAtIdx: index('compliance_scan_org_created_idx').on(table.orgId, table.createdAt),
  orgStatusIdx: index('compliance_scan_org_status_idx').on(table.orgId, table.status),
}));

/**
 * Cron-based recurring scan schedules.
 *
 * @table compliance_scan_schedules
 */
export const complianceScanSchedule = pgTable('compliance_scan_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  target: varchar('target', { length: 20 }).notNull(), // plugin | pipeline | all
  cronExpression: varchar('cron_expression', { length: 100 }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  activeNextRunIdx: index('compliance_scan_schedule_active_next_idx')
    .on(table.isActive, table.nextRunAt),
  orgIdx: index('compliance_scan_schedule_org_idx').on(table.orgId),
}));

/**
 * Per-org notification settings for compliance events.
 *
 * @table compliance_notification_preferences
 */
export const complianceNotificationPreference = pgTable('compliance_notification_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull().unique(),
  notifyOnBlock: boolean('notify_on_block').default(true).notNull(),
  notifyOnWarning: boolean('notify_on_warning').default(false).notNull(),
  // Opt-in email delivery (to `targetUsers`, or all org admins when null).
  emailEnabled: boolean('email_enabled').default(false).notNull(),
  digestMode: varchar('digest_mode', { length: 20 }).default('immediate').notNull(), // immediate | daily | weekly
  digestSchedule: varchar('digest_schedule', { length: 100 }),
  lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
  targetUsers: jsonb('target_users').$type<string[]>(), // null = all org admins
  webhookUrl: varchar('webhook_url', { length: 500 }),
  webhookSecret: varchar('webhook_secret', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Log of all compliance notifications sent.
 *
 * @table compliance_notification_log
 */
export const complianceNotificationLog = pgTable('compliance_notification_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  channel: varchar('channel', { length: 20 }).notNull(), // in-app | webhook | digest
  status: varchar('status', { length: 20 }).notNull(), // sent | failed | pending
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  webhookResponseCode: integer('webhook_response_code'),
  webhookError: text('webhook_error'),
  retryCount: integer('retry_count').default(0).notNull(),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  relatedAuditId: uuid('related_audit_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgCreatedAtIdx: index('compliance_notification_org_created_idx')
    .on(table.orgId, table.createdAt),
  statusRetryIdx: index('compliance_notification_status_retry_idx')
    .on(table.status, table.nextRetryAt),
  relatedAuditIdx: index('compliance_notification_related_audit_idx')
    .on(table.relatedAuditId),
}));

/**
 * Compliance-specific RBAC roles.
 *
 * @table compliance_roles
 */
export type ComplianceRoleType = 'compliance-viewer' | 'compliance-editor' | 'compliance-admin';

export const complianceRole = pgTable('compliance_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  userId: text('user_id').notNull(),
  role: varchar('role', { length: 30 }).$type<ComplianceRoleType>().notNull(),
  grantedBy: text('granted_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgUserUnique: uniqueIndex('compliance_role_org_user_unique').on(table.orgId, table.userId),
  orgRoleIdx: index('compliance_role_org_role_idx').on(table.orgId, table.role),
}));

/**
 * Generated compliance reports.
 *
 * @table compliance_reports
 */
export const complianceReport = pgTable('compliance_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  reportType: varchar('report_type', { length: 30 }).notNull(), // summary | detailed | audit-trail | comparison
  target: varchar('target', { length: 20 }).notNull(), // plugin | pipeline | all
  dateFrom: timestamp('date_from', { withTimezone: true }),
  dateTo: timestamp('date_to', { withTimezone: true }),
  compareFrom: timestamp('compare_from', { withTimezone: true }),
  compareTo: timestamp('compare_to', { withTimezone: true }),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  format: varchar('format', { length: 10 }).default('json').notNull(), // json | csv
  generatedBy: text('generated_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgCreatedAtIdx: index('compliance_report_org_created_idx').on(table.orgId, table.createdAt),
}));

/**
 * Cron-based recurring report generation schedules.
 *
 * @table compliance_report_schedules
 */
export const complianceReportSchedule = pgTable('compliance_report_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  reportType: varchar('report_type', { length: 30 }).notNull(), // summary | detailed
  target: varchar('target', { length: 20 }).notNull(), // plugin | pipeline | all
  format: varchar('format', { length: 10 }).default('json').notNull(),
  cronExpression: varchar('cron_expression', { length: 100 }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  deliverTo: jsonb('deliver_to').$type<string[]>().default([]).notNull(), // userIds to notify
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  activeNextRunIdx: index('compliance_report_schedule_active_next_idx')
    .on(table.isActive, table.nextRunAt),
  orgIdx: index('compliance_report_schedule_org_idx').on(table.orgId),
}));

// Compliance types
export type CompliancePolicy = typeof compliancePolicy.$inferSelect;
export type CompliancePolicyInsert = typeof compliancePolicy.$inferInsert;

export type ComplianceRule = typeof complianceRule.$inferSelect;
export type ComplianceRuleInsert = typeof complianceRule.$inferInsert;

export type ComplianceRuleHistory = typeof complianceRuleHistory.$inferSelect;
export type ComplianceRuleHistoryInsert = typeof complianceRuleHistory.$inferInsert;

export type ComplianceAuditLog = typeof complianceAuditLog.$inferSelect;
export type ComplianceAuditLogInsert = typeof complianceAuditLog.$inferInsert;

export type ComplianceExemption = typeof complianceExemption.$inferSelect;
export type ComplianceExemptionInsert = typeof complianceExemption.$inferInsert;

export type ComplianceRuleSubscription = typeof complianceRuleSubscription.$inferSelect;
export type ComplianceRuleSubscriptionInsert = typeof complianceRuleSubscription.$inferInsert;

export type ComplianceScan = typeof complianceScan.$inferSelect;
export type ComplianceScanInsert = typeof complianceScan.$inferInsert;

export type ComplianceScanSchedule = typeof complianceScanSchedule.$inferSelect;
export type ComplianceScanScheduleInsert = typeof complianceScanSchedule.$inferInsert;

export type ComplianceNotificationPreference = typeof complianceNotificationPreference.$inferSelect;
export type ComplianceNotificationPreferenceInsert = typeof complianceNotificationPreference.$inferInsert;

export type ComplianceNotificationLog = typeof complianceNotificationLog.$inferSelect;
export type ComplianceNotificationLogInsert = typeof complianceNotificationLog.$inferInsert;

export type ComplianceRole = typeof complianceRole.$inferSelect;
export type ComplianceRoleInsert = typeof complianceRole.$inferInsert;

export type ComplianceReport = typeof complianceReport.$inferSelect;
export type ComplianceReportInsert = typeof complianceReport.$inferInsert;

export type ComplianceReportSchedule = typeof complianceReportSchedule.$inferSelect;
export type ComplianceReportScheduleInsert = typeof complianceReportSchedule.$inferInsert;
