// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Private (user-targeted) message threads, observed on a REAL Postgres.
 *
 * Org A sends org B a message targeted at user `alice`. When alice replies, the
 * reply row carries `org_id = org B` — and the unconditional SENDER branch of
 * `buildMessageConditions` used to show it to EVERY member of org B, leaking
 * the private exchange (and counting it unread for all of them). This suite
 * runs the exact predicate the service builds, as the application role under
 * RLS, against the shipped `postgres-init.sql`.
 */

import type { PGlite } from '@electric-sql/pglite';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { asTenant, bootInitDb } from '../src/testing/pglite-init.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
const { buildMessageConditions } = await import('../src/api/query-builders.js');

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ROOT = '11111111-1111-4111-8111-111111111111';
const ALICE_REPLY = '22222222-2222-4222-8222-222222222222';
const A_REPLY = '33333333-3333-4333-8333-333333333333';
const OPEN_ROOT = '44444444-4444-4444-8444-444444444444';
const OPEN_REPLY = '55555555-5555-4555-8555-555555555555';
// Same-org private message: dave (org C) to carol (org C).
const ORG_C = 'org-c';
const SAME_ORG_ROOT = '66666666-6666-4666-8666-666666666666';
const SAME_ORG_REPLY = '77777777-7777-4777-8777-777777777777';

let db: PGlite;

beforeAll(async () => {
  db = await bootInitDb();
  const ins = `INSERT INTO messages (id, org_id, thread_id, recipient_org_id, recipient_user_id, subject, content, created_by)
               VALUES ($1, $2, $3, $4, $5, 's', 'c', $6)`;
  // Private thread: A → B, targeted at alice.
  await db.query(ins, [ROOT, ORG_A, null, ORG_B, 'alice', 'a-user']);
  await db.query(ins, [ALICE_REPLY, ORG_B, ROOT, ORG_A, null, 'alice']); // alice answers A
  await db.query(ins, [A_REPLY, ORG_A, ROOT, ORG_B, 'alice', 'a-user']); // A answers alice
  // Ordinary org-wide thread: B's replies stay visible org-wide.
  await db.query(ins, [OPEN_ROOT, ORG_A, null, ORG_B, null, 'a-user']);
  await db.query(ins, [OPEN_REPLY, ORG_B, OPEN_ROOT, ORG_A, null, 'bob']);
  // Same org on both sides: the sender org IS the target org.
  await db.query(ins, [SAME_ORG_ROOT, ORG_C, null, ORG_C, 'carol', 'dave']);
  await db.query(ins, [SAME_ORG_REPLY, ORG_C, SAME_ORG_ROOT, ORG_C, 'carol', 'carol']);
}, 120_000);
afterAll(async () => { await db?.close(); });

/** Ids of the messages `viewer` in `orgId` can see through the service predicate. */
async function visible(orgId: string, viewerUserId?: string): Promise<string[]> {
  const where = and(...buildMessageConditions({ ...(viewerUserId ? { viewerUserId } : {}) }, orgId))!;
  const q = new PgDialect().sqlToQuery(where);
  return asTenant(db, { orgId }, async (c) =>
    (await c.query<{ id: string }>(`SELECT id FROM messages WHERE ${q.sql} ORDER BY id`, q.params as unknown[])).rows.map((r) => r.id));
}

describe('private thread replies (sender side of a user-targeted thread)', () => {
  it('the TARGET user sees the whole private thread, including their own reply', async () => {
    expect(await visible(ORG_B, 'alice')).toEqual(expect.arrayContaining([ROOT, ALICE_REPLY, A_REPLY]));
  });

  it('another member of the target org sees NONE of the private thread', async () => {
    const seen = await visible(ORG_B, 'bob');
    expect(seen).not.toContain(ROOT);
    expect(seen).not.toContain(ALICE_REPLY);
    expect(seen).not.toContain(A_REPLY);
    // …while ordinary org-wide threads are untouched.
    expect(seen).toEqual(expect.arrayContaining([OPEN_ROOT, OPEN_REPLY]));
  });

  it('with no viewer the private reply is hidden (fail-closed)', async () => {
    expect(await visible(ORG_B)).not.toContain(ALICE_REPLY);
  });

  it('the SENDER org (org-wide side) still sees the whole thread', async () => {
    expect(await visible(ORG_A, 'anyone')).toEqual(expect.arrayContaining([ROOT, ALICE_REPLY, A_REPLY, OPEN_ROOT, OPEN_REPLY]));
  });
});

describe('a private message inside ONE org (sender org = target org)', () => {
  it('another member of that org sees neither the root nor the reply', async () => {
    const seen = await visible(ORG_C, 'erin');
    expect(seen).not.toContain(SAME_ORG_ROOT);
    expect(seen).not.toContain(SAME_ORG_REPLY);
  });

  it('the target and the author both see the root', async () => {
    expect(await visible(ORG_C, 'carol')).toContain(SAME_ORG_ROOT);
    expect(await visible(ORG_C, 'dave')).toContain(SAME_ORG_ROOT);
  });

  it("the root's author sees the target's reply", async () => {
    expect(await visible(ORG_C, 'dave')).toContain(SAME_ORG_REPLY);
    expect(await visible(ORG_C, 'carol')).toContain(SAME_ORG_REPLY);
  });

  it('with no viewer the same-org private root is hidden (fail-closed)', async () => {
    expect(await visible(ORG_C)).not.toContain(SAME_ORG_ROOT);
  });
});
