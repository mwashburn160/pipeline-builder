// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The support-case service functions, over a recording fake transaction.
 *
 * The SQL suite proves the SCHEMA against a real Postgres — the allocator, the
 * uniqueness backstops, the RLS policies. This proves the FUNCTIONS: the payload
 * each one writes and the predicate it writes it under, which is where the
 * judgement lives.
 *
 * Two things recur and are worth naming once:
 *
 *  - The guard is in the WHERE clause, not in a caller's check.
 *    `stampFirstResponse` carries `first_response_at IS NULL` so a second staff
 *    reply cannot move the number the response target is sold on;
 *    `revokeSupportContact` carries `is_active = true` so a double revoke is a
 *    no-op rather than a resurrection.
 *  - `deleted_at IS NULL` is on every single-case mutation, so a soft-deleted
 *    case cannot be quietly reassigned or reopened.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fakeTx, renderSql, type FakeTx } from './helpers/fake-tx.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

let tx: FakeTx;

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (t: unknown) => unknown) => fn(tx.tx),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const svc = await import('../src/api/support-cases.js');

beforeEach(() => { tx = fakeTx(); });

/** The rendered WHERE of the i-th recorded statement. */
const where = (i = 0) => tx.queries[i]?.whereSql() ?? '';
/** The VALUES payload of the i-th recorded statement. */
const values = (i = 0) => tx.queries[i]?.arg('values') as Record<string, unknown> | undefined;
/** The SET payload of the i-th recorded statement. */
const set = (i = 0) => tx.queries[i]?.arg('set') as Record<string, unknown> | undefined;

describe('openSupportCase', () => {
  it('allocates the number and inserts in ONE transaction, numbering from the counter', async () => {
    // The upsert seeds next_number=2 and returns it, so the case being opened is
    // 1. Committing the allocation without the insert would burn a number, and a
    // gap is something a customer eventually asks about.
    tx.queue([{ next: 2 }], [{ id: 'c1', displayNumber: 1 }]);
    const row = await svc.openSupportCase({
      threadId: 't1', orgId: 'org-1', level: 'support_premium', severity: 'high', openedBy: 'u1',
    });
    expect(row).toMatchObject({ displayNumber: 1 });
    expect(tx.queries).toHaveLength(2);
    // "The number just consumed": seeded-at-2 and incremented-to-N both yield N-1.
    expect(values(1)).toMatchObject({ displayNumber: 1 });
  });

  it('numbers from the INCREMENTED counter on an existing org', async () => {
    tx.queue([{ next: 5 }], [{ id: 'c1' }]);
    await svc.openSupportCase({ threadId: 't1', orgId: 'org-1', level: 'support_standard', severity: 'normal', openedBy: 'u1' });
    expect(values(1)).toMatchObject({ displayNumber: 4 });
  });

  it('seeds the OPENER as the tenant owner, and never touches assignedTo', async () => {
    // The opener owns it on the tenant side until it is handed over; the staff
    // side starts unowned, which is what the unowned pool means.
    tx.queue([{ next: 2 }], [{ id: 'c1' }]);
    await svc.openSupportCase({ threadId: 't1', orgId: 'org-1', level: 'support_standard', severity: 'normal', openedBy: 'opener-9' });
    const ins = values(1)!;
    expect(ins).toMatchObject({ tenantContact: 'opener-9', createdBy: 'opener-9', status: 'open' });
    expect(ins).not.toHaveProperty('assignedTo');
  });

  it('freezes the level held AT OPEN onto the row', async () => {
    // So a mid-case downgrade cannot change the promise underneath someone
    // already waiting.
    tx.queue([{ next: 2 }], [{ id: 'c1' }]);
    await svc.openSupportCase({ threadId: 't1', orgId: 'org-1', level: 'support_premium', severity: 'urgent', openedBy: 'u1' });
    expect(values(1)).toMatchObject({ level: 'support_premium', severity: 'urgent' });
  });

  it('records when a case was opened by spending an incident, and defaults it false', async () => {
    tx.queue([{ next: 2 }], [{ id: 'c1' }]);
    await svc.openSupportCase({
      threadId: 't1', orgId: 'org-1', level: 'support_standard', severity: 'normal', openedBy: 'u1', openedWithIncident: true,
    });
    expect(values(1)).toMatchObject({ openedWithIncident: true });
    tx.reset();
    tx.queue([{ next: 2 }], [{ id: 'c1' }]);
    await svc.openSupportCase({ threadId: 't2', orgId: 'org-1', level: 'support_standard', severity: 'normal', openedBy: 'u1' });
    expect(values(1)).toMatchObject({ openedWithIncident: false });
  });

  it('throws rather than inventing a number when the allocator returns nothing', async () => {
    tx.queue([]);
    await expect(svc.openSupportCase({ threadId: 't1', orgId: 'o', level: 'l', severity: 's', openedBy: 'u' }))
      .rejects.toThrow(/allocation returned no row/);
  });

  it('throws when the insert returns nothing', async () => {
    tx.queue([{ next: 2 }], []);
    await expect(svc.openSupportCase({ threadId: 't1', orgId: 'o', level: 'l', severity: 's', openedBy: 'u' }))
      .rejects.toThrow(/insert returned no row/);
  });
});

describe('stampFirstResponse', () => {
  it('guards on first_response_at IS NULL so a SECOND reply cannot move the number', async () => {
    tx.queue([{ id: 'c1' }]);
    await expect(svc.stampFirstResponse('c1')).resolves.toBe(true);
    // THE assertion: the precondition is part of the UPDATE, not a prior read,
    // so two concurrent staff replies cannot both pass it.
    expect(where()).toMatch(/first_response_at.*is null/i);
  });

  it('reports false when it was not the one that stamped', async () => {
    tx.queue([]);
    await expect(svc.stampFirstResponse('c1')).resolves.toBe(false);
  });

  it('stamps the time it was given, not the time it ran', async () => {
    // The caller holds the reply's own timestamp; re-deriving it here would
    // credit a slow write path to the response target.
    const at = new Date('2026-03-01T12:00:00.000Z');
    tx.queue([{ id: 'c1' }]);
    await svc.stampFirstResponse('c1', at);
    expect(set()).toMatchObject({ firstResponseAt: at });
  });
});

describe('setCaseStatus', () => {
  it('anchors awaitingSince on ENTRY to awaiting_customer, leaving the total alone', async () => {
    tx.queue([{ id: 'c1', status: 'awaiting_customer' }]);
    await svc.setCaseStatus('c1', 'awaiting_customer', 'u1');
    const s = set()!;
    expect(s.awaitingSince).toBeInstanceOf(Date);
    // Entering must not fold anything in — there is no open span yet.
    expect(renderSql(s.awaitingTotalSeconds)).toBe('');
  });

  it('clears the anchor and folds the span in on any OTHER transition', async () => {
    tx.queue([{ id: 'c1', status: 'open' }]);
    await svc.setCaseStatus('c1', 'open', 'u1');
    const s = set()!;
    expect(s.awaitingSince).toBeNull();
    // The accumulator is SQL over the STORED anchor, not a caller-supplied
    // duration, so a clock skew or a lost round trip cannot inflate paused time.
    // COALESCE is what makes "was never paused" fold in as 0 rather than NULL.
    expect(renderSql(s.awaitingTotalSeconds)).toMatch(/coalesce/i);
    expect(renderSql(s.awaitingTotalSeconds)).toMatch(/awaiting_since/i);
  });

  it('stamps closedAt when closing OR resolving, and CLEARS it when reopening', async () => {
    for (const terminal of ['closed', 'resolved'] as const) {
      tx.reset();
      tx.queue([{ id: 'c1' }]);
      await svc.setCaseStatus('c1', terminal, 'staff-1');
      expect(set()).toMatchObject({ closedBy: 'staff-1' });
      expect(set()!.closedAt).toBeInstanceOf(Date);
    }
    tx.reset();
    tx.queue([{ id: 'c1' }]);
    await svc.setCaseStatus('c1', 'open', 'staff-1');
    // Reopening must not leave a closedAt behind, or the case reads as closed to
    // anything that checks the timestamp rather than the status.
    expect(set()).toMatchObject({ closedAt: null, closedBy: null });
  });

  it('refuses to act on a soft-deleted case, and reports null when nothing matched', async () => {
    tx.queue([]);
    await expect(svc.setCaseStatus('c1', 'open', 'u1')).resolves.toBeNull();
    expect(where()).toMatch(/deleted_at.*is null/i);
  });
});

describe('setCaseSeverity', () => {
  it('returns the stored severity and excludes soft-deleted rows', async () => {
    tx.queue([{ severity: 'urgent' }]);
    await expect(svc.setCaseSeverity('c1', 'urgent', 'staff-1')).resolves.toBe('urgent');
    expect(set()).toMatchObject({ severity: 'urgent', updatedBy: 'staff-1' });
    expect(where()).toMatch(/deleted_at.*is null/i);
  });

  it('returns null when no case matched', async () => {
    tx.queue([]);
    await expect(svc.setCaseSeverity('gone', 'high', 'staff-1')).resolves.toBeNull();
  });
});

describe('ownership', () => {
  it('assignCase accepts null — releasing to the unowned pool is a real value', async () => {
    tx.queue([{ id: 'c1', assignedTo: null }]);
    await expect(svc.assignCase('c1', null, 'staff-1')).resolves.toMatchObject({ assignedTo: null });
    expect(set()).toMatchObject({ assignedTo: null, updatedBy: 'staff-1' });
  });

  it('assignCase sets a staff owner', async () => {
    tx.queue([{ id: 'c1', assignedTo: 'staff-2' }]);
    await svc.assignCase('c1', 'staff-2', 'staff-1');
    expect(set()).toMatchObject({ assignedTo: 'staff-2' });
  });

  it('transferCaseToContact moves tenantContact and NEVER createdBy', async () => {
    // createdBy is the immutable audit fact of who raised the case. Mutating it
    // to express "someone else owns this now" would destroy the only record of
    // who actually opened it.
    tx.queue([{ id: 'c1', tenantContact: 'new-owner' }]);
    await svc.transferCaseToContact('c1', 'new-owner', 'actor-1');
    const s = set()!;
    expect(s).toMatchObject({ tenantContact: 'new-owner', updatedBy: 'actor-1' });
    expect(s).not.toHaveProperty('createdBy');
  });

  it('both return null for a case that does not match', async () => {
    tx.queue([]);
    await expect(svc.assignCase('gone', 'x', 'u')).resolves.toBeNull();
    tx.reset(); tx.queue([]);
    await expect(svc.transferCaseToContact('gone', 'x', 'u')).resolves.toBeNull();
  });
});

describe('contacts', () => {
  it('countActiveSupportContacts short-circuits an empty scope without querying', async () => {
    // Not a micro-optimisation: `inArray(col, [])` renders a predicate that can
    // behave unlike "no orgs", so the empty scope is answered before SQL.
    await expect(svc.countActiveSupportContacts([])).resolves.toBe(0);
    expect(tx.queries).toHaveLength(0);
  });

  it('counts only ACTIVE designations, across the whole scope in one query', async () => {
    tx.queue([{ n: 3 }]);
    await expect(svc.countActiveSupportContacts(['a', 'b'])).resolves.toBe(3);
    expect(tx.queries).toHaveLength(1);
    expect(where()).toMatch(/is_active/i);
  });

  it('reads a count-less result as 0 rather than NaN', async () => {
    tx.queue([]);
    await expect(svc.countActiveSupportContacts(['a'])).resolves.toBe(0);
  });

  it('listActiveSupportContacts short-circuits an empty scope', async () => {
    await expect(svc.listActiveSupportContacts([])).resolves.toEqual([]);
    expect(tx.queries).toHaveLength(0);
  });

  it('listActiveSupportContacts returns org and user, filtered to active', async () => {
    tx.queue([{ orgId: 'org-1', userId: 'u1' }]);
    await expect(svc.listActiveSupportContacts(['org-1'])).resolves.toEqual([{ orgId: 'org-1', userId: 'u1' }]);
    expect(where()).toMatch(/is_active/i);
  });

  it('isSupportContact is false for an empty scope, and never queries', async () => {
    await expect(svc.isSupportContact([], 'u1')).resolves.toBe(false);
    expect(tx.queries).toHaveLength(0);
  });

  it('isSupportContact matches on the user AND the scope AND active', async () => {
    tx.queue([{ id: 'contact-1' }]);
    await expect(svc.isSupportContact(['org-1'], 'u1')).resolves.toBe(true);
    const w = where();
    expect(w).toMatch(/user_id/i);
    expect(w).toMatch(/org_id/i);
    expect(w).toMatch(/is_active/i);
  });

  it('isSupportContact is false when nothing matched', async () => {
    tx.queue([]);
    await expect(svc.isSupportContact(['org-1'], 'u1')).resolves.toBe(false);
  });

  it('designateSupportContact is idempotent rather than erroring on a repeat', async () => {
    // The unique index is partial on is_active, so re-designating someone
    // previously revoked inserts a fresh row — the revoked row stays as the
    // record that they once held it — while a repeat of a LIVE designation does
    // nothing.
    tx.queue([]);
    await svc.designateSupportContact('org-1', 'u1', 'admin-1');
    expect(tx.of('insert')).toHaveLength(1);
    expect(values()).toMatchObject({ orgId: 'org-1', userId: 'u1', designatedBy: 'admin-1' });
    expect(tx.queries[0]?.arg('onConflictDoNothing')).toBeUndefined();
    expect(tx.queries[0]?.calls.map((c) => c.method)).toContain('onConflictDoNothing');
  });

  it('revokeSupportContact returns the open cases so the caller can reassign them', async () => {
    // Scope C4's answer: revoking is not blocked on open cases — refusing to
    // remove a departed employee because they still own cases is worse than
    // handing the cases on — so the caller is handed the list instead.
    tx.queue([{ id: 'case-1' }, { id: 'case-2' }], [{ id: 'contact-1' }]);
    const out = await svc.revokeSupportContact('org-1', 'u1', 'admin-1');
    expect(out.revoked).toBe(true);
    expect(out.openCases).toHaveLength(2);
    expect(set(1)).toMatchObject({ isActive: false, revokedBy: 'admin-1' });
  });

  it('guards the revoke on is_active so a double revoke is a no-op, not a resurrection', async () => {
    tx.queue([], []);
    await expect(svc.revokeSupportContact('org-1', 'u1', 'admin-1'))
      .resolves.toMatchObject({ revoked: false, openCases: [] });
    expect(where(1)).toMatch(/is_active/i);
  });
});

describe('reads', () => {
  it('findCaseByThread excludes soft-deleted rows', async () => {
    tx.queue([{ id: 'c1' }]);
    await expect(svc.findCaseByThread('t1')).resolves.toMatchObject({ id: 'c1' });
    expect(where()).toMatch(/deleted_at.*is null/i);
  });

  it('findCaseByThread resolves null when there is no case', async () => {
    // Threads raised before cases existed have none, deliberately — backfilling
    // would have put months-old "open" cases into the staff queue.
    tx.queue([]);
    await expect(svc.findCaseByThread('t1')).resolves.toBeNull();
  });

  it('listQueue asks for the ON-US statuses only, with NO org predicate', async () => {
    // The one read that spans tenants. An org predicate here would make it the
    // wrong query; the status predicate is what keeps it off the closed rows and
    // on the partial index.
    tx.queue([]);
    await svc.listQueue();
    const w = where();
    expect(w).toMatch(/status/i);
    expect(w).not.toMatch(/org_id/i);
    expect(svc.QUEUE_STATUSES).toEqual(['open', 'awaiting_support']);
  });

  it('listQueue bounds itself by default', async () => {
    tx.queue([]);
    await svc.listQueue();
    expect(tx.queries[0]?.arg('limit')).toBe(100);
  });

  it('listOrgCases scopes to the org', async () => {
    tx.queue([]);
    await svc.listOrgCases('org-1');
    expect(where()).toMatch(/org_id/i);
    expect(where()).toMatch(/deleted_at.*is null/i);
  });

  it('openCasesForContact asks for the three NON-TERMINAL statuses', async () => {
    // Including awaiting_customer: a case parked on the customer still needs a
    // new owner when its owner leaves.
    tx.queue([]);
    await svc.openCasesForContact('org-1', 'u1');
    const w = where();
    expect(w).toMatch(/tenant_contact/i);
    expect(w).toMatch(/org_id/i);
    expect(w).toMatch(/status/i);
  });
});

describe('bulk ownership', () => {
  it('assignCases writes ONE statement for the whole selection', async () => {
    // Not a loop: a staff member clearing thirty cases acts once, and thirty
    // round trips would make the obvious interaction the slow one. It also
    // makes the write atomic — a partial bulk assign leaves the queue in a
    // state nobody chose and the operator cannot tell which half took.
    tx.queue([{ id: 'c1' }, { id: 'c2' }]);
    await expect(svc.assignCases(['c1', 'c2'], 'staff-1', 'actor-1')).resolves.toEqual(['c1', 'c2']);
    expect(tx.queries).toHaveLength(1);
    expect(set()).toMatchObject({ assignedTo: 'staff-1', updatedBy: 'actor-1' });
  });

  it('assignCases accepts null — a bulk RELEASE is the common case', async () => {
    tx.queue([{ id: 'c1' }]);
    await svc.assignCases(['c1'], null, 'actor-1');
    expect(set()).toMatchObject({ assignedTo: null });
  });

  it('returns the ids that MOVED, not a count', async () => {
    // So a caller can say "1 of 3" when the selection included something a
    // colleague changed between the read and the click. On a shared queue that
    // is the normal case, not an edge one.
    tx.queue([{ id: 'c2' }]);
    await expect(svc.assignCases(['c1', 'c2', 'c3'], 'me', 'a')).resolves.toEqual(['c2']);
  });

  it('short-circuits an empty selection without querying', async () => {
    await expect(svc.assignCases([], 'me', 'a')).resolves.toEqual([]);
    await expect(svc.closeCases([], 'a')).resolves.toEqual([]);
    expect(tx.queries).toHaveLength(0);
  });

  it('closeCases maintains the response clock, like setCaseStatus does', async () => {
    // A generic bulk setter would quietly skip this: closing folds the open
    // awaiting span into the accumulator, done in SQL against the STORED anchor
    // so a clock skew cannot inflate paused time.
    tx.queue([{ id: 'c1' }]);
    await svc.closeCases(['c1'], 'staff-1');
    const s = set()!;
    expect(s).toMatchObject({ status: 'closed', closedBy: 'staff-1', awaitingSince: null });
    expect(s.closedAt).toBeInstanceOf(Date);
    expect(renderSql(s.awaitingTotalSeconds)).toMatch(/coalesce/i);
  });

  it('closeCases SKIPS already-closed cases rather than re-stamping them', async () => {
    // So a bulk close over a selection that includes one does not move its
    // closedAt and silently rewrite when it finished.
    tx.queue([{ id: 'c1' }]);
    await svc.closeCases(['c1', 'c2'], 'a');
    expect(where()).toMatch(/status.*<>/i);
  });

  it('both skip soft-deleted cases', async () => {
    tx.queue([]);
    await svc.assignCases(['c1'], 'me', 'a');
    expect(where()).toMatch(/deleted_at.*is null/i);
    tx.reset();
    tx.queue([]);
    await svc.closeCases(['c1'], 'a');
    expect(where()).toMatch(/deleted_at.*is null/i);
  });
});

describe('CSAT', () => {
  it('rates only a TERMINAL case, enforced in the WHERE clause', async () => {
    // In SQL rather than checked by the caller, so no route can forget it:
    // rating a case still being worked would judge an answer nobody has
    // finished giving.
    tx.queue([{ id: 'c1' }]);
    await expect(svc.rateCase('c1', 4, 'thanks')).resolves.toBe(true);
    const w = where();
    expect(w).toMatch(/status/i);
    expect(w).toMatch(/deleted_at.*is null/i);
    expect(set()).toMatchObject({ satisfaction: 4, satisfactionComment: 'thanks' });
  });

  it('stamps WHEN the rating was given, so answer and timing stay together', async () => {
    tx.queue([{ id: 'c1' }]);
    await svc.rateCase('c1', 5, null);
    expect(set()!.satisfactionAt).toBeInstanceOf(Date);
  });

  it('reports false when the case is missing or not finished yet', async () => {
    tx.queue([]);
    await expect(svc.rateCase('c1', 3, null)).resolves.toBe(false);
  });


});

describe('countCasesInWindow — the fair-use count', () => {
  it('counts EVERY case in the window, closed ones included', async () => {
    // The question is how much support was CONSUMED. Excluding closed cases
    // would make the allowance evadable by closing promptly, which is the
    // opposite of the behaviour to discourage — so there is no status predicate.
    tx.queue([{ n: 12 }]);
    await expect(svc.countCasesInWindow(['org-1'], 30)).resolves.toBe(12);
    const w = where();
    expect(w).toMatch(/created_at/i);
    expect(w).not.toMatch(/status/i);
    expect(w).not.toMatch(/deleted_at/i);
  });

  it('short-circuits an empty scope or a non-positive window', async () => {
    await expect(svc.countCasesInWindow([], 30)).resolves.toBe(0);
    await expect(svc.countCasesInWindow(['o'], 0)).resolves.toBe(0);
    expect(tx.queries).toHaveLength(0);
  });

  it('reads a count-less result as 0', async () => {
    tx.queue([]);
    await expect(svc.countCasesInWindow(['o'], 30)).resolves.toBe(0);
  });
});

describe('staff notes', () => {
  it('scopes a note to the org it is given, never inferring one', async () => {
    // The caller passes the CASE's org; the staff author's own org is the
    // system org, which would put every note outside the tenant scope meant to
    // contain it.
    tx.queue([{ id: 'n1', caseId: 'c1', content: 'x', createdBy: 'staff-1', createdAt: new Date() }]);
    await svc.addCaseNote('c1', 'tenant-9', 'checked their logs', 'staff-1');
    expect(values()).toMatchObject({ caseId: 'c1', orgId: 'tenant-9', createdBy: 'staff-1' });
  });

  it('throws rather than returning a half-made note', async () => {
    tx.queue([]);
    await expect(svc.addCaseNote('c1', 'o', 'x', 'u')).rejects.toThrow(/note insert returned no row/);
  });

  it('lists live notes OLDEST first — they read as a running commentary', async () => {
    tx.queue([]);
    await svc.listCaseNotes('c1');
    const w = where();
    expect(w).toMatch(/is_active/i);
    expect(w).toMatch(/deleted_at.*is null/i);
  });

  it('deletes SOFTLY and reports a second delete as a no-op', async () => {
    // Soft because a note records what the desk believed at the time, and a
    // dispute may turn on it. Guarded on is_active, so a repeat matches nothing
    // and "already gone" stays distinguishable from "removed".
    tx.queue([{ id: 'n1' }]);
    await expect(svc.deleteCaseNote('n1', 'staff-1')).resolves.toBe(true);
    expect(set()).toMatchObject({ isActive: false, deletedBy: 'staff-1' });
    expect(where()).toMatch(/is_active/i);
    tx.reset();
    tx.queue([]);
    await expect(svc.deleteCaseNote('n1', 'staff-1')).resolves.toBe(false);
  });
});

describe('canned responses', () => {
  it('lists LIVE templates with no org predicate at all', async () => {
    // System-wide on purpose: the vendor's own wording for recurring questions,
    // authored once and reused across every customer. An org predicate here
    // would be the opposite of the point — and the table has no org_id to
    // filter on.
    tx.queue([{ id: 't1', title: 'Key rotation', body: '…' }]);
    await expect(svc.listCannedResponses()).resolves.toEqual([{ id: 't1', title: 'Key rotation', body: '…' }]);
    const w = where();
    expect(w).toMatch(/is_active/i);
    expect(w).not.toMatch(/org_id/i);
  });

  it('creates a template, stamping the author on both sides', async () => {
    tx.queue([{ id: 't1', title: 'A', body: 'B' }]);
    await svc.createCannedResponse('A', 'B', 'staff-1');
    expect(values()).toMatchObject({ title: 'A', body: 'B', createdBy: 'staff-1', updatedBy: 'staff-1' });
  });

  it('throws when the insert returns nothing', async () => {
    tx.queue([]);
    await expect(svc.createCannedResponse('A', 'B', 'u')).rejects.toThrow(/canned response insert returned no row/);
  });

  it('updates only the fields given', async () => {
    tx.queue([{ id: 't1' }]);
    await svc.updateCannedResponse('t1', { title: 'New' }, 'staff-1');
    const s = set()!;
    expect(s).toMatchObject({ title: 'New', updatedBy: 'staff-1' });
    expect(s).not.toHaveProperty('body');
  });

  it('refuses an update with nothing to change, without querying', async () => {
    await expect(svc.updateCannedResponse('t1', {}, 'u')).resolves.toBe(false);
    expect(tx.queries).toHaveLength(0);
  });

  it('cannot edit a RETIRED template back into circulation', async () => {
    // A resurrection should be a deliberate new row, not a side effect of
    // fixing a typo.
    tx.queue([]);
    await expect(svc.updateCannedResponse('t1', { body: 'x' }, 'u')).resolves.toBe(false);
    expect(where()).toMatch(/is_active/i);
  });

  it('retires SOFTLY, and a second retire is a no-op', async () => {
    tx.queue([{ id: 't1' }]);
    await expect(svc.deleteCannedResponse('t1', 'staff-1')).resolves.toBe(true);
    expect(set()).toMatchObject({ isActive: false, updatedBy: 'staff-1' });
    tx.reset();
    tx.queue([]);
    await expect(svc.deleteCannedResponse('t1', 'staff-1')).resolves.toBe(false);
  });
});

describe('the premium contact subset', () => {
  it('counts only ACTIVE and PREMIUM contacts', async () => {
    tx.queue([{ n: 2 }]);
    await expect(svc.countPremiumSupportContacts(['a', 'b'])).resolves.toBe(2);
    const w = where();
    expect(w).toMatch(/is_active/i);
    expect(w).toMatch(/is_premium/i);
  });

  it('isPremiumSupportContact matches user AND scope AND both flags', async () => {
    tx.queue([{ id: 'c1' }]);
    await expect(svc.isPremiumSupportContact(['org-1'], 'u1')).resolves.toBe(true);
    const w = where();
    expect(w).toMatch(/user_id/i);
    expect(w).toMatch(/is_premium/i);
  });

  it('both short-circuit an empty scope', async () => {
    await expect(svc.countPremiumSupportContacts([])).resolves.toBe(0);
    await expect(svc.isPremiumSupportContact([], 'u1')).resolves.toBe(false);
    expect(tx.queries).toHaveLength(0);
  });

  it('upgrades a LIVE contact only, and touches no case rows', async () => {
    // Guarded on is_active so a revoked row cannot be upgraded back into
    // relevance. It deliberately does not touch cases: `support_case.level` is
    // frozen at open, so downgrading never weakens a promise already made on a
    // case raised while upgraded.
    tx.queue([{ id: 'contact-1' }]);
    await expect(svc.setSupportContactPremium('org-1', 'u1', true)).resolves.toBe(true);
    expect(set()).toMatchObject({ isPremium: true });
    expect(where()).toMatch(/is_active/i);
    expect(tx.queries).toHaveLength(1);
  });

  it('reports false when no live contact matched', async () => {
    tx.queue([]);
    await expect(svc.setSupportContactPremium('org-1', 'u1', false)).resolves.toBe(false);
  });

  it('designateSupportContact carries the initial premium flag', async () => {
    tx.queue([]);
    await svc.designateSupportContact('org-1', 'u1', 'admin-1', true);
    expect(values()).toMatchObject({ isPremium: true });
    tx.reset();
    tx.queue([]);
    await svc.designateSupportContact('org-1', 'u2', 'admin-1');
    expect(values()).toMatchObject({ isPremium: false });
  });
});
