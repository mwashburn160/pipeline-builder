// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Support-case persistence: the workflow half of a support thread.
 *
 * Here rather than in a service because two callers need it — platform owns the
 * entitlement check and the writes, and the message service owns the thread the
 * case points at — and neither should grow its own copy of the allocator.
 *
 * `messages` keeps carrying the conversation. These functions only ever touch
 * the workflow axis: identity, status, ownership and the response clock.
 */

import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema } from '../database/drizzle-schema.js';
import type { SupportCase } from '../database/schema/support.js';
import { runWithTenantContext, withTenantTx } from '../database/tenancy.js';

/** Statuses a case can be in. `awaiting_customer` is what stops the clock. */
export const SUPPORT_CASE_STATUSES = ['open', 'awaiting_support', 'awaiting_customer', 'resolved', 'closed'] as const;
export type SupportCaseStatus = (typeof SUPPORT_CASE_STATUSES)[number];

/** The statuses the staff queue asks about — the ones still on us. */
export const QUEUE_STATUSES: readonly SupportCaseStatus[] = ['open', 'awaiting_support'];

/** What opening a case needs. `level` is frozen onto the row at open. */
export interface OpenCaseInput {
  /** The root `messages.id`. Becomes the canonical case identity. */
  threadId: string;
  orgId: string;
  /** The support level HELD AT OPEN, frozen so a mid-case downgrade cannot
   *  change the promise underneath someone already waiting. */
  level: string;
  severity: string;
  /** The opener. Also the initial tenant owner when they are a contact. */
  openedBy: string;
  /** True when the case was opened by spending a one-time incident rather than
   *  against a contact seat, so incident usage is answerable from the cases
   *  themselves and not only from a balance delta. */
  openedWithIncident?: boolean;
  /**
   * When the first response is due, already computed by the caller.
   *
   * Passed IN rather than derived here: the business calendar is deployment
   * config (`SUPPORT_BUSINESS_HOURS_*`) read by api-core's `responseDueAt`, and
   * this module must not reach for env to answer a product question. Null is a
   * legitimate value — a level with no published target, or a calendar too
   * broken to derive one — and is stored as "no deadline" rather than guessed.
   */
  responseDueAt?: Date | null;
}

/**
 * Allocate the next per-org case number.
 *
 * Postgres sequences are global and cannot be per-org without one sequence per
 * tenant, so the counter is a row. `UPDATE … RETURNING` takes the row lock,
 * which serialises concurrent opens WITHIN one org while leaving other orgs
 * untouched — a global sequence would serialise everybody, and would also
 * disclose total case volume to every customer.
 *
 * The upsert seeds `next_number = 2` on first use and returns 1, so an org's
 * first case is `ACME-1`. Must run inside the same transaction as the case
 * insert: a committed allocation with a rolled-back insert burns a number, and
 * a number burned is a gap a customer will eventually ask about.
 */
async function allocateDisplayNumber(tx: Parameters<Parameters<typeof withTenantTx>[0]>[0], orgId: string): Promise<number> {
  const rows = await tx
    .insert(schema.supportCaseCounter)
    .values({ orgId, nextNumber: 2 })
    .onConflictDoUpdate({
      target: schema.supportCaseCounter.orgId,
      set: {
        nextNumber: sql`${schema.supportCaseCounter.nextNumber} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ next: schema.supportCaseCounter.nextNumber });
  const next = rows[0]?.next;
  if (next === undefined) throw new Error('support case number allocation returned no row');
  // On INSERT the row is seeded at 2 and this case is 1; on UPDATE the stored
  // value has already been incremented, so this case is the value minus one.
  // Both branches therefore yield "the number just consumed".
  return next - 1;
}

/**
 * Open a case for an existing thread, allocating its display number.
 *
 * One transaction on purpose: the number and the row commit together or neither
 * does. `support_case_org_number_uq` is the backstop — if the allocator is ever
 * bypassed, the insert fails rather than issuing two cases the one identifier
 * customers quote back.
 */
export async function openSupportCase(input: OpenCaseInput): Promise<SupportCase> {
  return withTenantTx(async (tx) => {
    const displayNumber = await allocateDisplayNumber(tx, input.orgId);
    const rows = await tx
      .insert(schema.supportCase)
      .values({
        threadId: input.threadId,
        orgId: input.orgId,
        displayNumber,
        status: 'open',
        severity: input.severity,
        level: input.level,
        openedWithIncident: input.openedWithIncident ?? false,
        // Frozen at open, like `level`: a working-week or holiday change must
        // not move a promise already made.
        responseDueAt: input.responseDueAt ?? null,
        // The opener owns it on the tenant side until it is handed over.
        tenantContact: input.openedBy,
        createdBy: input.openedBy,
        updatedBy: input.openedBy,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('support case insert returned no row');
    return row;
  });
}

/** The case for a thread, or null. The thread root id IS the case identity. */
export async function findCaseByThread(threadId: string): Promise<SupportCase | null> {
  const rows = await withTenantTx((tx) => tx
    .select()
    .from(schema.supportCase)
    .where(and(eq(schema.supportCase.threadId, threadId), isNull(schema.supportCase.deletedAt)))
    .limit(1));
  return rows[0] ?? null;
}

/**
 * The staff queue: open cases across ALL tenants, oldest first.
 *
 * The one read with no org predicate, so it runs under sysadmin scope and is
 * served by the partial `support_case_queue_idx`.
 *
 * Ordered by `response_due_at` ASCENDING, NULLS LAST — soonest deadline first,
 * which is what "most at risk" actually means. Arrival order was the earlier
 * proxy for it and is a poor one: a standard case opened on Monday is owed
 * Wednesday's close while a priority case opened on Tuesday is owed Wednesday's
 * close too, so arrival order puts them in the wrong sequence whenever levels
 * are mixed. Cases with no deadline (an unrecognised level, or one opened while
 * the calendar was misconfigured) sort last rather than first, since a missing
 * deadline is not an urgent one; `createdAt` breaks ties so the order is stable.
 */
export async function listQueue(limit = 100): Promise<SupportCase[]> {
  return withTenantTx((tx) => tx
    .select()
    .from(schema.supportCase)
    .where(and(
      inArray(schema.supportCase.status, [...QUEUE_STATUSES]),
      isNull(schema.supportCase.deletedAt),
    ))
    .orderBy(sql`${schema.supportCase.responseDueAt} ASC NULLS LAST`, asc(schema.supportCase.createdAt))
    .limit(limit));
}

/**
 * Premium cases whose response target is approaching with no first response yet.
 *
 * THE on-call sweep's only query, and the reason the pager is worth owning the
 * trigger for: this is an EXACT per-case deadline, where the fleet alert
 * (`SupportPremiumFirstResponseAtRisk`) is a p90 over six hours that can only
 * say the distribution already drifted — never which case is about to breach.
 *
 * The predicate matches `support_case_response_due_idx` exactly, which is a
 * PARTIAL index on `(response_due_at) WHERE level = 'support_premium' AND
 * first_response_at IS NULL AND deleted_at IS NULL`. Note `level` and not
 * `is_premium`: that column lives on support_CONTACTS and marks an upgraded
 * contact, while a case freezes the opening contact's effective level at open —
 * so the case's own promise is its `level`, and flipping the contact later must
 * not change a deadline already published to a customer. That matters because this runs on a timer
 * forever: the rows it wants are a tiny and shrinking fraction of the table, so
 * the index stays small while the table grows, and without it every tick is a
 * scan.
 *
 * Deliberately NOT filtered on status. A case that is `awaiting_support` and one
 * that is `open` both owe a first response, and reading the status here would
 * duplicate a rule that `first_response_at IS NULL` already states exactly.
 */
export async function listCasesDueForPage(leadMs: number, limit = 100): Promise<SupportCase[]> {
  const cutoff = new Date(Date.now() + leadMs);
  // THIS FUNCTION IS THE PRIVILEGE BOUNDARY, so the scope is established here
  // rather than left to the caller. The sweep runs on a timer with no request
  // and therefore no tenant context, and `support_cases` is RLS FORCE'd — so
  // without a scope the read returns zero rows (and throws in production
  // `strict` mode), which is the shape of a sweep that silently covers nothing.
  // Cross-tenant is the point: one operator rota answers for every org's
  // premium cases. Only IDS leave here; the pager never receives case content.
  return runWithTenantContext({ isSuperAdmin: true }, () => withTenantTx((tx) => tx
    .select()
    .from(schema.supportCase)
    .where(and(
      eq(schema.supportCase.level, 'support_premium'),
      isNull(schema.supportCase.firstResponseAt),
      isNull(schema.supportCase.deletedAt),
      lte(schema.supportCase.responseDueAt, cutoff),
    ))
    .orderBy(asc(schema.supportCase.responseDueAt))
    .limit(limit)));
}

/** An org's own cases, newest first. */
export async function listOrgCases(orgId: string, limit = 100): Promise<SupportCase[]> {
  return withTenantTx((tx) => tx
    .select()
    .from(schema.supportCase)
    .where(and(eq(schema.supportCase.orgId, orgId), isNull(schema.supportCase.deletedAt)))
    .orderBy(sql`${schema.supportCase.createdAt} DESC`)
    .limit(limit));
}

/**
 * Stamp the first staff response, once.
 *
 * `first_response_at IS NULL` is in the WHERE clause rather than checked by the
 * caller: this is THE number the response target is sold on, so a second reply
 * must not be able to move it. Returns whether this call was the one that
 * stamped it.
 */
export async function stampFirstResponse(caseId: string, at: Date = new Date()): Promise<boolean> {
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCase)
    .set({ firstResponseAt: at, updatedAt: at })
    .where(and(eq(schema.supportCase.id, caseId), isNull(schema.supportCase.firstResponseAt)))
    .returning({ id: schema.supportCase.id }));
  return rows.length > 0;
}

/**
 * Move a case's status, maintaining the response clock.
 *
 * Entering `awaiting_customer` anchors `awaitingSince`; leaving it folds the
 * elapsed span into `awaitingTotalSeconds` and clears the anchor. Ageing then
 * subtracts the accumulator, so a case we answered in an hour and the tenant
 * replied to four days later does not read as a four-day case — which is the
 * number no customer would accept.
 *
 * The arithmetic is done in SQL against the stored anchor rather than from a
 * caller-supplied duration, so a clock skew or a lost round trip cannot inflate
 * or erase paused time.
 */
export async function setCaseStatus(
  caseId: string,
  status: SupportCaseStatus,
  actorId: string,
): Promise<SupportCase | null> {
  const now = new Date();
  const entering = status === 'awaiting_customer';
  const closing = status === 'closed' || status === 'resolved';
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCase)
    .set({
      status,
      updatedBy: actorId,
      updatedAt: now,
      // Anchor on entry; on any other transition fold the open span in and clear.
      awaitingSince: entering ? now : null,
      awaitingTotalSeconds: entering
        ? schema.supportCase.awaitingTotalSeconds
        : sql`${schema.supportCase.awaitingTotalSeconds} + COALESCE(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamptz - ${schema.supportCase.awaitingSince}))::int, 0)`,
      ...(closing ? { closedAt: now, closedBy: actorId } : { closedAt: null, closedBy: null }),
    })
    .where(and(eq(schema.supportCase.id, caseId), isNull(schema.supportCase.deletedAt)))
    .returning());
  return rows[0] ?? null;
}

/**
 * Re-rank a case's severity.
 *
 * STAFF ONLY at the route layer, and that is the governance point rather than a
 * permission detail: the tenant chooses severity when opening, so if they could
 * also change it afterwards they would unilaterally pick the response target
 * they are owed. Severity decides which target applies, so re-ranking has to be
 * ours.
 */
export async function setCaseSeverity(caseId: string, severity: string, actorId: string): Promise<string | null> {
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCase)
    .set({ severity, updatedBy: actorId, updatedAt: new Date() })
    .where(and(eq(schema.supportCase.id, caseId), isNull(schema.supportCase.deletedAt)))
    .returning({ severity: schema.supportCase.severity }));
  return rows[0]?.severity ?? null;
}

/**
 * Set or clear the STAFF owner.
 *
 * `null` is a legitimate value: it is the unowned pool, and how "I cannot take
 * this" is expressed without inventing a pseudo-assignee.
 */
export async function assignCase(caseId: string, assignedTo: string | null, actorId: string): Promise<SupportCase | null> {
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCase)
    .set({ assignedTo, updatedBy: actorId, updatedAt: new Date() })
    .where(and(eq(schema.supportCase.id, caseId), isNull(schema.supportCase.deletedAt)))
    .returning());
  return rows[0] ?? null;
}

/**
 * Assign or release MANY cases at once.
 *
 * One statement rather than a loop, which is the point: a staff member clearing
 * a queue of thirty selects thirty and acts once, and thirty round trips would
 * make the obvious interaction the slow one. It also makes the write ATOMIC — a
 * partial bulk assign leaves the queue in a state nobody chose, and the operator
 * cannot tell which half took.
 *
 * Returns the ids that actually moved rather than a count, so a caller can
 * report precisely what happened when the selection included something stale:
 * a case closed or reassigned by somebody else between the read and the click.
 * That is the normal case on a shared queue, not an edge one.
 */
export async function assignCases(
  caseIds: readonly string[],
  assignedTo: string | null,
  actorId: string,
): Promise<string[]> {
  if (caseIds.length === 0) return [];
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCase)
    .set({ assignedTo, updatedBy: actorId, updatedAt: new Date() })
    .where(and(
      inArray(schema.supportCase.id, [...caseIds]),
      isNull(schema.supportCase.deletedAt),
    ))
    .returning({ id: schema.supportCase.id }));
  return rows.map((r) => r.id);
}

/**
 * Close MANY cases at once.
 *
 * Separate from {@link assignCases} rather than a generic bulk-update, because
 * closing maintains the response clock — it folds the open awaiting span into
 * the accumulator and stamps `closedAt` — and a generic setter would quietly
 * skip that. The arithmetic is the same SQL `setCaseStatus` uses, for the same
 * reason: done against the STORED anchor so a clock skew cannot inflate paused
 * time.
 *
 * Only ever used to CLOSE. Bulk REOPENING is deliberately not offered: reopening
 * is staff-only and case-by-case by design, and a bulk reopen is how a queue
 * someone has finished with comes back all at once.
 */
export async function closeCases(caseIds: readonly string[], actorId: string): Promise<string[]> {
  if (caseIds.length === 0) return [];
  const now = new Date();
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCase)
    .set({
      status: 'closed',
      closedAt: now,
      closedBy: actorId,
      updatedBy: actorId,
      updatedAt: now,
      awaitingSince: null,
      awaitingTotalSeconds: sql`${schema.supportCase.awaitingTotalSeconds} + COALESCE(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamptz - ${schema.supportCase.awaitingSince}))::int, 0)`,
    })
    .where(and(
      inArray(schema.supportCase.id, [...caseIds]),
      isNull(schema.supportCase.deletedAt),
      // Already-closed cases are skipped rather than re-stamped, so a bulk
      // close over a selection that includes one does not move its closedAt.
      sql`${schema.supportCase.status} <> 'closed'`,
    ))
    .returning({ id: schema.supportCase.id }));
  return rows.map((r) => r.id);
}

/**
 * Hand the case to another tenant contact.
 *
 * Note what this does NOT touch: `createdBy`. That is the immutable audit fact
 * of who raised the case — mutating it to express "someone else owns this now"
 * would destroy the only record of who actually opened it. The caller must have
 * already checked that the target is a live designated contact; this function
 * will not infer entitlement from a user id.
 */
export async function transferCaseToContact(caseId: string, tenantContact: string, actorId: string): Promise<SupportCase | null> {
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCase)
    .set({ tenantContact, updatedBy: actorId, updatedAt: new Date() })
    .where(and(eq(schema.supportCase.id, caseId), isNull(schema.supportCase.deletedAt)))
    .returning());
  return rows[0] ?? null;
}

/**
 * A departing contact's open cases, so removal reassigns rather than orphans.
 *
 * Served by the partial `support_case_tenant_contact_idx`.
 */
export async function openCasesForContact(orgId: string, userId: string): Promise<SupportCase[]> {
  return withTenantTx((tx) => tx
    .select()
    .from(schema.supportCase)
    .where(and(
      eq(schema.supportCase.orgId, orgId),
      eq(schema.supportCase.tenantContact, userId),
      inArray(schema.supportCase.status, ['open', 'awaiting_support', 'awaiting_customer']),
      isNull(schema.supportCase.deletedAt),
    )));
}

/**
 * Cases raised across a scope within the last `windowDays` — the FAIR-USE count.
 *
 * WHAT IT IS FOR. Support is priced per CONTACT, and that unit assumes contacts
 * proxy for case volume. At ten seats they do; at a hundred they do not — three
 * named contacts become an internal help desk FORWARDING tickets, so the price
 * buys the interface rather than the load. This is the measurement that notices.
 *
 * WHY NOT THE QUOTA SERVICE. `QUOTA_RESET_DAYS` makes every tracked quota a
 * 3-day period, and a support allowance is monthly-shaped: five a month does not
 * divide into three days without rounding to something either far too loose or
 * useless. This table IS the counter — one range scan on
 * `support_case_org_created_idx`, no period mismatch, and nothing to drift out
 * of sync with reality.
 *
 * COUNTS EVERY CASE, INCLUDING CLOSED AND SOFT-DELETED. The question is how much
 * support was CONSUMED in the window, and a case that was answered and closed
 * consumed it just as much as an open one. Excluding closed cases would make the
 * allowance trivially evadable by closing promptly — the opposite of the
 * behaviour anyone wants to discourage.
 */
export async function countCasesInWindow(orgIds: readonly string[], windowDays: number): Promise<number> {
  if (orgIds.length === 0 || windowDays <= 0) return 0;
  const since = new Date(Date.now() - windowDays * 86400_000);
  const rows = await withTenantTx((tx) => tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.supportCase)
    .where(and(
      inArray(schema.supportCase.orgId, [...orgIds]),
      gte(schema.supportCase.createdAt, since),
    )));
  return rows[0]?.n ?? 0;
}

/**
 * Record the customer's verdict on a case.
 *
 * ONLY ON A TERMINAL CASE, enforced in the WHERE clause rather than by the
 * caller: rating a case still being worked would measure an answer nobody has
 * finished giving, and putting the condition in SQL means no route can forget
 * it.
 *
 * RE-RATEABLE on purpose. A customer who rates in frustration and comes back a
 * day later should be able to change it; freezing the first number would make
 * the metric measure how people felt at their worst moment. `satisfaction_at`
 * moves with it, so the ANSWER and WHEN it was given stay together.
 *
 * Returns whether a row moved — false means the case is missing, soft-deleted,
 * or not closed yet, which the caller must distinguish from a stored zero.
 */
export async function rateCase(
  caseId: string,
  satisfaction: number,
  comment: string | null,
): Promise<boolean> {
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCase)
    .set({ satisfaction, satisfactionComment: comment, satisfactionAt: new Date() })
    .where(and(
      eq(schema.supportCase.id, caseId),
      isNull(schema.supportCase.deletedAt),
      // Terminal only. `resolved` counts: we have claimed a fix, so the
      // customer is in a position to say whether it was one.
      inArray(schema.supportCase.status, ['resolved', 'closed']),
    ))
    .returning({ id: schema.supportCase.id }));
  return rows.length > 0;
}

// --- Staff notes ------------------------------------------------------------

/** One staff note, as the queue UI renders it. */
export interface SupportCaseNote {
  id: string;
  caseId: string;
  content: string;
  createdBy: string;
  createdAt: Date;
}

/**
 * Add a staff-only note to a case.
 *
 * `orgId` is denormalised onto the row from the CASE, not taken from the author:
 * a note belongs to the tenant whose case it annotates, and sourcing it from
 * the staff author's own org (the system org) would put every note outside the
 * tenant scope that is supposed to contain it.
 *
 * STAFF ONLY at the route layer, and the separate table is the reason that is
 * safe: `messages` is read through one shared visibility predicate, so a flag
 * there would leak an internal note from any read path that forgot the extra
 * condition. A separate table cannot leak by omission — it has to be joined
 * deliberately.
 */
export async function addCaseNote(
  caseId: string,
  orgId: string,
  content: string,
  createdBy: string,
): Promise<SupportCaseNote> {
  const rows = await withTenantTx((tx) => tx
    .insert(schema.supportCaseNote)
    .values({ caseId, orgId, content, createdBy })
    .returning());
  const row = rows[0];
  if (!row) throw new Error('support case note insert returned no row');
  return row;
}

/** Live notes on a case, oldest first — they read as a running commentary. */
export async function listCaseNotes(caseId: string): Promise<SupportCaseNote[]> {
  return withTenantTx((tx) => tx
    .select()
    .from(schema.supportCaseNote)
    .where(and(
      eq(schema.supportCaseNote.caseId, caseId),
      eq(schema.supportCaseNote.isActive, true),
      isNull(schema.supportCaseNote.deletedAt),
    ))
    .orderBy(asc(schema.supportCaseNote.createdAt)));
}

/**
 * Soft-delete a note.
 *
 * Soft because a note is a record of what the desk believed at the time, and a
 * dispute may turn on it. Returns whether a row moved, so a second delete is a
 * reported no-op rather than a silent success.
 */
export async function deleteCaseNote(noteId: string, deletedBy: string): Promise<boolean> {
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCaseNote)
    .set({ isActive: false, deletedAt: new Date(), deletedBy })
    .where(and(
      eq(schema.supportCaseNote.id, noteId),
      eq(schema.supportCaseNote.isActive, true),
    ))
    .returning({ id: schema.supportCaseNote.id }));
  return rows.length > 0;
}

// --- Canned responses -------------------------------------------------------

/** A reusable staff reply template. */
export interface CannedResponse {
  id: string;
  title: string;
  body: string;
}

/**
 * Live templates, alphabetical — the picker's only query.
 *
 * No org scope because the table has none: these are the vendor's own wording
 * for recurring questions, authored once and reused across every customer.
 * Scoping them per tenant would be the opposite of the point.
 */
export async function listCannedResponses(): Promise<CannedResponse[]> {
  return withTenantTx((tx) => tx
    .select({
      id: schema.supportCannedResponse.id,
      title: schema.supportCannedResponse.title,
      body: schema.supportCannedResponse.body,
    })
    .from(schema.supportCannedResponse)
    .where(eq(schema.supportCannedResponse.isActive, true))
    .orderBy(asc(schema.supportCannedResponse.title)));
}

/** Create a template. */
export async function createCannedResponse(
  title: string,
  body: string,
  actorId: string,
): Promise<CannedResponse> {
  const rows = await withTenantTx((tx) => tx
    .insert(schema.supportCannedResponse)
    .values({ title, body, createdBy: actorId, updatedBy: actorId })
    .returning({
      id: schema.supportCannedResponse.id,
      title: schema.supportCannedResponse.title,
      body: schema.supportCannedResponse.body,
    }));
  const row = rows[0];
  if (!row) throw new Error('canned response insert returned no row');
  return row;
}

/**
 * Edit a live template.
 *
 * Guarded on `is_active` so a retired template cannot be edited back into
 * circulation — a resurrection should be a deliberate new row, not a side
 * effect of fixing a typo.
 */
export async function updateCannedResponse(
  id: string,
  fields: { title?: string; body?: string },
  actorId: string,
): Promise<boolean> {
  if (fields.title === undefined && fields.body === undefined) return false;
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCannedResponse)
    .set({
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      updatedBy: actorId,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.supportCannedResponse.id, id),
      eq(schema.supportCannedResponse.isActive, true),
    ))
    .returning({ id: schema.supportCannedResponse.id }));
  return rows.length > 0;
}

/**
 * Retire a template.
 *
 * SOFT, because a retired template is still the explanation of what a past
 * reply said — deleting the row would leave old correspondence unaccountable
 * for its own wording.
 */
export async function deleteCannedResponse(id: string, actorId: string): Promise<boolean> {
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportCannedResponse)
    .set({ isActive: false, updatedBy: actorId, updatedAt: new Date() })
    .where(and(
      eq(schema.supportCannedResponse.id, id),
      eq(schema.supportCannedResponse.isActive, true),
    ))
    .returning({ id: schema.supportCannedResponse.id }));
  return rows.length > 0;
}

// --- Support contacts -------------------------------------------------------

/**
 * Live designated contacts across a set of orgs (an account subtree).
 *
 * Takes the whole scope in one query rather than per-org because the allowance
 * POOLS at the root: a person designated on a team spends the account's
 * allowance, so counting team-by-team and summing would be the same number by
 * accident and the wrong shape the moment pooling changes.
 */
export async function countActiveSupportContacts(orgIds: readonly string[]): Promise<number> {
  // Callers pass the expanded SUBTREE for the pooled cap, or a single org to ask
  // "may a case raised here have an owner at all". Both are legitimate; see
  // `SupportEntitlement` in platform for which field is which.
  if (orgIds.length === 0) return 0;
  const rows = await withTenantTx((tx) => tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.supportContact)
    .where(and(
      inArray(schema.supportContact.orgId, [...orgIds]),
      eq(schema.supportContact.isActive, true),
    )));
  return rows[0]?.n ?? 0;
}

/**
 * Live contacts for the tenant owner picker.
 *
 * SCOPE IS THE CALLER'S CHOICE, and the default is ONE ORG. The allowance pools
 * subtree-wide, but ownership does not: a team reassigns a case only among its
 * OWN contacts, so a pooled allowance never turns into one team's cases being
 * readable by a sibling. Pass a single org id for the picker; pass the expanded
 * subtree only where the pooled CAP is the question (see
 * `countActiveSupportContacts`).
 *
 * Taking a list rather than a single id keeps that decision at the call site
 * instead of hiding it here — the two scopes answer differently and the wrong
 * one leaks cases across teams.
 */
export async function listActiveSupportContacts(
  orgIds: readonly string[],
): Promise<{ orgId: string; userId: string; isPremium: boolean }[]> {
  if (orgIds.length === 0) return [];
  return withTenantTx((tx) => tx
    .select({
      orgId: schema.supportContact.orgId,
      userId: schema.supportContact.userId,
      // Carried so the admin panel can show who is upgraded without a second
      // query, and so the tenant owner picker can say which contacts carry 24x7.
      isPremium: schema.supportContact.isPremium,
    })
    .from(schema.supportContact)
    .where(and(
      inArray(schema.supportContact.orgId, [...orgIds]),
      eq(schema.supportContact.isActive, true),
    )));
}

/**
 * Whether this user is a live designated contact in any org of the scope.
 *
 * Transfer validation must pass the case's OWN org, not the subtree: accepting a
 * sibling team's contact as a valid transfer target is exactly the cross-team
 * leak the own-org ownership rule exists to prevent.
 */
export async function isSupportContact(orgIds: readonly string[], userId: string): Promise<boolean> {
  if (orgIds.length === 0) return false;
  const rows = await withTenantTx((tx) => tx
    .select({ id: schema.supportContact.id })
    .from(schema.supportContact)
    .where(and(
      inArray(schema.supportContact.orgId, [...orgIds]),
      eq(schema.supportContact.userId, userId),
      eq(schema.supportContact.isActive, true),
    ))
    .limit(1));
  return rows.length > 0;
}

/**
 * Designate a support contact.
 *
 * The CAP is not enforced here — the caller holds it, because the limit lives on
 * the Mongo org doc and this module only reaches Postgres. Mirrors how seats are
 * capped in platform rather than in the row writer.
 *
 * `support_contact_org_user_uq` is partial on `is_active = true`, so
 * re-designating someone previously revoked inserts a fresh row rather than
 * colliding — the revoked row stays as the record that they once held it.
 */
export async function designateSupportContact(
  orgId: string,
  userId: string,
  designatedBy: string,
  isPremium = false,
): Promise<void> {
  await withTenantTx(async (tx) => {
    await tx.insert(schema.supportContact)
      .values({ orgId, userId, designatedBy, isPremium })
      .onConflictDoNothing();
  });
}

/**
 * Live contacts in a scope that are UPGRADED to premium — the cap's counterpart.
 *
 * Counted separately from the baseline total because the two caps are separate:
 * an account holds N contacts (`supportContacts`) and upgrades M of them
 * (`supportPremiumContacts`), M ≤ N. Pooled over whatever scope the caller
 * passes, exactly like {@link countActiveSupportContacts} — subtree for the cap,
 * one org for an ownership question.
 */
export async function countPremiumSupportContacts(orgIds: readonly string[]): Promise<number> {
  if (orgIds.length === 0) return 0;
  const rows = await withTenantTx((tx) => tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.supportContact)
    .where(and(
      inArray(schema.supportContact.orgId, [...orgIds]),
      eq(schema.supportContact.isActive, true),
      eq(schema.supportContact.isPremium, true),
    )));
  return rows[0]?.n ?? 0;
}

/**
 * Whether this user is a live PREMIUM contact in the scope.
 *
 * The case-open path reads this to decide which level to freeze onto a new case:
 * premium when the opener is upgraded, the account's baseline otherwise. Pass the
 * case's OWN org — the upgrade follows the person in the org that nominated
 * them, and a sibling team's upgrade is not this org's to spend.
 */
export async function isPremiumSupportContact(orgIds: readonly string[], userId: string): Promise<boolean> {
  if (orgIds.length === 0) return false;
  const rows = await withTenantTx((tx) => tx
    .select({ id: schema.supportContact.id })
    .from(schema.supportContact)
    .where(and(
      inArray(schema.supportContact.orgId, [...orgIds]),
      eq(schema.supportContact.userId, userId),
      eq(schema.supportContact.isActive, true),
      eq(schema.supportContact.isPremium, true),
    ))
    .limit(1));
  return rows.length > 0;
}

/**
 * Upgrade or downgrade a LIVE contact.
 *
 * Guarded on `is_active` so a revoked row cannot be upgraded back into
 * relevance, and returns whether a row actually moved — the caller counts
 * against the premium cap before calling, and a silent no-op would let that
 * count drift from reality.
 *
 * Deliberately does NOT touch the case rows: `support_case.level` is frozen at
 * open, so downgrading somebody never weakens a promise already made on a case
 * they raised while upgraded.
 */
export async function setSupportContactPremium(
  orgId: string,
  userId: string,
  isPremium: boolean,
): Promise<boolean> {
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportContact)
    .set({ isPremium })
    .where(and(
      eq(schema.supportContact.orgId, orgId),
      eq(schema.supportContact.userId, userId),
      eq(schema.supportContact.isActive, true),
    ))
    .returning({ id: schema.supportContact.id }));
  return rows.length > 0;
}

/**
 * Revoke a designation, freeing the slot.
 *
 * Returns the user's still-open cases so the caller can reassign them instead of
 * orphaning — scope C4's answer. Revoking is deliberately not blocked on them:
 * refusing to remove a departed employee because they still own cases would be
 * worse than handing the cases on.
 */
export async function revokeSupportContact(
  orgId: string,
  userId: string,
  revokedBy: string,
): Promise<{ revoked: boolean; openCases: SupportCase[] }> {
  const openCases = await openCasesForContact(orgId, userId);
  const rows = await withTenantTx((tx) => tx
    .update(schema.supportContact)
    .set({ isActive: false, revokedAt: new Date(), revokedBy })
    .where(and(
      eq(schema.supportContact.orgId, orgId),
      eq(schema.supportContact.userId, userId),
      eq(schema.supportContact.isActive, true),
    ))
    .returning({ id: schema.supportContact.id }));
  return { revoked: rows.length > 0, openCases };
}
