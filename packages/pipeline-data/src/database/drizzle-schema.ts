import { AccessModifier, ComputeType, PluginType, MetaDataType } from '@mwashburn160/api-core';
import { sql } from 'drizzle-orm';
import { boolean, integer, varchar, pgTable, text, timestamp, uuid, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';

/**
 * Pipeline builder configuration properties stored in database.
 * Mirrors the canonical BuilderProps from pipeline-core (JSON-serializable form).
 */
export interface PipelineBuilderConfig {
  readonly project: string;
  readonly organization: string;
  readonly pipelineName?: string;
  readonly global?: MetaDataType;
  readonly synth: Record<string, unknown>;
  readonly defaults?: Record<string, unknown>;
  readonly role?: Record<string, unknown>;
  readonly stages?: PipelineStageConfig[];
}

/**
 * Stage configuration stored in database (JSON-serializable).
 */
export interface PipelineStageConfig {
  readonly stageName: string;
  readonly alias?: string;
  readonly steps: Record<string, unknown>[];
}

/**
 * Secret requirement for a plugin.
 * Declares named secrets the plugin expects at build time.
 */
export interface PluginSecret {
  name: string;
  required: boolean;
  description?: string;
}

/**
 * Table for storing reusable plugin configurations.
 * Plugins define the behavior of synth/build steps in CDK pipelines.
 *
 * Features:
 * - Versioning support with semantic versioning
 * - Access control via orgId and accessModifier
 * - Full audit trail (created/updated by/at)
 * - Flexible metadata storage via JSONB
 * - Support for both ShellStep and CodeBuildStep types
 *
 * @table plugins
 */
export const plugin = pgTable('plugins', {
  // Primary key
  id: uuid('id').primaryKey().defaultRandom(),

  // Organization and access control
  orgId: varchar('org_id', { length: 255 })
    .default('system')
    .notNull(),

  // Audit fields
  createdBy: text('created_by')
    .default('system')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: text('updated_by')
    .default('system')
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),

  // Core plugin information
  name: varchar('name', { length: 255 })
    .notNull(),
  description: text('description'),
  keywords: jsonb('keywords')
    .$type<string[]>()
    .default([])
    .notNull(),
  version: varchar('version', { length: 50 })
    .default('1.0.0')
    .notNull(),

  // Plugin classification
  category: varchar('category', { length: 50 })
    .default('unknown')
    .notNull(),

  // Plugin configuration
  metadata: jsonb('metadata')
    .$type<Record<string, string | number | boolean>>()
    .default({})
    .notNull(),
  pluginType: varchar('plugin_type', { length: 50 })
    .$type<PluginType>()
    .default('CodeBuildStep' as PluginType)
    .notNull(),
  computeType: varchar('compute_type', { length: 50 })
    .$type<ComputeType>()
    .default('SMALL' as ComputeType)
    .notNull(),
  timeout: integer('timeout'),
  failureBehavior: varchar('failure_behavior', { length: 10 })
    .$type<'fail' | 'warn' | 'ignore'>()
    .default('fail')
    .notNull(),
  secrets: jsonb('secrets')
    .$type<PluginSecret[]>()
    .default([])
    .notNull(),
  primaryOutputDirectory: varchar('primary_output_directory', { length: 28 }),

  // Build configuration
  env: jsonb('env')
    .$type<Record<string, string>>()
    .default({})
    .notNull(),
  buildArgs: jsonb('build_args')
    .$type<Record<string, string>>()
    .default({})
    .notNull(),
  installCommands: text('install_commands')
    .array()
    .default([])
    .notNull(),
  commands: text('commands')
    .array()
    .default([])
    .notNull(),

  // Docker configuration
  imageTag: varchar('image_tag', { length: 255 })
    .notNull(),
  dockerfile: text('dockerfile'),

  // Access and visibility
  accessModifier: varchar('access_modifier', { length: 10 })
    .$type<AccessModifier>()
    .default('private' as AccessModifier)
    .notNull(),
  isDefault: boolean('is_default')
    .default(false)
    .notNull(),
  isActive: boolean('is_active')
    .default(true)
    .notNull(),

  // Deletion tracking (soft delete)
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
}, (table) => ({
  // Indexes for common queries
  nameIdx: index('plugin_name_idx').on(table.name),
  orgIdIdx: index('plugin_org_id_idx').on(table.orgId),
  versionIdx: index('plugin_version_idx').on(table.version),
  imageTagIdx: index('plugin_image_tag_idx').on(table.imageTag),
  activeIdx: index('plugin_active_idx').on(table.isActive),
  createdAtIdx: index('plugin_created_at_idx').on(table.createdAt),
  updatedAtIdx: index('plugin_updated_at_idx').on(table.updatedAt),

  // Category index for filtering
  categoryIdx: index('plugin_category_idx').on(table.category),

  // Composite index for common access pattern (orgId + isActive)
  orgActiveIdx: index('plugin_org_active_idx').on(table.orgId, table.isActive),

  // Composite index for filtered queries (orgId + accessModifier + isActive)
  orgAccessActiveIdx: index('plugin_org_access_active_idx').on(table.orgId, table.accessModifier, table.isActive),

  // Partial index for active-only queries (smaller, faster than full index)
  activeOnlyOrgIdx: index('plugin_active_only_org_idx').on(table.orgId, table.createdAt).where(sql`is_active = true`),

  // Unique constraint on name + version + orgId
  nameVersionOrgUnique: uniqueIndex('plugin_name_version_org_unique')
    .on(table.name, table.version, table.orgId),

  // Check constraints
  versionCheck: check(
    'plugin_version_check',
    sql`${table.version} ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$'`,
  ),
}));

/**
 * Table for storing pipeline instances and their full configuration.
 *
 * Features:
 * - Full BuilderProps serialization for reconstruction
 * - Organization-level isolation
 * - Pipeline status tracking
 * - Execution history tracking
 * - Flexible tagging system
 *
 * @table pipelines
 */
export const pipeline = pgTable('pipelines', {
  // Primary key
  id: uuid('id').primaryKey().defaultRandom(),

  // Organization and access control
  orgId: varchar('org_id', { length: 255 })
    .default('system')
    .notNull(),

  // Audit fields
  createdBy: text('created_by')
    .default('system')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: text('updated_by')
    .default('system')
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),

  // Core pipeline information
  project: varchar('project', { length: 255 })
    .notNull(),
  organization: varchar('organization', { length: 255 })
    .notNull(),
  pipelineName: varchar('pipeline_name', { length: 255 }),
  description: text('description'),
  keywords: jsonb('keywords')
    .$type<string[]>()
    .default([])
    .notNull(),

  // Pipeline configuration
  props: jsonb('props')
    .$type<PipelineBuilderConfig>()
    .notNull(),

  // Access and visibility
  accessModifier: varchar('access_modifier', { length: 10 })
    .$type<AccessModifier>()
    .default('private' as AccessModifier)
    .notNull(),
  isDefault: boolean('is_default')
    .default(false)
    .notNull(),
  isActive: boolean('is_active')
    .default(true)
    .notNull(),

  // Deletion tracking (soft delete)
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
}, (table) => ({
  // Indexes for common queries
  projectIdx: index('pipeline_project_idx').on(table.project),
  organizationIdx: index('pipeline_organization_idx').on(table.organization),
  orgIdIdx: index('pipeline_org_id_idx').on(table.orgId),
  activeIdx: index('pipeline_active_idx').on(table.isActive),
  createdAtIdx: index('pipeline_created_at_idx').on(table.createdAt),
  updatedAtIdx: index('pipeline_updated_at_idx').on(table.updatedAt),

  // Composite index for common access pattern (orgId + isActive)
  orgActiveIdx: index('pipeline_org_active_idx').on(table.orgId, table.isActive),

  // Composite index for filtered queries (orgId + accessModifier + isActive)
  orgAccessActiveIdx: index('pipeline_org_access_active_idx').on(table.orgId, table.accessModifier, table.isActive),

  // Partial index for active-only queries (smaller, faster than full index)
  activeOnlyOrgIdx: index('pipeline_active_only_org_idx').on(table.orgId, table.createdAt).where(sql`is_active = true`),

  // Unique constraint on project + organization + orgId
  projectOrgUnique: uniqueIndex('pipeline_project_org_unique')
    .on(table.project, table.organization, table.orgId),
}));

/**
 * Message type identifiers
 */
export type MessageType = 'announcement' | 'conversation';

/**
 * Message priority levels
 */
export type MessagePriority = 'normal' | 'high' | 'urgent';

/**
 * Table for storing internal messages between organizations and the system org.
 *
 * Features:
 * - Announcements: System org broadcasts to all orgs (recipientOrgId = '*')
 * - Conversations: Two-way threaded messaging between an org and system org
 * - Thread support via threadId (null for root messages, references root for replies)
 * - Read tracking per message
 * - Priority levels (normal, high, urgent)
 * - Soft delete support
 *
 * @table messages
 */
export const message = pgTable('messages', {
  // Primary key
  id: uuid('id').primaryKey().defaultRandom(),

  // Organization and access control
  orgId: varchar('org_id', { length: 255 })
    .default('system')
    .notNull(),

  // Audit fields
  createdBy: text('created_by')
    .default('system')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: text('updated_by')
    .default('system')
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),

  // Threading
  threadId: uuid('thread_id'),

  // Message routing
  recipientOrgId: varchar('recipient_org_id', { length: 255 })
    .notNull(),

  // Message content
  messageType: varchar('message_type', { length: 20 })
    .$type<MessageType>()
    .default('conversation' as MessageType)
    .notNull(),
  subject: varchar('subject', { length: 500 })
    .notNull(),
  content: text('content')
    .notNull(),

  // Status
  isRead: boolean('is_read')
    .default(false)
    .notNull(),
  priority: varchar('priority', { length: 20 })
    .$type<MessagePriority>()
    .default('normal' as MessagePriority)
    .notNull(),

  // Access and visibility
  accessModifier: varchar('access_modifier', { length: 10 })
    .$type<AccessModifier>()
    .default('private' as AccessModifier)
    .notNull(),
  isDefault: boolean('is_default')
    .default(false)
    .notNull(),
  isActive: boolean('is_active')
    .default(true)
    .notNull(),

  // Deletion tracking (soft delete)
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
}, (table) => ({
  // Indexes for common queries
  orgIdIdx: index('message_org_id_idx').on(table.orgId),
  recipientOrgIdIdx: index('message_recipient_org_id_idx').on(table.recipientOrgId),
  threadIdIdx: index('message_thread_id_idx').on(table.threadId),
  messageTypeIdx: index('message_message_type_idx').on(table.messageType),
  createdAtIdx: index('message_created_at_idx').on(table.createdAt),
  activeIdx: index('message_active_idx').on(table.isActive),
  isReadIdx: index('message_is_read_idx').on(table.isRead),

  // Composite index for inbox queries (recipient + active + created)
  recipientActiveCreatedIdx: index('message_recipient_active_created_idx')
    .on(table.recipientOrgId, table.isActive, table.createdAt),

  // Composite index for org inbox (orgId + active)
  orgActiveIdx: index('message_org_active_idx').on(table.orgId, table.isActive),
}));

/**
 * Pipeline deployment registry.
 * Maps deployed CodePipeline ARNs back to pipeline records and org IDs.
 * Populated by the deploy command after successful CDK deploy.
 * Used by the event-ingestion Lambda to resolve EventBridge events to org-scoped records.
 *
 * @table pipeline_registry
 */
export const pipelineRegistry = pgTable('pipeline_registry', {
  id: uuid('id').primaryKey().defaultRandom(),
  pipelineId: uuid('pipeline_id').notNull(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  pipelineArn: varchar('pipeline_arn', { length: 512 }).notNull().unique(),
  pipelineName: varchar('pipeline_name', { length: 255 }).notNull(),
  accountId: varchar('account_id', { length: 12 }),
  region: varchar('region', { length: 30 }),
  project: varchar('project', { length: 255 }),
  organization: varchar('organization', { length: 255 }),
  lastDeployed: timestamp('last_deployed', { withTimezone: true }),
  stackName: varchar('stack_name', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pipelineIdIdx: index('registry_pipeline_id_idx').on(table.pipelineId),
  orgIdIdx: index('registry_org_id_idx').on(table.orgId),
  orgRegionIdx: index('registry_org_region_idx').on(table.orgId, table.region),
}));

/**
 * Event source identifiers for pipeline_events.
 */
export type EventSource = 'codepipeline' | 'codebuild' | 'plugin-build';

/**
 * Event type granularity levels for pipeline_events.
 */
export type EventType = 'PIPELINE' | 'STAGE' | 'ACTION' | 'BUILD';

/**
 * Pipeline execution and build events.
 * Captures CodePipeline/CodeBuild state changes from EventBridge
 * and plugin Docker build outcomes from BullMQ.
 * All events are org-scoped for multi-tenant reporting.
 *
 * @table pipeline_events
 */
export const pipelineEvent = pgTable('pipeline_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  pipelineId: uuid('pipeline_id'),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  eventSource: varchar('event_source', { length: 50 }).$type<EventSource>().notNull(),
  eventType: varchar('event_type', { length: 50 }).$type<EventType>().notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  pipelineArn: varchar('pipeline_arn', { length: 512 }),
  executionId: varchar('execution_id', { length: 255 }),
  stageName: varchar('stage_name', { length: 255 }),
  actionName: varchar('action_name', { length: 255 }),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pipelineIdIdx: index('event_pipeline_id_idx').on(table.pipelineId),
  orgIdIdx: index('event_org_id_idx').on(table.orgId),
  eventTypeIdx: index('event_type_idx').on(table.eventType),
  statusIdx: index('event_status_idx').on(table.status),
  pipelineArnIdx: index('event_pipeline_arn_idx').on(table.pipelineArn),
  executionIdIdx: index('event_execution_id_idx').on(table.executionId),
  createdAtIdx: index('event_created_at_idx').on(table.createdAt),
  orgTypeCreatedIdx: index('event_org_type_created_idx').on(table.orgId, table.eventType, table.createdAt),
  orgSourceStatusIdx: index('event_org_source_status_idx').on(table.orgId, table.eventSource, table.status),
}));

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
  | 'exists' | 'notExists'
  | 'countGt' | 'countLt'
  | 'lengthGt' | 'lengthLt';

/**
 * Cross-field condition mode for multi-condition rules.
 */
export type RuleConditionMode = 'all' | 'any';

/**
 * Rule scope — org-level or published (system org only, opt-in via subscription).
 */
export type RuleScope = 'org' | 'published';

/**
 * A single condition in a cross-field rule.
 */
export interface RuleCondition {
  field?: string;
  operator?: RuleOperator;
  value?: unknown;
  dependsOnRule?: string; // rule ID — only evaluate if referenced rule passed
}

/**
 * Compliance policies group rules into named sets that can be enabled/disabled together.
 *
 * @table compliance_policies
 */
export const compliancePolicy = pgTable('compliance_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).default('system').notNull(),
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
  orgId: varchar('org_id', { length: 255 }).default('system').notNull(),
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

  // Forking — tracks which published rule this org rule was copied from
  forkedFromRuleId: uuid('forked_from_rule_id'),

  // Notification override
  suppressNotification: boolean('suppress_notification').default(false).notNull(),

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
 * Compliance audit log — stores every compliance check result.
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
 * Bulk compliance scans — tracks scheduled and on-demand scans.
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

/**
 * Complete Drizzle schema export
 */
export const schema = {
  plugin,
  pipeline,
  message,
  pipelineRegistry,
  pipelineEvent,
  // Compliance tables
  compliancePolicy,
  complianceRule,
  complianceRuleHistory,
  complianceAuditLog,
  complianceExemption,
  complianceRuleSubscription,
  complianceScan,
  complianceScanSchedule,
  complianceNotificationPreference,
  complianceNotificationLog,
  complianceRole,
  complianceReport,
  complianceReportSchedule,
} as const;

/**
 * TypeScript types representing database rows
 */
export type Plugin = typeof plugin.$inferSelect;
export type PluginInsert = typeof plugin.$inferInsert;

export type Pipeline = typeof pipeline.$inferSelect;
export type PipelineInsert = typeof pipeline.$inferInsert;

export type Message = typeof message.$inferSelect;
export type MessageInsert = typeof message.$inferInsert;

export type PipelineRegistry = typeof pipelineRegistry.$inferSelect;
export type PipelineRegistryInsert = typeof pipelineRegistry.$inferInsert;

export type PipelineEvent = typeof pipelineEvent.$inferSelect;
export type PipelineEventInsert = typeof pipelineEvent.$inferInsert;

/**
 * Helper types for working with partial updates
 */
export type PluginUpdate = Partial<Omit<PluginInsert, 'id' | 'createdAt' | 'createdBy'>>;
export type PipelineUpdate = Partial<Omit<PipelineInsert, 'id' | 'createdAt' | 'createdBy'>>;
export type MessageUpdate = Partial<Omit<MessageInsert, 'id' | 'createdAt' | 'createdBy'>>;

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
