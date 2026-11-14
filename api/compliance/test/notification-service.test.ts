// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit suite for services/notification-service — the persistence half of the
 * compliance notifier, over a mocked `withTenantTx`.
 *
 * Pinned: the preference read's null-on-absent, the upsert's patch-only update
 * (a webhook secret survives an edit that doesn't re-enter it), the best-effort
 * log/digest inserts (a DB failure never throws into a notification), and the
 * digest queries' channel/status scoping.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockWarn = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ warn: mockWarn, info: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

/** Recorded chain calls, and what the terminal step resolves to. */
const calls: Array<[string, ...unknown[]]> = [];
let result: unknown = [];
let failWith: Error | null = null;

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'selectDistinct', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'onConflictDoUpdate', 'returning', 'update', 'set']) {
    c[m] = (...a: unknown[]) => { calls.push([m, ...a]); return c; };
  }
  // Thenable: awaiting any step resolves the query.
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    (failWith ? Promise.reject(failWith) : Promise.resolve(result)).then(res, rej);
  return c;
}

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: {
    complianceNotificationPreference: { orgId: 'pref.org_id', lastDigestAt: 'pref.last_digest_at' },
    complianceNotificationLog: { id: 'log.id', orgId: 'log.org_id', channel: 'log.channel', status: 'log.status', payload: 'log.payload', createdAt: 'log.created_at' },
  },
  withTenantTx: async (fn: (tx: unknown) => unknown) => fn(chain()),
}));

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...a: unknown[]) => ({ op: 'and', a }),
  eq: (c: unknown, v: unknown) => ({ op: 'eq', c, v }),
  inArray: (c: unknown, v: unknown) => ({ op: 'inArray', c, v }),
}));

const svc = await import('../src/services/notification-service.js');

const called = (m: string) => calls.filter(([name]) => name === m).map(([, ...a]) => a);

beforeEach(() => {
  calls.length = 0;
  result = [];
  failWith = null;
  mockWarn.mockClear();
});

describe('getNotificationPreference', () => {
  it('returns the org row', async () => {
    result = [{ orgId: 'o1', notifyOnBlock: true }];
    await expect(svc.getNotificationPreference('o1')).resolves.toEqual({ orgId: 'o1', notifyOnBlock: true });
    expect(called('where')[0][0]).toEqual({ op: 'eq', c: 'pref.org_id', v: 'o1' });
    expect(called('limit')[0][0]).toBe(1);
  });

  it('returns null when the org has no preference (callers apply column defaults)', async () => {
    await expect(svc.getNotificationPreference('o1')).resolves.toBeNull();
  });
});

describe('upsertNotificationPreference', () => {
  it('inserts orgId + patch and updates ONLY the patched keys on conflict', async () => {
    result = [{ orgId: 'o1', notifyOnWarning: true }];
    const row = await svc.upsertNotificationPreference('o1', { notifyOnWarning: true });
    expect(row).toEqual({ orgId: 'o1', notifyOnWarning: true });
    expect(called('values')[0][0]).toEqual({ orgId: 'o1', notifyOnWarning: true });
    const conflict = called('onConflictDoUpdate')[0][0] as { target: unknown; set: Record<string, unknown> };
    expect(conflict.target).toBe('pref.org_id');
    // No webhookSecret key → the stored secret is left untouched.
    expect(Object.keys(conflict.set).sort()).toEqual(['notifyOnWarning', 'updatedAt']);
  });
});

describe('recordNotificationLog', () => {
  it('appends the delivery attempt, nulling absent webhook fields', async () => {
    await svc.recordNotificationLog({ orgId: 'o1', channel: 'in-app', status: 'sent', payload: { a: 1 } });
    expect(called('values')[0][0]).toEqual({
      orgId: 'o1', channel: 'in-app', status: 'sent', payload: { a: 1 }, webhookResponseCode: null, webhookError: null,
    });
  });

  it('keeps webhook outcome fields', async () => {
    await svc.recordNotificationLog({ orgId: 'o1', channel: 'webhook', status: 'failed', payload: {}, webhookResponseCode: 502, webhookError: 'bad gateway' });
    expect(called('values')[0][0]).toMatchObject({ webhookResponseCode: 502, webhookError: 'bad gateway' });
  });

  it('is best-effort: a DB failure is logged, never thrown', async () => {
    failWith = new Error('db down');
    await expect(svc.recordNotificationLog({ orgId: 'o1', channel: 'email', status: 'sent', payload: {} })).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith('Failed to write compliance notification log', expect.objectContaining({ orgId: 'o1', channel: 'email' }));
  });
});

describe('digest batching', () => {
  it('parks a notification as a pending digest row', async () => {
    const n = { recipientOrgId: 'o1', subject: 's', body: 'b', priority: 'normal' } as never;
    await svc.recordPendingDigest('o1', n);
    expect(called('values')[0][0]).toEqual({ orgId: 'o1', channel: 'digest', status: 'pending', payload: n });
  });

  it('parking is best-effort too', async () => {
    failWith = new Error('db down');
    await expect(svc.recordPendingDigest('o1', {} as never)).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith('Failed to record pending digest', expect.objectContaining({ orgId: 'o1' }));
  });

  it('lists distinct orgs with pending digest rows', async () => {
    result = [{ orgId: 'o1' }, { orgId: 'o2' }];
    await expect(svc.getOrgsWithPendingDigests()).resolves.toEqual(['o1', 'o2']);
    expect(called('where')[0][0]).toEqual({
      op: 'and',
      a: [
        { op: 'eq', c: 'log.channel', v: 'digest' },
        { op: 'eq', c: 'log.status', v: 'pending' },
      ],
    });
  });

  it("reads an org's pending entries oldest first, unwrapping the payload", async () => {
    result = [{ id: 'l1', payload: { subject: 'A' } }];
    await expect(svc.getPendingDigests('o1')).resolves.toEqual([{ id: 'l1', notification: { subject: 'A' } }]);
    expect(called('orderBy')[0][0]).toBe('log.created_at');
  });

  it('marks entries sent, and no-ops on an empty list', async () => {
    await svc.markDigestsSent([]);
    expect(calls).toHaveLength(0);
    await svc.markDigestsSent(['l1', 'l2']);
    expect(called('set')[0][0]).toEqual({ status: 'sent' });
    expect(called('where')[0][0]).toEqual({ op: 'inArray', c: 'log.id', v: ['l1', 'l2'] });
  });

  it('stamps lastDigestAt on the org preference', async () => {
    const at = new Date('2026-11-13T00:00:00Z');
    await svc.touchLastDigestAt('o1', at);
    expect(called('set')[0][0]).toEqual({ lastDigestAt: at, updatedAt: at });
    expect(called('where')[0][0]).toEqual({ op: 'eq', c: 'pref.org_id', v: 'o1' });
  });
});
