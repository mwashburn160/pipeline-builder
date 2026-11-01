// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { sql } from 'drizzle-orm';
import { boolean, integer, varchar, pgTable, text, timestamp, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * The WORKFLOW axis of a support case.
 *
 * `messages` already carries the conversation — identity, threading, priority,
 * per-participant read state, attachments and soft-delete. What it has no column
 * for is workflow: status, ownership, resolution and the response clock. That is
 * this table, one row per case, joined to the conversation by `threadId`.
 *
 * Keeping them apart rather than widening `messages` is deliberate: `messages`
 * also carries announcements and ordinary conversations, which have no status,
 * no assignee and no response target. Six nullable columns on every announcement
 * row to describe a state announcements cannot be in is how a table stops
 * meaning one thing.
 *
 * @table support_cases
 */
export const supportCase = pgTable('support_cases', {
  // Internal key. NOT the case identity — see `threadId`.
  id: uuid('id').primaryKey().defaultRandom(),

  /**
   * The root `messages.id` of the thread, and the CANONICAL case identity.
   *
   * The convention already exists: readers walk `threadId === root.id` and
   * `update-message.ts` uses `updated.threadId ?? updated.id` for exactly this
   * "the root is the identity" idea. So case identity falls out of threading the
   * support path rather than being a new concept.
   */
  threadId: uuid('thread_id').notNull(),

  // The TENANT org. Never the system org — a case is always about one tenant,
  // even though the system org is the other participant in the thread.
  orgId: varchar('org_id', { length: 255 }).notNull(),

  /**
   * Per-org, customer-quotable case number (rendered `ACME-1042`).
   *
   * A bare UUID is not something anyone reads out on a call or puts in an email
   * subject, and a GLOBAL sequence would disclose total case volume to every
   * customer. Allocated from `support_case_counters` in the same transaction as
   * the insert; `support_case_org_number_uq` is the backstop that turns a
   * bypassed counter into a failed insert rather than two cases sharing the one
   * identifier customers quote back.
   */
  displayNumber: integer('display_number').notNull(),

  // open | awaiting_support | awaiting_customer | resolved | closed
  status: varchar('status', { length: 32 }).default('open').notNull(),

  // Set by the opener; re-rankable by staff. Self-selected severity is why staff
  // re-ranking is in v1: otherwise the tenant chooses the target they are owed.
  severity: varchar('severity', { length: 16 }).default('normal').notNull(),

  /**
   * The support level held when the case was OPENED, frozen onto the case.
   *
   * Frozen deliberately: a customer who downgrades mid-case should still get the
   * response they bought when they opened it. Resolving entitlement live would
   * change an open case's promise underneath the person waiting on it.
   */
  level: varchar('level', { length: 32 }).notNull(),

  /** True when the case was opened by spending a one-time incident rather than
   *  against a contact seat. Recorded so "how many incidents were actually
   *  used" is answerable from the cases, not only from a balance delta. */
  openedWithIncident: boolean('opened_with_incident').default(false).notNull(),

  // --- the two owners, which move independently. NEITHER is `createdBy`.
  /** STAFF owner — a system-org actor. `null` is legitimate: it is the unowned
   *  pool, and how "I cannot take this" is said without a pseudo-assignee. */
  assignedTo: text('assigned_to'),
  /** TENANT owner — the designated contact currently responsible. Distinct from
   *  `createdBy`, which is the immutable audit fact of who raised the case:
   *  mutating that to express "someone else owns this now" would destroy the
   *  only record of who actually opened it. */
  tenantContact: text('tenant_contact'),

  // --- the response clock
  /**
   * When the first response is DUE, computed once at open and never recomputed.
   *
   * Frozen for the same reason `level` is: a change to the working week or the
   * holiday list must not move a promise already made to a customer. Three
   * things follow from storing it rather than deriving it per read:
   *   - the staff queue orders by a real deadline with no calendar arithmetic
   *     per row;
   *   - the standard/priority breach check becomes CONTRACTUAL, where a
   *     wall-clock quantile cannot express a business-day target at all (a
   *     priority case raised at 17:01 on a Friday is not late until Monday
   *     evening, ~79 wall-clock hours later);
   *   - a level with no published target, and a case opened while the calendar
   *     was misconfigured, are both simply NULL — no deadline rather than a
   *     wrong one.
   */
  responseDueAt: timestamp('response_due_at', { withTimezone: true }),
  /** First staff reply. THE measured number — the response target is sold on it. */
  firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
  /**
   * CSAT, 1–5, set by the TENANT once the case is closed. Null = not rated,
   * which is the usual state and must stay distinguishable from a bad rating.
   *
   * Lives here rather than in its own table because a case has exactly one
   * rating — a table would buy a join and a uniqueness constraint to enforce
   * what a column gets for free. First-response latency says whether we
   * answered fast; this is the only thing that says whether the answer helped,
   * and a desk can hit every target while being bad at support.
   */
  satisfaction: integer('satisfaction'),
  /** Optional free text with the rating. Capped at the route. */
  satisfactionComment: text('satisfaction_comment'),
  satisfactionAt: timestamp('satisfaction_at', { withTimezone: true }),
  /** Set when status → `awaiting_customer`; the pause anchor. */
  awaitingSince: timestamp('awaiting_since', { withTimezone: true }),
  /**
   * Accumulated seconds spent waiting on the customer.
   *
   * Ageing subtracts this. Without it a case we answered in an hour, where the
   * tenant replied four days later, reads as a four-day case — and the metric
   * Phase 2b exists to produce reports a number no customer will accept. An
   * accumulator plus the current anchor survives a case bouncing between states
   * repeatedly, which replaying status history would not.
   */
  awaitingTotalSeconds: integer('awaiting_total_seconds').default(0).notNull(),

  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: text('closed_by'),

  // Audit + soft-delete, same shape as `messages`.
  createdBy: text('created_by').default(SYSTEM_ORG_ID).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').default(SYSTEM_ORG_ID).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
}, (table) => ({
  /**
   * THE queue query: every open case across ALL tenants, oldest first.
   *
   * The one query shape with no org predicate to narrow it, so it is also the
   * only one that scans. Partial because the queue never asks about closed
   * cases — which are most of the table within a month. Mirrors
   * `message_purge_idx`, which is partial for the same reason.
   */
  queueIdx: index('support_case_queue_idx')
    .on(table.createdAt)
    .where(sql`status IN ('open', 'awaiting_support') AND deleted_at IS NULL`),

  // A tenant listing its own cases.
  orgStatusIdx: index('support_case_org_status_idx').on(table.orgId, table.status),
  // The rolling-window case count behind the FAIR-USE allowance: how many cases
  // this account raised in the last N days. Leading `org_id` because the count
  // is always scoped to an account subtree, then `created_at` so the window is a
  // range scan rather than a filter over every case the org ever raised.
  orgCreatedIdx: index('support_case_org_created_idx').on(table.orgId, table.createdAt),

  // "What am I on the hook for", one engineer.
  assigneeIdx: index('support_case_assigned_idx')
    .on(table.assignedTo, table.status)
    .where(sql`assigned_to IS NOT NULL`),

  // "My cases" for a contact, AND the lookup that finds a departing contact's
  // open cases so they can be reassigned instead of orphaned.
  tenantContactIdx: index('support_case_tenant_contact_idx')
    .on(table.tenantContact, table.status)
    .where(sql`tenant_contact IS NOT NULL`),

  // Case identity, reached from any message in the thread.
  threadUq: uniqueIndex('support_case_thread_uq').on(table.threadId),

  // The customer-quotable number is unique per org, enforced not assumed.
  displayUq: uniqueIndex('support_case_org_number_uq')
    .on(table.orgId, table.displayNumber)
    .where(sql`deleted_at IS NULL`),
}));

/**
 * Per-org allocator for `support_cases.display_number`.
 *
 * Postgres sequences are global and cannot be per-org without one sequence per
 * tenant, so the counter is a row: `UPDATE … SET next_number = next_number + 1
 * RETURNING next_number` inside the case-insert transaction, where the row lock
 * serialises concurrent opens within one org.
 *
 * @table support_case_counters
 */
export const supportCaseCounter = pgTable('support_case_counters', {
  orgId: varchar('org_id', { length: 255 }).primaryKey(),
  nextNumber: integer('next_number').default(1).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The members authorised to open support cases — what the per-contact price
 * bills for.
 *
 * The COUNT is capped against effective `supportContacts` at designation time,
 * in the same shape seats are capped at invite time. `supportContacts` has a
 * tier base of 0 everywhere, so an org with no support add-on has no contacts
 * and cannot open a case: the paywall is a quota check, not a feature flag.
 *
 * @table support_contacts
 */
export const supportContact = pgTable('support_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 255 }).notNull(),
  userId: text('user_id').notNull(),
  // Who nominated them. Audit-worthy: a contact is a paid, privileged slot.
  designatedBy: text('designated_by').notNull(),
  designatedAt: timestamp('designated_at', { withTimezone: true }).defaultNow().notNull(),
  /**
   * Whether this contact is UPGRADED to premium — 24×7 coverage, the 8-hour
   * any-day target, and the only contacts who may declare `urgent` severity.
   *
   * A column on the contact rather than a level on the org, because that is what
   * the upgrade model means: an account holds one BASELINE level covering every
   * contact and upgrades a subset. Without this the `supportPremiumContacts` cap
   * would grant a quota over nothing — there would be no way for any contact to
   * actually be premium, and the case-open path would have nothing to read.
   *
   * The case freezes the OPENING CONTACT's effective level at open
   * (`support_case.level`), so flipping this later never changes the promise on
   * a case already raised.
   */
  isPremium: boolean('is_premium').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: text('revoked_by'),
}, (table) => ({
  // One live designation per (org, user). Partial so a revoked row does not
  // block re-designating the same person later.
  orgUserUq: uniqueIndex('support_contact_org_user_uq')
    .on(table.orgId, table.userId)
    .where(sql`is_active = true`),
  // Counting an org's live contacts against its cap, and listing them for the
  // tenant-side owner picker.
  orgActiveIdx: index('support_contact_org_active_idx').on(table.orgId, table.isActive),
  // The premium SUBSET, counted against `supportPremiumContacts` on every
  // upgrade. Partial on both flags because that is the only question asked of
  // it: how many live contacts in this scope are upgraded.
  orgPremiumIdx: index('support_contact_org_premium_idx')
    .on(table.orgId, table.userId)
    .where(sql`is_active = true AND is_premium = true`),
}));

/**
 * Canned staff replies — a shared library of answers the desk reuses.
 *
 * SYSTEM-WIDE, not per-tenant, and deliberately so: these are the vendor's own
 * wording for recurring questions, authored once and used across every
 * customer. There is no `org_id` because scoping them per tenant would be the
 * opposite of the point — the value is that the answer to "how do I rotate a
 * service key" is written well once rather than retyped badly fifty times.
 *
 * That also means RLS does not apply: every row is visible to the staff who can
 * reach the queue, and to nobody else. The routes are system-admin gated on
 * both read and write for exactly that reason.
 *
 * Soft-deleted rather than removed, because a retired template is still the
 * explanation of what a past reply said.
 *
 * @table support_canned_responses
 */
export const supportCannedResponse = pgTable('support_canned_responses', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Short label the picker lists. */
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  isActive: boolean('is_active').default(true).notNull(),
}, (table) => ({
  // The picker's only query: live templates, alphabetical.
  activeTitleIdx: index('support_canned_active_idx').on(table.isActive, table.title),
}));

/**
 * CSAT: the customer's verdict on a closed case.
 *
 * A COLUMN SET on the case rather than its own table, unlike notes. The reason
 * is cardinality, not convenience: a case has many notes and exactly one
 * satisfaction rating, so a table would buy an extra join and a uniqueness
 * constraint to enforce what a column gets for free.
 *
 * Why it matters more here than in most products: the thing being SOLD is a
 * response time, and first-response latency only measures whether we answered
 * fast — not whether the answer was any good. A desk can hit every target and
 * still be bad at support, and without this nothing in the system would notice.
 *
 * @table support_cases (columns)
 */

/**
 * Staff-only notes on a case.
 *
 * A SEPARATE TABLE rather than a flag on `messages`, and the reason is the
 * failure mode: `messages` is read through one shared visibility predicate
 * (`buildMessageConditions`), so a flag means every read path that forgets the
 * extra condition leaks an internal note to the tenant. A separate table cannot
 * leak by omission — it has to be joined deliberately.
 *
 * @table support_case_notes
 */
export const supportCaseNote = pgTable('support_case_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull(),
  // Denormalised so a note can never be served without its tenant scope.
  orgId: varchar('org_id', { length: 255 }).notNull(),
  content: text('content').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
}, (table) => ({
  caseIdx: index('support_case_note_case_idx').on(table.caseId, table.isActive),
}));

/** TypeScript types representing database rows */
export type SupportCase = typeof supportCase.$inferSelect;
export type SupportCaseInsert = typeof supportCase.$inferInsert;
export type SupportCaseUpdate = Partial<Omit<SupportCaseInsert, 'id' | 'createdAt' | 'createdBy' | 'orgId' | 'threadId' | 'displayNumber'>>;

export type SupportCaseCounter = typeof supportCaseCounter.$inferSelect;

export type SupportContact = typeof supportContact.$inferSelect;
export type SupportContactInsert = typeof supportContact.$inferInsert;

export type SupportCaseNote = typeof supportCaseNote.$inferSelect;
export type SupportCaseNoteInsert = typeof supportCaseNote.$inferInsert;
