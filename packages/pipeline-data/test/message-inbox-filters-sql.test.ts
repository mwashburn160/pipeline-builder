// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbox's bulk-action filters, executed on a REAL Postgres.
 *
 * `sentBy`, `senderUserId`, `counterpartyOrgId`, `ids` and the `hidden` flip
 * all reach `buildMessageConditions`, and the bulk hide / unhide / read /
 * delete routes act on exactly what it matches. A predicate that renders but
 * selects the wrong rows is a bulk write to the wrong rows, so these run the
 * shipped `postgres-init.sql` as the application role under RLS — the same
 * way `message-private-thread.test.ts` does.
 */

import type { PGlite } from '@electric-sql/pglite';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { asTenant, bootInitDb } from './helpers/pglite-init.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
const { buildMessageConditions } = await import('../src/api/query-builders.js');

const ME = 'org-me';
const ACME = 'org-acme';
const GLOBEX = 'org-globex';

// Root messages only (the inbox lists roots).
const MINE = '10000000-0000-4000-8000-000000000001'; // I (alice) sent to acme
const TEAMMATE = '10000000-0000-4000-8000-000000000002'; // bob (my org) sent to globex
const FROM_ACME = '10000000-0000-4000-8000-000000000003'; // acme sent to me
const FROM_GLOBEX = '10000000-0000-4000-8000-000000000004'; // globex sent to me — I hid it
const ELSEWHERE = '10000000-0000-4000-8000-000000000005'; // acme → globex, not mine to see

let db: PGlite;

beforeAll(async () => {
  db = await bootInitDb();
  const ins = `INSERT INTO messages (id, org_id, thread_id, recipient_org_id, subject, content, created_by, hidden_by)
               VALUES ($1, $2, NULL, $3, 's', 'c', $4, $5::jsonb)`;
  await db.query(ins, [MINE, ME, ACME, 'alice', '{}']);
  await db.query(ins, [TEAMMATE, ME, GLOBEX, 'bob', '{}']);
  await db.query(ins, [FROM_ACME, ACME, ME, 'acme-user', '{}']);
  await db.query(ins, [FROM_GLOBEX, GLOBEX, ME, 'globex-user', JSON.stringify({ [ME]: '2026-11-01T00:00:00Z' })]);
  await db.query(ins, [ELSEWHERE, ACME, GLOBEX, 'acme-user', '{}']);
}, 120_000);
afterAll(async () => { await db?.close(); });

/** Ids `alice` in ORG ME matches through the service predicate for `filter`. */
/** `viewerUserId: null` = no viewer stamped (a default param can't express that: `undefined` would fall back to it). */
async function match(filter: Parameters<typeof buildMessageConditions>[0], viewerUserId: string | null = 'alice'): Promise<string[]> {
  const where = and(...buildMessageConditions({ threadId: null, ...(viewerUserId ? { viewerUserId } : {}), ...filter }, ME))!;
  const q = new PgDialect().sqlToQuery(where);
  return asTenant(db, { orgId: ME }, async (c) =>
    (await c.query<{ id: string }>(`SELECT id FROM messages WHERE ${q.sql} ORDER BY id`, q.params as unknown[])).rows.map((r) => r.id));
}

describe('sentBy', () => {
  it("'me' is only what the viewer authored", async () => {
    expect(await match({ sentBy: 'me' })).toEqual([MINE]);
  });

  it("'me' with no viewer matches NOTHING (fail-closed)", async () => {
    expect(await match({ sentBy: 'me' }, null)).toEqual([]);
  });

  it("'org' is anything my org sent, any member", async () => {
    expect(await match({ sentBy: 'org' })).toEqual([MINE, TEAMMATE]);
  });

  it("'others' is what arrived from other orgs (still excluding what I hid)", async () => {
    expect(await match({ sentBy: 'others' })).toEqual([FROM_ACME]);
  });
});

describe('specific parties', () => {
  it('senderUserId narrows to one author, inside visibility', async () => {
    expect(await match({ senderUserId: 'bob' })).toEqual([TEAMMATE]);
    // acme-user authored a row I can't see — naming them never reaches it.
    expect(await match({ senderUserId: 'acme-user' })).toEqual([FROM_ACME]);
  });

  it('counterpartyOrgId matches both directions with that org', async () => {
    expect(await match({ counterpartyOrgId: ACME })).toEqual([MINE, FROM_ACME]);
    // Case-insensitive on the org id, like every other org comparison here.
    expect(await match({ counterpartyOrgId: 'ORG-ACME' })).toEqual([MINE, FROM_ACME]);
  });
});

describe('ids', () => {
  it('selects exactly the named visible rows', async () => {
    expect(await match({ ids: [MINE, FROM_ACME] })).toEqual([MINE, FROM_ACME]);
  });

  it('a named row outside visibility is simply not matched', async () => {
    expect(await match({ ids: [MINE, ELSEWHERE] })).toEqual([MINE]);
  });

  it('an EMPTY selection matches nothing', async () => {
    expect(await match({ ids: [] })).toEqual([]);
  });
});

describe('hidden flip', () => {
  it('the inbox excludes rows this org removed', async () => {
    expect(await match({})).toEqual([MINE, TEAMMATE, FROM_ACME]);
  });

  it('hidden: true is ONLY the rows this org removed', async () => {
    expect(await match({ hidden: true })).toEqual([FROM_GLOBEX]);
  });

  it('the hidden view composes with ids (the unhide scope)', async () => {
    expect(await match({ hidden: true, ids: [FROM_GLOBEX, FROM_ACME] })).toEqual([FROM_GLOBEX]);
  });
});

describe('the jsonb edits the bulk writes make', () => {
  // Mirrors MessageService.unhideFromInbox / setReadState(false): `map - key`
  // must drop THIS org's key and leave every other participant's untouched.
  it('`- key` removes only the named org from a stamp map', async () => {
    const { rows } = await db.query<{ m: Record<string, string> }>(
      'SELECT (coalesce($1::jsonb, \'{}\'::jsonb) - $2::text) AS m',
      [JSON.stringify({ [ME]: 't1', [ACME]: 't2' }), ME],
    );
    expect(rows[0]!.m).toEqual({ [ACME]: 't2' });
  });

  it('`- key` on a NULL map is an empty map, not NULL', async () => {
    const { rows } = await db.query<{ m: Record<string, string> }>('SELECT (coalesce(NULL::jsonb, \'{}\'::jsonb) - $1::text) AS m', [ME]);
    expect(rows[0]!.m).toEqual({});
  });
});
