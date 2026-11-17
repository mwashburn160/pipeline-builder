// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The two support-case LISTS, executed on a REAL Postgres (the shipped init
 * script), through the real functions.
 *
 * Both lists used to stop at 100 rows with nothing telling the caller, and the
 * staff queue took its LIMIT on `response_due_at` while the route re-sorted the
 * page on waiting time — so past 100 open cases the longest-waiting case could
 * be the one dropped. What is pinned here is database behaviour the fake-tx
 * suite cannot see: the wait-anchor ordering arithmetic, the keyset cursor's
 * text round trip at microsecond precision, and that walking the pages returns
 * every case exactly once.
 */

import type { PGlite } from '@electric-sql/pglite';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { drizzle } from 'drizzle-orm/pglite';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { bootInitDb } from '../src/testing/pglite-init.js';

let db: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let orm: any;

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  // The superuser connection: RLS is proven in support-cases-sql.test.ts; this
  // suite is about ordering and paging.
  withTenantTx: (fn: (t: unknown) => unknown) => fn(orm),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const svc = await import('../src/api/support-cases.js');
const { schema } = await import('../src/database/drizzle-schema.js');

const ORG_A = '000000000000000000000a01';
const ORG_B = '000000000000000000000b01';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Insert one case. `created` / `due` are SQL expressions (fixtures, never input). */
async function insertCase(n: number, org: string, opts: { created: string; awaiting?: number; due?: string | null; status?: string }): Promise<void> {
  await db.query(
    `INSERT INTO support_cases
       (id, thread_id, org_id, display_number, level, severity, created_by, updated_by, tenant_contact,
        status, created_at, awaiting_total_seconds, response_due_at)
     VALUES ($1, $2, $3, $4, 'support_standard', 'normal', 'u', 'u', 'u', $5, ${opts.created}, $6, ${opts.due ?? 'NULL'})`,
    [uuid(n), uuid(1000 + n), org, n, opts.status ?? 'open', opts.awaiting ?? 0],
  );
}

beforeAll(async () => {
  db = await bootInitDb();
  orm = drizzle(db, { schema });
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('listQueue (staff queue)', () => {
  beforeAll(async () => {
    await db.query('DELETE FROM support_cases');
    // Waiting = now - created - awaiting. Opened earliest is NOT longest waiting
    // once a case spent days on the customer, and the soonest DUE is neither.
    await insertCase(1, ORG_A, { created: "now() - interval '10 days'", awaiting: 9 * 86400, due: 'now()' }); // waiting ~1d, due soonest
    await insertCase(2, ORG_A, { created: "now() - interval '5 days'", due: "now() + interval '3 days'" }); // waiting 5d
    await insertCase(3, ORG_B, { created: "now() - interval '3 days'", due: "now() + interval '1 day'" }); // waiting 3d
    await insertCase(4, ORG_B, { created: "now() - interval '2 days'", due: null }); // waiting 2d
    await insertCase(5, ORG_A, { created: "now() - interval '30 days'", status: 'closed' }); // not on the queue
    await insertCase(6, ORG_A, { created: "now() - interval '20 days'", status: 'awaiting_customer' }); // not on us
  });

  it('takes the LIMIT on waiting time — the longest-waiting case is never the one cut', async () => {
    const page = await svc.listQueue({ limit: 2 });
    expect(page.cases.map((c) => c.id)).toEqual([uuid(2), uuid(3)]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('walks every open case exactly once, in waiting order', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await svc.listQueue({ limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.cases.map((c) => c.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([uuid(2), uuid(3), uuid(4), uuid(1)]);
  });
});

describe('listOrgCases (tenant list)', () => {
  beforeAll(async () => {
    await db.query('DELETE FROM support_cases');
    // Three cases in the SAME microsecond — the id tie-breaker and the cursor's
    // full-precision text are what keep paging from repeating or skipping them.
    for (const n of [11, 12, 13]) await insertCase(n, ORG_A, { created: "'2026-11-01 10:00:00.123456+00'" });
    await insertCase(14, ORG_A, { created: "'2026-11-02 10:00:00+00'", status: 'closed' });
    await insertCase(15, ORG_A, { created: "'2026-10-01 10:00:00+00'" });
    await insertCase(16, ORG_B, { created: "'2026-11-03 10:00:00+00'" });
  });

  it('pages newest first (closed cases included) and reports hasMore', async () => {
    const page = await svc.listOrgCases(ORG_A, { limit: 2 });
    expect(page.cases.map((c) => c.id)).toEqual([uuid(14), uuid(13)]);
    expect(page.hasMore).toBe(true);
  });

  it('walks every one of the org\'s cases exactly once, never another org\'s', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await svc.listOrgCases(ORG_A, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.cases.map((c) => c.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([uuid(14), uuid(13), uuid(12), uuid(11), uuid(15)]);
  });

  it('a page exactly the size of the rest says there is no more', async () => {
    const page = await svc.listOrgCases(ORG_A, { limit: 5 });
    expect(page.cases).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('listCasesDueForPage (on-call sweep)', () => {
  const insertPremium = (n: number, status: string, closed: boolean) => db.query(
    `INSERT INTO support_cases
       (id, thread_id, org_id, display_number, level, severity, created_by, updated_by, tenant_contact,
        status, response_due_at, closed_at)
     VALUES ($1, $2, $3, $4, 'support_premium', 'high', 'u', 'u', 'u', $5, now() + interval '5 minutes', ${closed ? 'now()' : 'NULL'})`,
    [uuid(n), uuid(1000 + n), ORG_A, n, status],
  );

  beforeAll(async () => {
    await db.query('DELETE FROM support_cases');
    await insertPremium(21, 'open', false);
  });

  it('a case closed before any response stops paging, and pages again once reopened', async () => {
    await insertPremium(22, 'awaiting_support', false);
    await insertPremium(23, 'closed', true);
    expect((await svc.listCasesDueForPage(3_600_000)).map((c) => c.id)).toEqual([uuid(21), uuid(22)]);

    // Through the real transition, not a fixture: closing stamps closed_at and
    // leaves first_response_at NULL — the exact shape that used to page forever.
    await svc.setCaseStatus(uuid(22), 'resolved', 'staff-1');
    expect((await svc.listCasesDueForPage(3_600_000)).map((c) => c.id)).toEqual([uuid(21)]);

    await svc.setCaseStatus(uuid(22), 'open', 'staff-1');
    expect((await svc.listCasesDueForPage(3_600_000)).map((c) => c.id).sort()).toEqual([uuid(21), uuid(22)]);
  });
});
