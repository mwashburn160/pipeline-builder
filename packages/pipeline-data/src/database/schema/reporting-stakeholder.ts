// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stakeholder reports — scheduled, manager-facing summaries a lead developer
 * composes, reviews and publishes.
 *
 * Four tables, and the reason each exists:
 *
 *  - `report_definitions` — the saved "what and when". Reporting was entirely
 *    on-demand before this: the dashboard picked a from/to and nothing could be
 *    saved, scheduled or kept.
 *  - `report_runs` — the FROZEN snapshot of one period's output. This is the load
 *    bearing table. The retention sweep purges raw `pipeline_events` by tier, so
 *    without a snapshot last quarter's report cannot be regenerated once its
 *    events are gone — and a manager who read a number on Monday must see the same
 *    number on Friday.
 *  - `report_share_links` — expiring, revocable read-only links, because the
 *    managers a report is for usually have no platform account.
 *  - `report_recipients` — per-org delivery addresses, with verification and
 *    bounce state. Recipient emails are PII and the org owns the list, not the
 *    definition, so one lead's list is reusable and one unsubscribe is honoured
 *    everywhere.
 *
 * Every table is org-scoped with RLS + soft-delete, mirroring postgres-init.sql
 * (which is what actually deploys; `schema-reflection.test.ts` keeps the two in
 * lock-step, name for name).
 */

import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/** How often a definition produces a report. */
export const REPORT_CADENCES = ['weekly', 'monthly', 'quarterly'] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

/** The manager-facing templates. Each is a fixed list of section ids. */
export const REPORT_TEMPLATES = ['weekly_delivery', 'monthly_health', 'quarterly_review'] as const;
export type ReportTemplate = (typeof REPORT_TEMPLATES)[number];

/**
 * A run's lifecycle. `drafting` → `ready_for_review` → `published`, with `failed`
 * as a terminal side branch. Nothing reaches a manager before `published`, which
 * is what makes the lead's approval the gate.
 */
export const REPORT_RUN_STATUSES = ['drafting', 'ready_for_review', 'published', 'failed'] as const;
export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];

/**
 * Why a definition stopped running. Recorded rather than inferred, because the
 * three causes need different fixes and the lead sees this string: the add-on
 * lapsed, the owner was deactivated, or the owner lost the permission that let
 * them author it.
 */
export const REPORT_PAUSE_REASONS = ['entitlement', 'owner_inactive', 'permission_lost'] as const;
export type ReportPauseReason = (typeof REPORT_PAUSE_REASONS)[number];

/** What a definition reports on. */
export const REPORT_SCOPE_KINDS = ['org', 'projects', 'rollup'] as const;
export type ReportScopeKind = (typeof REPORT_SCOPE_KINDS)[number];

/**
 * One thing the lead needs from the people reading the report.
 *
 * `decision` is the request in plain words, `from` names who can answer it, and
 * `by` is when an answer stops being useful. All three matter: an ask with no
 * owner is a wish, and one with no date is never urgent.
 */
export interface ReportAsk {
  decision: string;
  from?: string;
  /** ISO date. Not a timestamp — a decision deadline is a day, not a moment. */
  by?: string;
}

/** The `scope` JSON: which pipelines a run covers. */
export interface ReportScope {
  kind: ReportScopeKind;
  /** Project names, when `kind === 'projects'`. Empty for org/rollup. */
  projects?: string[];
}

/**
 * A saved report: what to compute, how often, in whose timezone, and who receives
 * it.
 *
 * @table report_definitions
 */
export const reportDefinition = pgTable('report_definitions', {
  id: varchar('id', { length: 255 }).primaryKey(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  /**
   * The lead who owns this definition. Runs re-check THIS user's permissions, not
   * the caller's, because a scheduled run has no caller — so a lead who loses
   * access stops producing reports rather than keeping a standing grant.
   */
  ownerId: text('owner_id').notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  template: varchar('template', { length: 40 }).$type<ReportTemplate>().notNull(),
  /** Section ids, resolved through the section registry at run time. */
  sections: jsonb('sections').$type<string[]>().default([]).notNull(),
  cadence: varchar('cadence', { length: 20 }).$type<ReportCadence>().notNull(),
  /** IANA name. Periods are cut in THIS zone, not the database session's. */
  timezone: varchar('timezone', { length: 64 }).default('UTC').notNull(),
  weekStart: varchar('week_start', { length: 10 }).default('monday').notNull(),
  scope: jsonb('scope').$type<ReportScope>().notNull(),
  /** Recipient ids from `report_recipients`, not raw addresses. */
  recipients: jsonb('recipients').$type<string[]>().default([]).notNull(),
  /**
   * Publish without the lead reviewing. Off by default: the whole point of the
   * review step is that the data cannot supply the context a manager needs
   * ("we paused deploys Tuesday for the migration").
   */
  autoSend: boolean('auto_send').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  pausedReason: varchar('paused_reason', { length: 30 }).$type<ReportPauseReason>(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
}, (table) => ({
  orgIdx: index('report_definition_org_idx').on(table.orgId).where(sql`deleted_at IS NULL`),
  ownerIdx: index('report_definition_owner_idx').on(table.ownerId).where(sql`deleted_at IS NULL`),
  // Drives the scheduler's claim scan: the due, live, unpaused definitions only.
  dueIdx: index('report_definition_due_idx').on(table.nextRunAt)
    .where(sql`deleted_at IS NULL AND is_active = true`),
  purgeIdx: index('report_definition_purge_idx').on(table.purgeAfter).where(sql`deleted_at IS NOT NULL`),
}));

/**
 * One period's frozen output.
 *
 * @table report_runs
 */
export const reportRun = pgTable('report_runs', {
  id: varchar('id', { length: 255 }).primaryKey(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  definitionId: varchar('definition_id', { length: 255 }).notNull(),
  /** Inclusive period start, exclusive end — both instants, in UTC. */
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  /** Human label in the definition's timezone: `2026-W38`, `2026-08`, `2026-Q3`. */
  periodLabel: varchar('period_label', { length: 20 }).notNull(),
  /**
   * Regenerating a period produces version N+1 and supersedes the old row rather
   * than overwriting it. Late events (the ingest redrives its dead-letter queue
   * hours later) mean a corrected report is normal — and a manager who already
   * read v1 must still be able to see exactly what they read.
   */
  version: integer('version').default(1).notNull(),
  status: varchar('status', { length: 20 }).$type<ReportRunStatus>().default('drafting').notNull(),
  /** The computed sections. Survives the raw-event purge — that is the point. */
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>(),
  /** AI-generated executive summary, from the snapshot's numbers only. */
  aiDraft: text('ai_draft'),
  /** The lead's own words. The context the data cannot supply. */
  leadNotes: text('lead_notes'),
  /**
   * The ASKS: what the lead needs a decision on, from whom, by when.
   *
   * Separate from `leadNotes` because they are the only part of a report with a
   * recipient and a deadline. Buried in a paragraph of narrative, a request for a
   * decision reads as commentary and gets no answer — which is the most common way
   * a status report fails to be worth writing.
   */
  asks: jsonb('asks').$type<ReportAsk[]>().default([]).notNull(),
  failureReason: text('failure_reason'),
  publishedBy: text('published_by'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  supersededBy: varchar('superseded_by', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
}, (table) => ({
  // The idempotency key. A retry, a catch-up pass and a manual backfill can all
  // ask for the same period; without this they would each insert a row.
  periodUnique: uniqueIndex('report_run_period_unique')
    .on(table.definitionId, table.periodStart, table.version),
  definitionIdx: index('report_run_definition_idx').on(table.definitionId, table.periodStart)
    .where(sql`deleted_at IS NULL`),
  orgIdx: index('report_run_org_idx').on(table.orgId).where(sql`deleted_at IS NULL`),
  purgeIdx: index('report_run_purge_idx').on(table.purgeAfter).where(sql`deleted_at IS NOT NULL`),
}));

/**
 * A read-only, expiring link to one published run.
 *
 * @table report_share_links
 */
export const reportShareLink = pgTable('report_share_links', {
  id: varchar('id', { length: 255 }).primaryKey(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  runId: varchar('run_id', { length: 255 }).notNull(),
  /**
   * SHA-256 of the token, never the token. The raw value is shown once, at
   * creation — a stored token is a stored credential for org data that anyone
   * holding the link can read.
   */
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: text('revoked_by'),
  /** Redact pipeline/project names in the public view — internal names leak intent. */
  redactNames: boolean('redact_names').default(false).notNull(),
  viewCount: integer('view_count').default(0).notNull(),
  lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // The public route's only lookup: by token hash. Unique so a hash collision
  // cannot resolve to two runs.
  tokenUnique: uniqueIndex('report_share_link_token_unique').on(table.tokenHash),
  runIdx: index('report_share_link_run_idx').on(table.runId),
  orgIdx: index('report_share_link_org_idx').on(table.orgId),
}));

/**
 * A verified delivery address for one org.
 *
 * @table report_recipients
 */
export const reportRecipient = pgTable('report_recipients', {
  id: varchar('id', { length: 255 }).primaryKey(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  displayName: varchar('display_name', { length: 200 }),
  /**
   * Set when the recipient confirms by email. Nothing is delivered before this:
   * otherwise a lead could send org data to any address by typing it.
   */
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verificationTokenHash: varchar('verification_token_hash', { length: 64 }),
  /** Honoured across every definition — an unsubscribe is per person, not per report. */
  unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
  bounceCount: integer('bounce_count').default(0).notNull(),
  lastBounceAt: timestamp('last_bounce_at', { withTimezone: true }),
  /** Set when an admin approved an address outside the allowed domains. */
  approvedBy: text('approved_by'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
}, (table) => ({
  // One row per address per org, so re-adding a recipient reuses its verification
  // and unsubscribe state rather than resetting them.
  orgEmailUnique: uniqueIndex('report_recipient_org_email_unique').on(table.orgId, table.email),
  orgIdx: index('report_recipient_org_idx').on(table.orgId).where(sql`deleted_at IS NULL`),
  purgeIdx: index('report_recipient_purge_idx').on(table.purgeAfter).where(sql`deleted_at IS NOT NULL`),
}));

export type ReportDefinition = typeof reportDefinition.$inferSelect;
export type ReportDefinitionInsert = typeof reportDefinition.$inferInsert;
export type ReportRun = typeof reportRun.$inferSelect;
export type ReportRunInsert = typeof reportRun.$inferInsert;
export type ReportShareLink = typeof reportShareLink.$inferSelect;
export type ReportShareLinkInsert = typeof reportShareLink.$inferInsert;
export type ReportRecipient = typeof reportRecipient.$inferSelect;
export type ReportRecipientInsert = typeof reportRecipient.$inferInsert;
