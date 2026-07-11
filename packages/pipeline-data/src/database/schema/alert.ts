// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { sql } from 'drizzle-orm';
import { boolean, varchar, pgTable, text, timestamp, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Per-org alert notification destination. Multi-tenant alerting routes
 * Alertmanager webhooks to the platform; the platform looks the firing
 * alert's `org_id` label up here and forwards to each enabled destination.
 *
 * Channels * - `slack`  `target` is the incoming-webhook URL
 * - `webhook`  `target` is any HTTPS URL; the relay posts the
 * Alertmanager v2 webhook payload verbatim
 * - `in-app`  `target` ignored; surfaces as an in-app message via
 * the existing `messages` table
 *
 * Secrets * - For `slack`/`webhook` channels, the URL itself is the secret. We don't
 * log it on `dashboard.update` or surface the full URL on GET endpoints
 * after write; just a masked preview (last 12 chars). Stored in clear
 * text  same posture as `compliance_notification_preferences.webhook_url`
 * and consistent with the rest of the app's secret handling for org-level
 * integrations. If we add a KMS-encryption tier for any secret column,
 * this is one of the first to migrate.
 *
 * @table org_alert_destinations
 */
export const orgAlertDestination = pgTable('org_alert_destinations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),

  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),

  /** 'slack' | 'webhook' | 'in-app' | 'email'  kept stringly so future channels
   * (PagerDuty, …) can be added without a schema migration. */
  channel: varchar('channel', { length: 20 })
    .$type<'slack' | 'webhook' | 'in-app' | 'email'>()
    .notNull(),
  /** Channel-specific target. Slack/webhook: URL. Email: address. In-app: ignored. */
  target: text('target').default('').notNull(),
  /** Friendly label shown in the settings UI. */
  label: varchar('label', { length: 100 }).notNull(),

  /** Lowest severity that triggers this destination ('warning' = warning+critical,
   * 'critical' = critical only). Mirrors Alertmanager severity ordering. */
  minSeverity: varchar('min_severity', { length: 10 })
    .$type<'warning' | 'critical'>()
    .default('warning')
    .notNull(),
  enabled: boolean('enabled').default(true).notNull(),

  /** Soft delete so we keep audit history of who-deleted-what. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
}, (table) => ({
  // Per-org listing  the only access path.
  orgIdx: index('org_alert_destination_org_idx')
    .on(table.orgId, table.enabled),
}));

/**
 *  Per-org alert rules authored by operators.
 *
 * Each row materializes into a `groups[].rules[]` entry in a Prometheus
 * `rule_files` YAML. The materializer endpoint
 * `GET /api/observability/alert-rules/materialized.yml` renders all enabled
 * rules across all orgs (deleted=null) into one document; Prometheus polls
 * or a sidecar copies it into the rules dir.
 *
 * Tenancy + safety * - `expr` is user-authored PromQL. The CRUD route enforces that the
 * expression substring-contains `org_id="<orgId>"` so an operator can't
 * write rules that fire on other orgs' metrics. This is a coarse gate
 * (a malformed expression can still be syntactically wrong) but it
 * closes the cross-tenant data leak. Real PromQL parsing + automatic
 * org_id injection is a follow-on.
 * - The materialized rule carries `labels.org_id = <orgId>` so the
 * alertmanager-relay routes firing alerts to the right org's
 * destinations (matches the alert-relay model).
 *
 * @table org_alert_rules
 */
export const orgAlertRule = pgTable('org_alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),

  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),

  /** Operator-supplied rule name. Sanitized into a valid Prom alert name at
   * materialization time (becomes `OrgRule_<orgId>_<slug>` to avoid name
   * collisions across orgs). */
  name: varchar('name', { length: 100 }).notNull(),
  /** PromQL expression. MUST substring-contain `org_id="<orgId>"`. */
  expr: text('expr').notNull(),
  /** `for: 5m` style duration. Validated against Prom's duration regex. */
  forDuration: varchar('for_duration', { length: 20 }).default('5m').notNull(),
  /** 'warning' | 'critical'  matches the platform-wide severity ladder. */
  severity: varchar('severity', { length: 20 })
    .$type<'warning' | 'critical'>()
    .default('warning')
    .notNull(),
  /** Alertmanager `summary` annotation. Supports `{{ $value }}`. */
  summary: text('summary').notNull(),
  /** Alertmanager `description` annotation. Optional; '' is fine. */
  description: text('description').default('').notNull(),

  /** Disabled rules don't materialize. Lets operators stage rules without firing. */
  enabled: boolean('enabled').default(true).notNull(),

  /** Soft delete so we keep audit of who-deleted-what. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
}, (table) => ({
  // Per-org listing + materializer's enabled-only scan.
  orgEnabledIdx: index('org_alert_rule_org_enabled_idx')
    .on(table.orgId, table.enabled),
  // Unique within an org so operators can't accidentally clone a rule.
  orgNameUq: uniqueIndex('org_alert_rule_org_name_uq')
    .on(table.orgId, table.name)
    .where(sql`deleted_at IS NULL`),
}));

export type OrgAlertDestination = typeof orgAlertDestination.$inferSelect;
export type OrgAlertDestinationInsert = typeof orgAlertDestination.$inferInsert;
export type OrgAlertDestinationUpdate = Partial<Omit<OrgAlertDestinationInsert, 'id' | 'createdAt' | 'createdBy' | 'orgId'>>;
