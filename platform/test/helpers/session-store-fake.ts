// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory stand-in for `src/services/session/session-store.ts` — the module
 * every refresh-session read/write goes through. Unit tests that mock the model
 * barrel mock this module too, so a token issued in a test lands in `rows`
 * (and a test can seed `rows` with the slot a refresh / switch acts on):
 *
 *   const store = sessionStoreFake();
 *   jest.unstable_mockModule('../src/services/session/session-store.js', () => store);
 *
 * The behaviour mirrors the real module (per-kind cap, compare-and-set match,
 * tokenVersion liveness); the real one is exercised against Mongo by
 * refresh-sessions.integration.test.ts. Every function is a `jest.fn` so a test
 * can also assert on calls.
 */

import { jest } from '@jest/globals';

/** A stored slot (loosely typed — tests seed partial rows). */
export type FakeSlot = Record<string, any> & { userId: string; id: string; kind: string };

/**
 * The fake's functions are typed loosely: the inferred type names jest-mock's
 * `Mock`, which this package cannot reference (TS2883). Tests read `rows` and
 * the `jest.fn` call records.
 */
export interface SessionStoreFake {
  rows: FakeSlot[];
  reset(): void;
  [fn: string]: any;
}

export function sessionStoreFake(): SessionStoreFake {
  const rows: FakeSlot[] = [];
  const of = (userId: unknown) => String(userId);
  const store = {
    rows,
    insertSlot: jest.fn(async (userId: unknown, slot: Record<string, any>, cap: number) => {
      rows.push({ ...slot, userId: of(userId) } as FakeSlot);
      const mine = rows.filter((r) => r.userId === of(userId) && r.kind === slot.kind);
      const key = slot.kind === 'interactive' ? 'createdAt' : 'lastUsedAt';
      // Newest first, stable for equal times (later insert = newer).
      const ordered = mine.map((r, i) => ({ r, i }))
        .sort((a, b) => (new Date(b.r[key]).getTime() - new Date(a.r[key]).getTime()) || (b.i - a.i))
        .map((x) => x.r);
      const evicted = ordered.slice(cap);
      for (const e of evicted) rows.splice(rows.indexOf(e), 1);
      return evicted.map((e) => e.id);
    }),
    findSlot: jest.fn(async (userId: unknown, id: string) =>
      rows.find((r) => r.userId === of(userId) && r.id === id)),
    slotIsLive: jest.fn(async (userId: unknown, id: string, tokenVersion: number) =>
      rows.some((r) => r.userId === of(userId) && r.id === id && r.tokenVersion === tokenVersion)),
    updateSlotIf: jest.fn(async (userId: unknown, match: Record<string, unknown>, set: Record<string, unknown>) => {
      const row = rows.find((r) => r.userId === of(userId)
        && Object.entries(match).every(([k, v]) => (v === null ? r[k] == null : r[k] === v)));
      if (!row) return false;
      Object.assign(row, set);
      return true;
    }),
    deleteSlot: jest.fn(async (userId: unknown, id: string) => {
      const i = rows.findIndex((r) => r.userId === of(userId) && r.id === id);
      if (i >= 0) rows.splice(i, 1);
    }),
    deleteAllSlots: jest.fn(async (userIds: unknown, _session?: unknown) => {
      const ids = new Set((Array.isArray(userIds) ? userIds : [userIds]).map(of));
      for (let i = rows.length - 1; i >= 0; i -= 1) if (ids.has(rows[i].userId)) rows.splice(i, 1);
    }),
    listSlots: jest.fn(async (userId: unknown, tokenVersion: number) =>
      rows.filter((r) => r.userId === of(userId) && r.tokenVersion === tokenVersion)),
    clearEnrollmentPending: jest.fn(async (userId: unknown) => {
      for (const r of rows) if (r.userId === of(userId)) delete r.mfaEnrollmentPending;
    }),
    /** Empty the store (call from `beforeEach`). */
    reset() {
      rows.splice(0, rows.length);
    },
  };
  return store;
}
