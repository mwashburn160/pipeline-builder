// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The durable cascade outbox — unit level, over an in-memory stand-in for the
 * `cascade_outbox` collection (the real-Mongo, transactional behaviour is
 * `cascade-outbox.integration.test.ts`).
 *
 * Pins:
 *  - enqueue writes one leg per downstream service IN the caller's session, and
 *    is idempotent (a re-enqueue never resets a leg's progress);
 *  - a 2xx marks the leg done; a failure reschedules it with exponential,
 *    capped backoff and records why;
 *  - at the attempt ceiling the leg goes dead: metered
 *    (`platform_cascade_dead_total{service,kind}`), audited (`org.cascade.dead`)
 *    and — for a user erasure — still counted by the pre-outbox erasure metric;
 *  - a leased (in-flight) leg is not delivered twice until its lease lapses, and
 *    redelivering an already-acked leg is harmless;
 *  - a dispatcher never throws for a leg.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  organization: {
    cascadeOutbox: { intervalMs: 30_000, batchSize: 50, maxAttempts: 4, backoffBaseMs: 1000, backoffMaxMs: 5000, leaseMs: 60_000 },
  },
}));

// ---------------------------------------------------------------------------
// In-memory `cascade_outbox`
// ---------------------------------------------------------------------------

type Row = Record<string, any> & { _id: string };
const rows: Row[] = [];
const sessions: unknown[] = [];
let nextId = 0;

const matches = (row: Row, filter: Record<string, any>): boolean => Object.entries(filter).every(([k, v]) => {
  if (v && typeof v === 'object' && !(v instanceof Date) && '$lte' in v) return row[k] <= v.$lte;
  return row[k] === v;
});
const leanOf = <T>(v: T) => ({ lean: async () => (v === null ? null : structuredClone(v)) });

const fakeModel = {
  bulkWrite: jest.fn(async (ops: Array<{ updateOne: { filter: Record<string, any>; update: { $setOnInsert: Record<string, any> } } }>, opts: { session?: unknown }) => {
    sessions.push(opts.session);
    for (const { updateOne: { filter, update } } of ops) {
      if (!rows.some((r) => matches(r, filter))) rows.push({ _id: `leg-${nextId++}`, createdAt: new Date(0), ...update.$setOnInsert });
    }
    return {};
  }),
  find: jest.fn((filter: Record<string, any>) => {
    const q = {
      _limit: Infinity,
      sort: () => q,
      limit: (n: number) => { q._limit = n; return q; },
      select: () => q,
      lean: async () => rows.filter((r) => matches(r, filter))
        .sort((a, b) => (a.nextAttemptAt as Date).getTime() - (b.nextAttemptAt as Date).getTime())
        .slice(0, q._limit)
        .map((r) => structuredClone(r)),
    };
    return q;
  }),
  findOneAndUpdate: jest.fn((filter: Record<string, any>, update: { $set: Record<string, any> }) => {
    const row = rows.find((r) => matches(r, filter));
    if (row) Object.assign(row, update.$set);
    return leanOf(row ?? null);
  }),
  updateOne: jest.fn(async (filter: Record<string, any>, update: { $set: Record<string, any> }) => {
    const row = rows.find((r) => matches(r, filter));
    if (row) Object.assign(row, update.$set);
    return { modifiedCount: row ? 1 : 0 };
  }),
};
jest.unstable_mockModule('../src/models/cascade-outbox.js', () => ({ __esModule: true, default: fakeModel }));

// ---------------------------------------------------------------------------
// Legs, metrics, audit
// ---------------------------------------------------------------------------

const mockDeliver = jest.fn<AnyFn>();
const LEGS = [
  { kind: 'org.deleted', service: 'pipeline', deliver: (id: string) => mockDeliver('pipeline', id) },
  { kind: 'org.deleted', service: 'quota', deliver: (id: string) => mockDeliver('quota', id) },
  { kind: 'user.erased', service: 'plugin', deliver: (id: string) => mockDeliver('plugin', id) },
];
jest.unstable_mockModule('../src/services/cascade-legs.js', () => ({
  legsFor: (kind: string) => LEGS.filter((l) => l.kind === kind),
  findLeg: (kind: string, service: string) => LEGS.find((l) => l.kind === kind && l.service === service),
}));
const mockIncCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));
const mockAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ recordAuditEvent: (...a: unknown[]) => mockAudit(...a) }));

const { enqueueCascade, dispatchCascadeOutbox, cascadeBackoffMs, cascadeStatus, cascadeOutboxSweep } = await import('../src/services/cascade-outbox.js');

const T0 = new Date('2026-11-17T00:00:00Z');
let clock = T0.getTime();
const now = () => new Date(clock);
const advance = (ms: number) => { clock += ms; };
const dispatch = (over: Record<string, unknown> = {}) => dispatchCascadeOutbox(undefined, { now, ...over });
const legOf = (service: string, kind = 'org.deleted') => rows.find((r) => r.service === service && r.kind === kind)!;
const SESSION = { id: 'tx-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockIncCounter.mockReset();
  mockAudit.mockReset();
  rows.length = 0;
  sessions.length = 0;
  clock = T0.getTime();
  mockDeliver.mockResolvedValue({ ok: true, statusCode: 200 });
});

describe('cascadeBackoffMs', () => {
  it('doubles from the base and caps at the max', () => {
    expect([1, 2, 3, 4, 5].map((n) => cascadeBackoffMs(n, 1000, 10_000))).toEqual([1000, 2000, 4000, 8000, 10_000]);
  });

  it('never overflows to Infinity for an absurd attempt count', () => {
    expect(cascadeBackoffMs(10_000, 1000, 60_000)).toBe(60_000);
    expect(cascadeBackoffMs(0, 1000, 60_000)).toBe(1000);
  });
});

describe('enqueueCascade', () => {
  it('writes one pending leg per downstream service, IN the caller\'s session', async () => {
    const legs = await enqueueCascade('org.deleted', 'org-1', SESSION as never, now());
    expect(legs).toEqual(['pipeline', 'quota']);
    expect(sessions).toEqual([SESSION]);
    expect(rows.map((r) => [r.kind, r.subjectId, r.service, r.status, r.attempts])).toEqual([
      ['org.deleted', 'org-1', 'pipeline', 'pending', 0],
      ['org.deleted', 'org-1', 'quota', 'pending', 0],
    ]);
    // Due immediately.
    expect(legOf('pipeline').nextAttemptAt).toEqual(T0);
  });

  it('is idempotent: a re-enqueue (a transaction retry, a re-run purge) never resets progress', async () => {
    await enqueueCascade('org.deleted', 'org-1', SESSION as never, now());
    await dispatch();
    expect(legOf('pipeline').status).toBe('done');

    await enqueueCascade('org.deleted', 'org-1', SESSION as never, now());
    expect(rows).toHaveLength(2);
    expect(legOf('pipeline')).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('a user erasure gets only the user legs', async () => {
    expect(await enqueueCascade('user.erased', 'u-1', SESSION as never)).toEqual(['plugin']);
    expect(rows.map((r) => r.service)).toEqual(['plugin']);
  });
});

describe('dispatchCascadeOutbox', () => {
  beforeEach(async () => {
    await enqueueCascade('org.deleted', 'org-1', SESSION as never, now());
  });

  it('delivers every due leg and marks it done on a 2xx', async () => {
    const res = await dispatch();
    expect(res).toEqual({ scanned: 2, delivered: 2, retried: 0, dead: 0, skipped: 0 });
    expect(mockDeliver.mock.calls).toEqual([['pipeline', 'org-1'], ['quota', 'org-1']]);
    expect(legOf('pipeline')).toMatchObject({ status: 'done', attempts: 1, lastError: null, lastStatusCode: 200, completedAt: T0 });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_cascade_delivery_total', { service: 'pipeline', kind: 'org.deleted', result: 'delivered' });
  });

  it('reschedules a failure with exponential backoff and records why', async () => {
    mockDeliver.mockImplementation(async (service: string) => (service === 'quota'
      ? { ok: false, statusCode: 503, error: 'HTTP 503' }
      : { ok: true, statusCode: 200 }));

    await dispatch();
    expect(legOf('quota')).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'HTTP 503',
      lastStatusCode: 503,
      nextAttemptAt: new Date(T0.getTime() + 1000),
    });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_cascade_delivery_total', { service: 'quota', kind: 'org.deleted', result: 'retried' });

    // Not due yet: nothing is delivered.
    advance(999);
    expect((await dispatch()).scanned).toBe(0);

    // Due: second failure doubles the delay.
    advance(1);
    await dispatch();
    expect(legOf('quota')).toMatchObject({ attempts: 2, nextAttemptAt: new Date(clock + 2000) });

    // The service recovers: the next attempt lands.
    mockDeliver.mockResolvedValue({ ok: true, statusCode: 200 });
    advance(2000);
    await dispatch();
    expect(legOf('quota')).toMatchObject({ status: 'done', attempts: 3, lastError: null });
  });

  it('dead-letters a leg at the attempt ceiling: metered, logged and audited', async () => {
    mockDeliver.mockImplementation(async (service: string) => (service === 'quota'
      ? { ok: false, statusCode: 500, error: 'HTTP 500' }
      : { ok: true, statusCode: 200 }));

    for (let i = 0; i < 4; i += 1) {
      await dispatch();
      advance(10_000);
    }

    expect(legOf('quota')).toMatchObject({ status: 'dead', attempts: 4, lastError: 'HTTP 500', lastStatusCode: 500 });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_cascade_dead_total', { service: 'quota', kind: 'org.deleted' });
    expect(mockIncCounter).not.toHaveBeenCalledWith('user_erasure_incomplete_total', expect.anything());
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0]![0]).toMatchObject({
      action: 'org.cascade.dead',
      actorId: 'cascade-outbox',
      affectedOrgId: 'org-1',
      targetType: 'organization',
      targetId: 'org-1',
      outcome: 'failure',
      details: { kind: 'org.deleted', service: 'quota', attempts: 4, statusCode: 500 },
    });
    // A dead leg is never picked up again.
    mockDeliver.mockClear();
    advance(1_000_000);
    await dispatch();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('a dead user-erasure leg also counts as an incomplete erasure (its alert keeps firing)', async () => {
    rows.length = 0;
    await enqueueCascade('user.erased', 'u-9', SESSION as never, now());
    mockDeliver.mockResolvedValue({ ok: false, error: 'unreachable' });

    for (let i = 0; i < 4; i += 1) { await dispatch(); advance(10_000); }

    expect(legOf('plugin', 'user.erased').status).toBe('dead');
    expect(mockIncCounter).toHaveBeenCalledWith('platform_cascade_dead_total', { service: 'plugin', kind: 'user.erased' });
    expect(mockIncCounter).toHaveBeenCalledWith('user_erasure_incomplete_total', { store: 'postgres' });
    expect(mockAudit.mock.calls[0]![0]).toMatchObject({ targetType: 'user', targetId: 'u-9' });
    expect(mockAudit.mock.calls[0]![0]).not.toHaveProperty('affectedOrgId');
  });

  it('a dead-letter whose metrics and audit both throw still marks the leg dead and does not fail the pass', async () => {
    mockDeliver.mockResolvedValue({ ok: false, error: 'boom' });
    mockIncCounter.mockImplementation(() => { throw new Error('metrics registry not wired'); });
    mockAudit.mockImplementation(() => { throw new Error('audit down'); });

    for (let i = 0; i < 4; i += 1) { await dispatch(); advance(10_000); }

    expect(legOf('pipeline').status).toBe('dead');
    // Delivery bookkeeping that cannot be metered still completes, too.
    mockDeliver.mockResolvedValue({ ok: true, statusCode: 200 });
    rows.push({ _id: 'leg-y', kind: 'org.deleted', subjectId: 'org-2', service: 'pipeline', status: 'pending', attempts: 0, nextAttemptAt: T0 });
    await expect(dispatch()).resolves.toMatchObject({ delivered: 1 });
  });

  it('LEASES a leg before delivering: a crash mid-delivery is not redelivered until the lease lapses', async () => {
    // Simulate a dispatcher that leased the leg and then died: the delivery
    // never completes, so only the lease is left behind.
    mockDeliver.mockImplementationOnce(() => new Promise(() => { /* never settles */ }));
    void dispatch({ batchSize: 1 });
    await new Promise((r) => setImmediate(r));
    expect(legOf('pipeline').nextAttemptAt).toEqual(new Date(T0.getTime() + 60_000));

    // A second dispatcher (a new leader) sees only the un-leased leg.
    mockDeliver.mockClear();
    await dispatch();
    expect(mockDeliver.mock.calls).toEqual([['quota', 'org-1']]);

    // Once the lease lapses, the stranded leg is delivered.
    advance(60_000);
    await dispatch();
    expect(mockDeliver).toHaveBeenLastCalledWith('pipeline', 'org-1');
    expect(legOf('pipeline')).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('counts a leg it lost the lease race for as skipped', async () => {
    // Another dispatcher leases everything between our scan and our claim.
    fakeModel.findOneAndUpdate.mockImplementationOnce(() => leanOf(null));
    const res = await dispatch();
    expect(res).toMatchObject({ scanned: 2, skipped: 1, delivered: 1 });
  });

  it('an acked leg redelivered after a crash (2xx landed, `done` write lost) is simply acked again', async () => {
    // The idempotent handler answers 2xx on the second delivery too.
    fakeModel.updateOne.mockImplementationOnce(async () => { throw new Error('primary stepped down'); });
    await expect(dispatch()).rejects.toThrow('primary stepped down');
    // The leg is still pending under its lease; after it lapses, delivered again.
    advance(60_000);
    await dispatch();
    expect(mockDeliver.mock.calls.filter((c) => c[0] === 'pipeline')).toHaveLength(2);
    expect(legOf('pipeline')).toMatchObject({ status: 'done' });
  });

  it('treats a throwing deliver, or a leg no longer registered, as a failed attempt', async () => {
    mockDeliver.mockRejectedValueOnce(new Error('kaboom'));
    rows.push({ _id: 'leg-x', kind: 'org.deleted', subjectId: 'org-1', service: 'retired-service', status: 'pending', attempts: 0, nextAttemptAt: T0 });

    const res = await dispatch();

    expect(res).toMatchObject({ delivered: 1, retried: 2 });
    expect(legOf('pipeline').lastError).toBe('kaboom');
    expect(legOf('retired-service').lastError).toBe('no cascade leg registered for org.deleted/retired-service');
  });

  it('bounds lastError', async () => {
    mockDeliver.mockResolvedValue({ ok: false, error: 'x'.repeat(5000) });
    await dispatch();
    expect(legOf('pipeline').lastError).toHaveLength(500);
  });

  it('stops between legs when the run aborts', async () => {
    const ac = new AbortController();
    mockDeliver.mockImplementation(async () => { ac.abort(); return { ok: true, statusCode: 200 }; });
    const res = await dispatchCascadeOutbox({ signal: ac.signal }, { now });
    expect(res.delivered).toBe(1);
    expect(legOf('quota').status).toBe('pending');
  });

  it('honours the batch size', async () => {
    expect((await dispatch({ batchSize: 1 })).scanned).toBe(1);
  });
});

describe('cascadeStatus', () => {
  it('reads a subject\'s legs back (the admin-readable status once the org is gone)', async () => {
    await enqueueCascade('org.deleted', 'org-1', SESSION as never, now());
    mockDeliver.mockImplementation(async (service: string) => (service === 'quota' ? { ok: false, error: 'HTTP 503', statusCode: 503 } : { ok: true, statusCode: 200 }));
    await dispatch();

    const status = await cascadeStatus('org-1', 'org.deleted');
    expect(fakeModel.find).toHaveBeenLastCalledWith({ subjectId: 'org-1', kind: 'org.deleted' });
    // (The real query sorts by service; the stand-in does not.)
    expect(status.map((s) => [s.service, s.status, s.attempts, s.lastError]).sort()).toEqual([
      ['pipeline', 'done', 1, null],
      ['quota', 'pending', 1, 'HTTP 503'],
    ]);
    await cascadeStatus('org-1');
    expect(fakeModel.find).toHaveBeenLastCalledWith({ subjectId: 'org-1' });
  });
});

describe('cascadeOutboxSweep', () => {
  it('is a leader-locked, concurrency-safe sweep on the configured interval', async () => {
    const def = cascadeOutboxSweep();
    expect(def).toMatchObject({ name: 'cascade-outbox', concurrencySafe: true, intervalMs: 30_000 });
    expect(def.lockKey).toContain('cascade-outbox');
    // The sweep runs on the real clock: enqueue in the past so the legs are due.
    await enqueueCascade('org.deleted', 'org-1', SESSION as never, new Date(0));
    await def.run({ signal: new AbortController().signal } as never);
    expect(mockDeliver).toHaveBeenCalledTimes(2);
  });
});
