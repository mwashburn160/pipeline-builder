// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The support-case schema against a REAL Postgres.
 *
 * These execute rather than typecheck, because the three things most likely to
 * be silently wrong here are all database behaviour, not TypeScript:
 *
 *  - the per-org number allocator's off-by-one, which differs between its INSERT
 *    and UPDATE branches and would hand two orgs the same visible case number or
 *    start everybody at 2;
 *  - the clock arithmetic, which is computed in SQL from the stored anchor;
 *  - the RLS policies, where `support_case_notes` is the interesting one: the
 *    note row carries a denormalised `org_id`, so the GENERIC org-scoped policy
 *    would have let the tenant read its own case's staff-only notes. The table
 *    being separate protects against application code forgetting a predicate;
 *    only the policy protects against the database allowing it. That is asserted
 *    here, not assumed.
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { asTenant, bootInitDb } from './helpers/pglite-init.js';

const ORG_A = '000000000000000000000a01';
const ORG_B = '000000000000000000000b01';
const THREAD_A1 = '11111111-1111-4111-8111-111111111111';
const THREAD_A2 = '22222222-2222-4222-8222-222222222222';
const THREAD_B1 = '33333333-3333-4333-8333-333333333333';

let db: PGlite;
beforeAll(async () => { db = await bootInitDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

/** The allocator, as `openSupportCase` runs it: upsert, then number = next-1. */
async function allocate(q: PGlite, orgId: string): Promise<number> {
  const r = await q.query<{ next_number: number }>(
    `INSERT INTO support_case_counters (org_id, next_number) VALUES ($1, 2)
     ON CONFLICT (org_id) DO UPDATE SET next_number = support_case_counters.next_number + 1,
                                        updated_at = CURRENT_TIMESTAMP
     RETURNING next_number`,
    [orgId],
  );
  return Number(r.rows[0]!.next_number) - 1;
}

const insertCase = `INSERT INTO support_cases
  (thread_id, org_id, display_number, level, severity, created_by, updated_by, tenant_contact)
  VALUES ($1, $2, $3, 'support_standard', 'normal', $4, $4, $4) RETURNING id, display_number`;

describe('per-org case number allocator', () => {
  it('starts at 1 and increments — both branches of the upsert', async () => {
    // The INSERT branch seeds next_number=2 and must yield 1; the UPDATE branch
    // has already incremented and must yield the value just consumed. Getting
    // either wrong means an org's first case is ACME-2, or two cases share one.
    await asTenant(db, { orgId: ORG_A, isSysadmin: true }, async (q) => {
      expect(await allocate(q, ORG_A)).toBe(1);
      expect(await allocate(q, ORG_A)).toBe(2);
      expect(await allocate(q, ORG_A)).toBe(3);
    });
  });

  it('counts per ORG, so one tenant cannot infer another tenant case volume', async () => {
    await asTenant(db, { orgId: ORG_A, isSysadmin: true }, async (q) => {
      expect(await allocate(q, ORG_A)).toBe(1);
      expect(await allocate(q, ORG_A)).toBe(2);
      // A fresh org starts its own sequence at 1, not at 3.
      expect(await allocate(q, ORG_B)).toBe(1);
    });
  });

  it('refuses a duplicate (org, number) — the backstop behind the allocator', async () => {
    await asTenant(db, { orgId: ORG_A, isSysadmin: true }, async (q) => {
      await q.query(insertCase, [THREAD_A1, ORG_A, 1, 'u1']);
      await expect(q.query(insertCase, [THREAD_A2, ORG_A, 1, 'u1'])).rejects.toThrow();
    });
  });

  it('refuses two cases on one thread — the thread root IS the case identity', async () => {
    await asTenant(db, { orgId: ORG_A, isSysadmin: true }, async (q) => {
      await q.query(insertCase, [THREAD_A1, ORG_A, 1, 'u1']);
      await expect(q.query(insertCase, [THREAD_A1, ORG_A, 2, 'u1'])).rejects.toThrow();
    });
  });
});

describe('the response clock', () => {
  it('accumulates ONLY the time spent awaiting the customer', async () => {
    await asTenant(db, { orgId: ORG_A, isSysadmin: true }, async (q) => {
      const ins = await q.query<{ id: string }>(insertCase, [THREAD_A1, ORG_A, 1, 'u1']);
      const id = ins.rows[0]!.id;

      // Enter awaiting_customer with an anchor 120s in the past.
      await q.query(
        `UPDATE support_cases SET status = 'awaiting_customer',
         awaiting_since = CURRENT_TIMESTAMP - INTERVAL '120 seconds' WHERE id = $1`, [id],
      );
      // Leaving folds the open span in and clears the anchor — the arithmetic
      // `setCaseStatus` performs in SQL against the stored anchor.
      await q.query(
        `UPDATE support_cases SET status = 'open', awaiting_since = NULL,
         awaiting_total_seconds = awaiting_total_seconds
           + COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - awaiting_since))::int, 0)
         WHERE id = $1`, [id],
      );
      const r = await q.query<{ awaiting_total_seconds: number; awaiting_since: string | null }>(
        'SELECT awaiting_total_seconds, awaiting_since FROM support_cases WHERE id = $1', [id],
      );
      expect(Number(r.rows[0]!.awaiting_total_seconds)).toBeGreaterThanOrEqual(119);
      expect(r.rows[0]!.awaiting_since).toBeNull();
    });
  });

  it('folding a NULL anchor adds nothing rather than nulling the accumulator', async () => {
    // A case that never waited on the customer must not have its total wiped by
    // a status change — COALESCE is what makes that true, and `+ NULL` in SQL
    // yields NULL, which would silently erase every previously banked second.
    await asTenant(db, { orgId: ORG_A, isSysadmin: true }, async (q) => {
      const ins = await q.query<{ id: string }>(insertCase, [THREAD_A1, ORG_A, 1, 'u1']);
      const id = ins.rows[0]!.id;
      await q.query('UPDATE support_cases SET awaiting_total_seconds = 42 WHERE id = $1', [id]);
      await q.query(
        `UPDATE support_cases SET status = 'open',
         awaiting_total_seconds = awaiting_total_seconds
           + COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - awaiting_since))::int, 0)
         WHERE id = $1`, [id],
      );
      const r = await q.query<{ awaiting_total_seconds: number }>(
        'SELECT awaiting_total_seconds FROM support_cases WHERE id = $1', [id],
      );
      expect(Number(r.rows[0]!.awaiting_total_seconds)).toBe(42);
    });
  });
});

describe('row-level security', () => {
  beforeAll(async () => {
    // Seed as sysadmin OUTSIDE asTenant's rollback so the RLS reads below have
    // rows to be denied. asTenant always rolls back, which is right for the
    // write tests and useless for these.
    await db.query(insertCase.replace(' RETURNING id, display_number', ''), [THREAD_B1, ORG_B, 1, 'b-user']);
    const r = await db.query<{ id: string }>('SELECT id FROM support_cases WHERE thread_id = $1', [THREAD_B1]);
    await db.query(
      'INSERT INTO support_case_notes (case_id, org_id, content, created_by) VALUES ($1, $2, $3, $4)',
      [r.rows[0]!.id, ORG_B, 'internal: customer is on a trial, do not escalate', 'staff-1'],
    );
  });

  it('a tenant sees its OWN cases', async () => {
    const r = await asTenant(db, { orgId: ORG_B }, (q) =>
      q.query<{ thread_id: string }>('SELECT thread_id FROM support_cases'));
    expect(r.rows.map((x) => x.thread_id)).toContain(THREAD_B1);
  });

  it('a tenant sees NOTHING of another tenant cases', async () => {
    const r = await asTenant(db, { orgId: ORG_A }, (q) =>
      q.query<{ thread_id: string }>('SELECT thread_id FROM support_cases'));
    expect(r.rows.map((x) => x.thread_id)).not.toContain(THREAD_B1);
  });

  it('staff see every tenant case — the queue has no org predicate', async () => {
    const r = await asTenant(db, { orgId: '', isSysadmin: true }, (q) =>
      q.query<{ thread_id: string }>('SELECT thread_id FROM support_cases'));
    expect(r.rows.map((x) => x.thread_id)).toContain(THREAD_B1);
  });

  it('THE ONE THAT MATTERS: the tenant cannot read staff-only notes on its own case', async () => {
    // `support_case_notes.org_id` is the tenant's, so the generic org-scoped
    // policy would have returned this row. It is excluded from that loop and
    // given sysadmin-only policies precisely so this read is empty.
    const r = await asTenant(db, { orgId: ORG_B }, (q) =>
      q.query<{ content: string }>('SELECT content FROM support_case_notes'));
    expect(r.rows).toEqual([]);
  });

  it('…while staff can', async () => {
    const r = await asTenant(db, { orgId: '', isSysadmin: true }, (q) =>
      q.query<{ content: string }>('SELECT content FROM support_case_notes'));
    expect(r.rows.map((x) => x.content)).toEqual([expect.stringContaining('do not escalate')]);
  });

  it('the tenant cannot WRITE a note onto its own case either', async () => {
    await asTenant(db, { orgId: ORG_B }, async (q) => {
      const r = await q.query<{ id: string }>('SELECT id FROM support_cases LIMIT 1');
      // The case is visible, so this is a genuine attempt and not a missing row.
      expect(r.rows.length).toBe(1);
      await expect(q.query(
        'INSERT INTO support_case_notes (case_id, org_id, content, created_by) VALUES ($1, $2, $3, $4)',
        [r.rows[0]!.id, ORG_B, 'tenant-authored', 'b-user'],
      )).rejects.toThrow();
    });
  });
});
