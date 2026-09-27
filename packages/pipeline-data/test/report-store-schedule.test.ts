// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The store operations a SCHEDULER depends on.
 *
 * Each one is here because it has a plausible way to regress into a duplicate delivery or
 * a report that silently stops:
 *
 *  - the due scan crosses org boundaries, so it MUST establish a sysadmin scope — and it
 *    must be the only thing here that does;
 *  - the claim is CONDITIONAL on the `next_run_at` the scan saw. That predicate is the
 *    whole concurrency guard; without it two overlapping sweeps each compose and deliver;
 *  - pausing CLEARS `next_run_at`, so a paused definition stops being re-claimed and
 *    re-rejected every cycle — and resuming therefore has to set a new one;
 *  - resuming is scoped to ONE pause reason, so re-subscribing cannot start a report
 *    running under an owner who left;
 *  - the delivery record is writable AFTER publish, which is exactly when delivery
 *    happens and exactly when `setRunNotes` refuses;
 *  - an unsubscribe is idempotent and matched by token alone, because the person clicking
 *    has no account and may click twice.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fakeTx, renderSql, type FakeTx } from './helpers/fake-tx.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

let tx: FakeTx;
let scopes: Array<{ orgId?: string; isSuperAdmin?: boolean }>;

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));

jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (t: unknown) => unknown) => fn(tx.tx),
  runWithTenantContext: <T>(ctx: { orgId?: string; isSuperAdmin?: boolean }, fn: () => T) => {
    scopes.push(ctx);
    return fn();
  },
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { StakeholderReportStore } = await import('../src/api/reporting/stakeholder/store.js');

type Store = InstanceType<typeof StakeholderReportStore>;

const ORG = 'acme';
const NOW = new Date('2026-09-21T12:00:00.000Z');
const SEEN = new Date('2026-09-21T11:00:00.000Z');
const NEXT = new Date('2026-09-28T11:00:00.000Z');

let store: Store;

beforeEach(() => {
  tx = fakeTx();
  scopes = [];
  store = new StakeholderReportStore();
});

describe('dueDefinitions', () => {
  it('scans across orgs as SYSADMIN, oldest due first, capped', async () => {
    tx.queue([{ id: 'def-1' }, { id: 'def-2' }]);
    const rows = await store.dueDefinitions(NOW, 25);

    expect(rows).toHaveLength(2);
    // The scheduler has no tenant — it is looking for work in orgs it was never told
    // about — so this read has to establish its own scope, and it is the only one here
    // that legitimately does.
    expect(scopes).toEqual([{ isSuperAdmin: true }]);
    const q = tx.of('select')[0];
    expect(q?.arg('limit')).toBe(25);
    // Oldest first, so a backlog drains in order rather than starving whichever org
    // happens to sort last.
    expect(renderSql(q?.arg('orderBy'))).toContain('next_run_at');
  });

  it('filters to active, undeleted, due rows', async () => {
    tx.queue([]);
    await store.dueDefinitions(NOW, 5);
    const where = tx.of('select')[0]?.whereSql() ?? '';
    expect(where).toContain('is_active');
    expect(where).toContain('deleted_at');
    expect(where).toContain('next_run_at');
  });
});

describe('claimDefinition', () => {
  it('advances the schedule only while `next_run_at` still equals what the scan saw', async () => {
    tx.queue([{ id: 'def-1' }]);
    await expect(store.claimDefinition('def-1', SEEN, NEXT, NOW)).resolves.toBe(true);

    const q = tx.of('update')[0];
    const where = q?.whereSql() ?? '';
    // THE concurrency guard. The leader lock stops two replicas sweeping in one window;
    // it does not stop a long sweep overlapping the next leader's, and both would then
    // compose and DELIVER the same report.
    expect(where).toContain('next_run_at');
    expect(where).toContain('id');
    const set = q?.arg('set') as Record<string, unknown>;
    expect(set.nextRunAt).toBe(NEXT);
    expect(set.lastRunAt).toBe(NOW);
  });

  it('reports a LOST race rather than throwing', async () => {
    tx.queue([]); // 0 rows updated ⇒ another runner claimed it
    await expect(store.claimDefinition('def-1', SEEN, NEXT, NOW)).resolves.toBe(false);
  });

  it('runs as sysadmin, like the scan it follows', async () => {
    tx.queue([{ id: 'def-1' }]);
    await store.claimDefinition('def-1', SEEN, NEXT, NOW);
    expect(scopes).toEqual([{ isSuperAdmin: true }]);
  });
});

describe('pauseDefinition', () => {
  it('records the reason and CLEARS the schedule', async () => {
    tx.queue([]);
    await store.pauseDefinition('def-1', 'entitlement');
    const set = tx.of('update')[0]?.arg('set') as Record<string, unknown>;
    expect(set.isActive).toBe(false);
    expect(set.pausedReason).toBe('entitlement');
    // Cleared so a paused definition stops appearing in the due scan at all, rather than
    // being re-claimed and re-rejected every cycle.
    expect(set.nextRunAt).toBeNull();
  });
});

describe('resumeDefinition', () => {
  it('clears the reason and sets a fresh schedule', async () => {
    tx.queue([{ id: 'def-1', orgId: ORG, isActive: true, pausedReason: null }]);
    await store.resumeDefinition(ORG, 'def-1', NEXT, 'user-lead');
    const set = tx.of('update')[0]?.arg('set') as Record<string, unknown>;
    expect(set.isActive).toBe(true);
    expect(set.pausedReason).toBeNull();
    // Pausing cleared it, so a resume with no new value would be active and permanently
    // not due.
    expect(set.nextRunAt).toBe(NEXT);
  });

  it('throws when the definition is gone', async () => {
    tx.queue([]);
    await expect(store.resumeDefinition(ORG, 'missing', NEXT, 'user-lead')).rejects.toThrow();
  });
});

describe('the entitlement lapse and resume legs', () => {
  it('pauses every active definition in the org and returns them', async () => {
    tx.queue([{ id: 'def-1' }, { id: 'def-2' }]);
    const paused = await store.pauseDefinitionsForOrg(ORG, 'entitlement');
    expect(paused).toHaveLength(2);
    const q = tx.of('update')[0];
    expect(q?.whereSql()).toContain('is_active');
    expect((q?.arg('set') as Record<string, unknown>).pausedReason).toBe('entitlement');
  });

  it('finds paused definitions BY REASON, so a resume cannot cross causes', async () => {
    tx.queue([]);
    await store.definitionsPausedFor(ORG, 'entitlement');
    // Scoped to the reason on purpose: re-subscribing must not un-pause a definition
    // whose OWNER was deactivated, which is a different problem with a different fix.
    expect(tx.of('select')[0]?.whereSql()).toContain('paused_reason');
  });
});

describe('setNextRun', () => {
  it('writes the schedule without claiming anything', async () => {
    tx.queue([]);
    await store.setNextRun(ORG, 'def-1', NEXT);
    const q = tx.of('update')[0];
    expect((q?.arg('set') as Record<string, unknown>).nextRunAt).toBe(NEXT);
    // Org-scoped, unlike the claim: this one is called from a request.
    expect(q?.whereSql()).toContain('org_id');
    expect(scopes).toEqual([]);
  });
});

describe('recordDelivery', () => {
  it('writes the delivery record and nothing else', async () => {
    tx.queue([]);
    await store.recordDelivery(ORG, 'run-1', { email: { sent: 3, failed: 0 } });
    const set = tx.of('update')[0]?.arg('set') as Record<string, unknown>;
    // Exactly one meaningful column, which is why this is safe to allow after publish:
    // it cannot change a number a recipient has already read.
    expect(Object.keys(set).sort()).toEqual(['delivery', 'updatedAt']);
    expect(set.delivery).toEqual({ email: { sent: 3, failed: 0 } });
  });
});

describe('unsubscribeByToken', () => {
  it('matches by token across orgs, as sysadmin', async () => {
    tx.queue([{ id: 'rec-1' }]);
    await expect(store.unsubscribeByToken('a'.repeat(32), NOW)).resolves.toBe(true);
    // The person clicking has no account and no tenant; the token is the only thing that
    // identifies the row.
    expect(scopes).toEqual([{ isSuperAdmin: true }]);
    expect(tx.of('update')[0]?.whereSql()).toContain('unsubscribe_token');
  });

  it('is idempotent — an already-unsubscribed row keeps its original timestamp', async () => {
    tx.queue([{ id: 'rec-1' }]);
    await store.unsubscribeByToken('a'.repeat(32), NOW);
    const set = tx.of('update')[0]?.arg('set') as Record<string, unknown>;
    // COALESCE, so a second click (or a mail client that posts twice) does not re-date the
    // unsubscribe — and the caller still gets success, because that is the outcome asked
    // for either way.
    expect(renderSql(set.unsubscribedAt)).toContain('COALESCE');
  });

  it('refuses an implausibly short token without a query', async () => {
    await expect(store.unsubscribeByToken('abc')).resolves.toBe(false);
    expect(tx.queries).toHaveLength(0);
  });

  it('reports no match for an unknown token', async () => {
    tx.queue([]);
    await expect(store.unsubscribeByToken('b'.repeat(32), NOW)).resolves.toBe(false);
  });
});
