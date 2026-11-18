// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AlertChannel, AlertRuleSeverity } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { boolean, integer, varchar, pgTable, text, timestamp, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';

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

  /** api-core `ALERT_CHANNELS` — a varchar, not an enum, so a future channel
   * (PagerDuty, …) can be added without a schema migration. */
  channel: varchar('channel', { length: 20 })
    .$type<AlertChannel>()
    .notNull(),
  /** Channel-specific target. Slack/webhook: URL. Email: address. In-app: ignored. */
  target: text('target').default('').notNull(),
  /** Friendly label shown in the settings UI. */
  label: varchar('label', { length: 100 }).notNull(),

  /** Lowest severity that triggers this destination ('warning' = warning+critical,
   * 'critical' = critical only) — api-core `ALERT_RULE_SEVERITIES`. */
  minSeverity: varchar('min_severity', { length: 10 })
    .$type<AlertRuleSeverity>()
    .default('warning')
    .notNull(),
  enabled: boolean('enabled').default(true).notNull(),

  /** Soft delete so we keep audit history of who-deleted-what. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
  // Soft-delete purge deadline: the retention sweep hard-deletes tombstoned
  // rows once `purge_after` has passed (set on delete alongside deleted_at).
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
}, (table) => ({
  // Partial index over just the tombstones — drives the retention purge sweep.
  purgeIdx: index('org_alert_destination_purge_idx').on(table.purgeAfter).where(sql`deleted_at IS NOT NULL`),
  // Per-org listing  the only access path.
  orgIdx: index('org_alert_destination_org_idx')
    .on(table.orgId, table.enabled).where(sql`deleted_at IS NULL`),
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
  /** api-core `ALERT_RULE_SEVERITIES` — the platform-wide severity ladder. */
  severity: varchar('severity', { length: 20 })
    .$type<AlertRuleSeverity>()
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
  // Soft-delete purge deadline: the retention sweep hard-deletes tombstoned
  // rows once `purge_after` has passed (set on delete alongside deleted_at).
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
}, (table) => ({
  // Partial index over just the tombstones — drives the retention purge sweep.
  purgeIdx: index('org_alert_rule_purge_idx').on(table.purgeAfter).where(sql`deleted_at IS NOT NULL`),
  // Per-org listing + materializer's enabled-only scan.
  orgEnabledIdx: index('org_alert_rule_org_enabled_idx')
    .on(table.orgId, table.enabled).where(sql`deleted_at IS NULL`),
  // Unique within an org so operators can't accidentally clone a rule.
  orgNameUq: uniqueIndex('org_alert_rule_org_name_uq')
    .on(table.orgId, table.name)
    .where(sql`deleted_at IS NULL`),
}));

/**
 * Delivery health of one org alert destination (keyed by its
 * `org_alert_destinations.id`): when the relay last reached it, whether that
 * worked, and how many attempts in a row have failed. Written best-effort by
 * ops-center's relay after every real delivery attempt and shown in the
 * org's destinations list, so an org whose Slack webhook was revoked SEES it.
 *
 * Operational state, not a record: ops-center's retention sweep removes a
 * row nothing has tried to reach for 30 days (deleted, disabled, or a purged
 * org's destination), and the org purge removes the org's rows outright.
 *
 * `last_error_kind` is a CLASS (timeout / rejected / unreachable /
 * unknown-channel), never the downstream status or host — an org controls the
 * URL, and a precise error would make the relay an oracle for probing.
 *
 * @table alert_destination_status
 */
export const alertDestinationStatus = pgTable('alert_destination_status', {
  destinationId: varchar('destination_id', { length: 64 }).primaryKey(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  channel: varchar('channel', { length: 20 }).notNull(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).notNull(),
  lastOk: boolean('last_ok').notNull(),
  lastErrorKind: varchar('last_error_kind', { length: 20 }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  /** Failed attempts since the last success. */
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  /** When the org's admins were told this destination is failing (cleared on the next success). */
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
}, (table) => ({
  // The retention sweep's and the health gauge's window scan.
  lastAttemptIdx: index('alert_destination_status_last_attempt_idx').on(table.lastAttemptAt),
  orgIdx: index('alert_destination_status_org_idx').on(table.orgId),
}));

export type AlertDestinationStatusRow = typeof alertDestinationStatus.$inferSelect;

export type OrgAlertDestination = typeof orgAlertDestination.$inferSelect;
export type OrgAlertDestinationInsert = typeof orgAlertDestination.$inferInsert;
export type OrgAlertDestinationUpdate = Partial<Omit<OrgAlertDestinationInsert, 'id' | 'createdAt' | 'createdBy' | 'orgId'>>;
