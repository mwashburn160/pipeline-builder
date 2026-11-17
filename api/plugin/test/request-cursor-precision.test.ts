// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The publish-request keyset cursor against a REAL Postgres (PGlite).
 *
 * `plugin_publish_requests.created_at` is a `timestamptz` — MICROSECOND
 * precision — while the cursor is built from a JS `Date`, which holds
 * milliseconds. Comparing the raw column to the cursor's value meant the
 * `created_at = cursor` tie-break never matched: ascending pages REPEATED the
 * boundary row, descending pages SKIPPED the rest of its millisecond. Only a
 * real database has the sub-millisecond values that show it; the in-memory
 * double's dates are already millisecond-precision.
 */

import { describe, it, expect, afterAll, beforeEach, jest } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

const realPipelineData = await import('@pipeline-builder/pipeline-data');
const { bootTestDb } = await import('./helpers/pglite-db.js');
const testDb = await bootTestDb(() => realPipelineData.getTenantContext());
const raw = testDb.raw;

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...realPipelineData,
  withTenantTx: testDb.withTenantTx,
}));

const store = await import('../src/services/ecosystem/store.js');

afterAll(async () => { await raw.close(); });

let publisherId: string;

beforeEach(async () => {
  await raw.exec('DELETE FROM plugin_publish_requests;');
  const p = await raw.query<{ id: string }>("SELECT id FROM publishers WHERE handle = 'pipeline-builder'");
  publisherId = p.rows[0]!.id;
});

/**
 * Seed requests whose `created_at` differ only BELOW the millisecond — the
 * shape a burst of submissions has, and the one a ms cursor cannot tell apart.
 */
async function seedBurst(): Promise<string[]> {
  const stamps = [
    '2026-11-01T10:00:00.123100Z',
    '2026-11-01T10:00:00.123400Z',
    '2026-11-01T10:00:00.123700Z',
    '2026-11-01T10:00:00.124200Z',
    '2026-11-01T10:00:00.125900Z',
  ];
  const ids: string[] = [];
  for (const at of stamps) {
    const r = await raw.query<{ id: string }>(
      `INSERT INTO plugin_publish_requests (publisher_id, kind, status, submitted_by, created_at)
       VALUES ($1, 'profile_change', 'rejected', 'u', $2::timestamptz) RETURNING id`,
      [publisherId, at]);
    ids.push(r.rows[0]!.id);
  }
  return ids;
}

/** Walk every page of `order` at `limit`, the way the routes do (limit + 1 to see a next page). */
async function walk(order: 'asc' | 'desc', limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: ReturnType<typeof store.decodeRequestCursor> = null;
  for (let guard = 0; guard < 20; guard++) {
    const rows = await store.requests.list({ publisherId, order, limit: limit + 1, cursor: cursor === 'invalid' ? null : cursor });
    const page = rows.slice(0, limit);
    seen.push(...page.map((r) => r.id));
    if (rows.length <= limit) return seen;
    cursor = store.decodeRequestCursor(store.encodeRequestCursor(page[page.length - 1]!));
  }
  throw new Error('pagination did not terminate');
}

describe('publish-request keyset cursor with sub-millisecond created_at', () => {
  it.each([1, 2, 3])('ascending, page size %i: every row exactly once', async (limit) => {
    await seedBurst();
    const seen = await walk('asc', limit);
    expect(new Set(seen).size).toBe(seen.length); // no repeats
    expect(seen).toHaveLength(5); // no skips
  });

  it.each([1, 2, 3])('descending, page size %i: every row exactly once', async (limit) => {
    await seedBurst();
    const seen = await walk('desc', limit);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(5);
  });

  it('ascending and descending walks are exact reverses of each other', async () => {
    await seedBurst();
    const up = await walk('asc', 2);
    const down = await walk('desc', 2);
    expect(down).toEqual([...up].reverse());
  });
});
