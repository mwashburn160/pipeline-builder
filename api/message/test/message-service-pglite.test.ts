// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * MessageService's per-participant read / hidden state, against a REAL Postgres.
 *
 * The read/unread/hide paths are hand-written jsonb fragments —
 * `coalesce(read_by, '{}') || {key: now}`, `hidden_by - key`, `read_by ? key` —
 * composed with the shared visibility builder. The mock-based suite
 * (message-service.test.ts) can only check that a fragment was BUILT; this one
 * runs the service's real code, through pipeline-data's real `withTenantTx`, as
 * the application role under the init script's RLS
 * (`@pipeline-builder/pipeline-data/testing`), and asserts what the rows end up
 * holding.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { asTenantContext, bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';

const { messageService } = await import('../src/services/message-service.js');

let tdb: TenantTestDb;
// The raw PGlite handle's type, via the testing entry (PGlite is pipeline-data's dependency, not this service's).
type PGlite = TenantTestDb['pglite'];
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG_A = 'org-alpha';
const ORG_B = 'org-bravo';
const ORG_C = 'org-charlie';
const USER_A = 'user-a';
const USER_B = 'user-b';

/** Run as a member of `orgId` — the scope the request middleware establishes. */
const as = <T>(orgId: string, userId: string, fn: () => Promise<T>) => asTenantContext({ orgId, userId }, fn);

interface Seed { from?: string; to?: string; threadId?: string | null; subject?: string }

async function seed(s: Seed = {}): Promise<string> {
  const id = randomUUID();
  await owner((q) => q.query(
    `INSERT INTO messages (id, org_id, created_by, updated_by, recipient_org_id, thread_id, message_type, subject, content)
     VALUES ($1, $2, 'u', 'u', $3, $4, 'conversation', $5, 'body')`,
    [id, s.from ?? ORG_A, s.to ?? ORG_B, s.threadId ?? null, s.subject ?? 'hello'],
  ));
  return id;
}

async function row(id: string): Promise<{ read_by: Record<string, string>; hidden_by: Record<string, string> }> {
  const res = await owner((q) => q.query<{ read_by: Record<string, string>; hidden_by: Record<string, string> }>(
    'SELECT read_by, hidden_by FROM messages WHERE id = $1', [id],
  ));
  return res.rows[0]!;
}

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => { await tdb?.close(); });

beforeEach(async () => {
  await owner((q) => q.exec('DELETE FROM messages'));
  // The rows went out behind the service's back, so drop both orgs' cached
  // inbox pages too (the same call the age-out sweep makes after direct deletes);
  // otherwise a previous test's cached page leaks into this one.
  await messageService.invalidateRemovedMessages([
    { orgId: ORG_A, recipientOrgId: ORG_B },
    { orgId: ORG_B, recipientOrgId: ORG_A },
  ]);
});

describe('read state (real Postgres, RLS)', () => {
  it('markAsRead stamps ONLY the reader\'s key, so the other participant stays unread', async () => {
    const id = await seed();
    const unreadA = await as(ORG_A, USER_A, () => messageService.getUnreadCount(ORG_A));
    expect(await as(ORG_B, USER_B, () => messageService.getUnreadCount(ORG_B))).toBe(1);

    const updated = await as(ORG_B, USER_B, () => messageService.markAsRead(id, ORG_B, USER_B));
    expect(updated?.id).toBe(id);

    expect(Object.keys((await row(id)).read_by)).toEqual([ORG_B]);
    expect(await as(ORG_B, USER_B, () => messageService.getUnreadCount(ORG_B))).toBe(0);
    expect(await as(ORG_A, USER_A, () => messageService.getUnreadCount(ORG_A))).toBe(unreadA);
  });

  it('re-marking an already-read message is idempotent (returns it, keeps the first stamp)', async () => {
    const id = await seed();
    await as(ORG_B, USER_B, () => messageService.markAsRead(id, ORG_B, USER_B));
    const first = (await row(id)).read_by[ORG_B];
    const again = await as(ORG_B, USER_B, () => messageService.markAsRead(id, ORG_B, USER_B));
    expect(again?.id).toBe(id);
    expect((await row(id)).read_by[ORG_B]).toBe(first);
  });

  it('a non-participant cannot mark (or see) another pair\'s message', async () => {
    const id = await seed();
    expect(await as(ORG_C, 'user-c', () => messageService.markAsRead(id, ORG_C, 'user-c'))).toBeNull();
    expect((await row(id)).read_by).toEqual({});
  });

  it('setReadState(true) stamps the roots AND their replies; (false) clears the root only', async () => {
    const root = await seed();
    const reply = await seed({ from: ORG_B, to: ORG_A, threadId: root });

    expect(await as(ORG_B, USER_B, () => messageService.setReadState([root], true, ORG_B, USER_B))).toBe(2);
    expect(Object.keys((await row(root)).read_by)).toEqual([ORG_B]);
    expect(Object.keys((await row(reply)).read_by)).toEqual([ORG_B]);

    expect(await as(ORG_B, USER_B, () => messageService.setReadState([root], false, ORG_B, USER_B))).toBe(1);
    expect((await row(root)).read_by).toEqual({});
    // Un-reading the root must not invent unread replies the person did read.
    expect(Object.keys((await row(reply)).read_by)).toEqual([ORG_B]);
  });

  it('markThreadAsRead stamps every unread message in the thread for the caller only', async () => {
    const root = await seed();
    await seed({ from: ORG_B, to: ORG_A, threadId: root });
    await seed({ threadId: root });
    const updated = await as(ORG_B, USER_B, () => messageService.markThreadAsRead(root, ORG_B, USER_B));
    // The root is not itself in the thread (thread_id is NULL on a root).
    expect(updated).toHaveLength(2);
    expect(updated.every((m) => Object.keys(m.readBy as object).includes(ORG_B))).toBe(true);
  });
});

describe('hidden state (real Postgres, RLS)', () => {
  it('the SENDER can hide a conversation from its own inbox and unhide it', async () => {
    const id = await seed();
    const visibleA = async () => (await as(ORG_A, USER_A, () => messageService.findConversations(ORG_A))).data.map((m) => m.id);
    const visibleB = async () => (await as(ORG_B, USER_B, () => messageService.findConversations(ORG_B))).data.map((m) => m.id);
    expect(await as(ORG_A, USER_A, () => messageService.hideFromInbox('conversation', ORG_A, USER_A, { ids: [id] }))).toBe(1);
    expect(Object.keys((await row(id)).hidden_by)).toEqual([ORG_A]);
    expect(await visibleA()).toEqual([]);
    expect(await visibleB()).toEqual([id]);
    expect(await as(ORG_A, USER_A, () => messageService.unhideFromInbox([id], ORG_A, USER_A))).toBe(1);
    expect(await visibleA()).toEqual([id]);
  });

  /**
   * Regression: the participant guard trigger once refused the `hidden_by`
   * stamp, so every recipient-side hide/unhide was a 500.
   */
  it('hiding removes a conversation from THIS org\'s inbox only; unhide puts it back', async () => {
    const id = await seed();

    const visibleB = async () => (await as(ORG_B, USER_B, () => messageService.findConversations(ORG_B))).data.map((m) => m.id);
    const visibleA = async () => (await as(ORG_A, USER_A, () => messageService.findConversations(ORG_A))).data.map((m) => m.id);
    expect(await visibleB()).toEqual([id]);

    expect(await as(ORG_B, USER_B, () => messageService.hideFromInbox('conversation', ORG_B, USER_B, { ids: [id] }))).toBe(1);
    expect(Object.keys((await row(id)).hidden_by)).toEqual([ORG_B]);
    expect(await visibleB()).toEqual([]);
    // The other side's copy of the conversation is untouched.
    expect(await visibleA()).toEqual([id]);

    // Already hidden ⇒ not matched again.
    expect(await as(ORG_B, USER_B, () => messageService.hideFromInbox('conversation', ORG_B, USER_B, { ids: [id] }))).toBe(0);

    expect(await as(ORG_B, USER_B, () => messageService.unhideFromInbox([id], ORG_B, USER_B))).toBe(1);
    expect((await row(id)).hidden_by).toEqual({});
    expect(await visibleB()).toEqual([id]);
  });

  it('unhide only matches rows THIS org hid', async () => {
    const id = await seed();
    await as(ORG_A, USER_A, () => messageService.hideFromInbox('conversation', ORG_A, USER_A, { ids: [id] }));
    expect(await as(ORG_B, USER_B, () => messageService.unhideFromInbox([id], ORG_B, USER_B))).toBe(0);
    expect(Object.keys((await row(id)).hidden_by)).toEqual([ORG_A]);
  });

  it('a non-participant cannot hide another pair\'s message', async () => {
    const id = await seed();
    expect(await as(ORG_C, 'user-c', () => messageService.hideFromInbox(undefined, ORG_C, 'user-c', { ids: [id] }))).toBe(0);
    expect((await row(id)).hidden_by).toEqual({});
  });
});
