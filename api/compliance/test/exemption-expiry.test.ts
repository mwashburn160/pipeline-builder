// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The exemption expiry sweep.
 *
 *  - approved rows past `expiresAt` move to `expired`, one audit row per org;
 *  - each org gets ONE pre-expiry notice for rows lapsing inside the warn window,
 *    and the warned stamp is written only once the notice was accepted (so a
 *    message-service outage retries next tick instead of losing the warning);
 *  - the scheduler is leader-locked and a failing cycle throws (SchedulerJobStale).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

type SchedOpts = { name: string; intervalMs: number; lock?: { key: string }; run: () => Promise<void> };
let schedOpts: SchedOpts | undefined;
const mockRecordAudit = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: (o: SchedOpts) => { schedOpts = o; return { start: jest.fn(), stop: jest.fn() }; },
  recordAudit: mockRecordAudit,
}));

/** Rows the UPDATE ... RETURNING (expire) and the SELECT (warn) hand back. */
let expiredRows: unknown[] = [];
let dueRows: unknown[] = [];
const updates: Array<{ set: Record<string, unknown>; where: unknown }> = [];
const selects: unknown[] = [];

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  const tx = {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updates.push({ set, where });
          const p = Promise.resolve(undefined) as Promise<unknown> & { returning?: () => Promise<unknown[]> };
          p.returning = () => Promise.resolve(expiredRows);
          return p;
        },
      }),
    }),
    select: () => ({ from: () => ({ where: (where: unknown) => { selects.push(where); return Promise.resolve(dueRows); } }) }),
  };
  return stubModule('@pipeline-builder/pipeline-data', {
    schema: {
      complianceExemption: {
        id: 'id',
        orgId: 'org_id',
        ruleId: 'rule_id',
        entityType: 'entity_type',
        entityName: 'entity_name',
        expiresAt: 'expires_at',
        status: 'status',
        expiryWarnedAt: 'expiry_warned_at',
      },
    },
    withTenantTx: (fn: (t: typeof tx) => unknown) => fn(tx),
    runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
  });
});

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...a: unknown[]) => ({ op: 'and', a }),
  eq: (c: unknown, v: unknown) => ({ op: 'eq', c, v }),
  gt: (c: unknown, v: unknown) => ({ op: 'gt', c, v }),
  lte: (c: unknown, v: unknown) => ({ op: 'lte', c, v }),
  isNull: (c: unknown) => ({ op: 'isNull', c }),
}));

const mockDeliver = jest.fn<(...a: unknown[]) => Promise<{ ok: boolean; error?: string }>>();
jest.unstable_mockModule('../src/helpers/notification-channels.js', () => ({ inAppChannel: { deliver: mockDeliver } }));

const { expireLapsedExemptions, warnExpiringExemptions, startExemptionExpiryScheduler, EXPIRY_WARN_DAYS } =
  await import('../src/helpers/exemption-expiry.js');

const NOW = new Date('2026-11-13T00:00:00Z');
const row = (id: string, orgId: string, expiresAt = NOW) => ({ id, orgId, ruleId: `r-${id}`, entityType: 'pipeline', entityName: `p-${id}`, expiresAt });

beforeEach(() => {
  jest.clearAllMocks();
  expiredRows = [];
  dueRows = [];
  updates.length = 0;
  selects.length = 0;
  mockDeliver.mockResolvedValue({ ok: true });
});

describe('expireLapsedExemptions', () => {
  it('moves approved rows past expiresAt to expired, auditing once per org', async () => {
    expiredRows = [row('e1', 'org-a'), row('e2', 'org-a'), row('e3', 'org-b')];
    await expect(expireLapsedExemptions(NOW)).resolves.toBe(3);

    expect(updates[0].set).toEqual({ status: 'expired', updatedBy: 'system', updatedAt: NOW });
    const where = updates[0].where as { a: Array<{ op: string; c: string; v: unknown }> };
    expect(where.a).toEqual([
      { op: 'eq', c: 'status', v: 'approved' },
      { op: 'lte', c: 'expires_at', v: NOW },
    ]);
    expect(mockRecordAudit).toHaveBeenCalledTimes(2);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.exemption.expire',
      actorId: 'system',
      orgId: 'org-a',
      details: { trigger: 'expiry', count: 2, ids: ['e1', 'e2'] },
    }));
  });

  it('audits nothing when nothing lapsed', async () => {
    await expect(expireLapsedExemptions(NOW)).resolves.toBe(0);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});

describe('warnExpiringExemptions', () => {
  it('selects approved, not-yet-warned rows inside the warn window', async () => {
    await warnExpiringExemptions(NOW);
    const where = selects[0] as { a: Array<{ op: string; c: string; v?: unknown }> };
    const horizon = new Date(NOW.getTime() + EXPIRY_WARN_DAYS * 86_400_000);
    expect(where.a).toEqual([
      { op: 'eq', c: 'status', v: 'approved' },
      { op: 'gt', c: 'expires_at', v: NOW },
      { op: 'lte', c: 'expires_at', v: horizon },
      { op: 'isNull', c: 'expiry_warned_at' },
    ]);
  });

  it('sends ONE notice per org listing its rows, then stamps each row warned', async () => {
    const soon = new Date('2026-11-15T00:00:00Z');
    dueRows = [row('w1', 'org-a', soon), row('w2', 'org-a', soon), row('w3', 'org-b', soon)];
    await expect(warnExpiringExemptions(NOW)).resolves.toBe(3);

    expect(mockDeliver).toHaveBeenCalledTimes(2);
    const [notice] = mockDeliver.mock.calls[0] as [{ recipientOrgId: string; subject: string; body: string; priority: string }];
    expect(notice.recipientOrgId).toBe('org-a');
    expect(notice.subject).toBe('2 compliance exemptions expire soon');
    expect(notice.body).toContain('p-w1');
    expect(notice.body).toContain('2026-11-15');
    expect(updates.map((u) => u.set)).toEqual([{ expiryWarnedAt: NOW }, { expiryWarnedAt: NOW }, { expiryWarnedAt: NOW }]);
  });

  it('does NOT stamp an org whose notice was refused (retried next sweep)', async () => {
    dueRows = [row('w1', 'org-a'), row('w2', 'org-b')];
    mockDeliver.mockResolvedValueOnce({ ok: false, error: 'message down' }).mockResolvedValueOnce({ ok: true });
    await expect(warnExpiringExemptions(NOW)).resolves.toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({ op: 'eq', c: 'id', v: 'w2' });
  });
});

describe('startExemptionExpiryScheduler', () => {
  it('is a leader-locked daily scheduler whose cycle expires then warns', async () => {
    startExemptionExpiryScheduler();
    expect(schedOpts).toMatchObject({ name: 'compliance-exemption-expiry', intervalMs: 86_400_000, lock: { key: 'compliance:exemption-expiry:leader' } });
    expiredRows = [row('e1', 'org-a')];
    await schedOpts!.run();
    expect(updates[0].set).toMatchObject({ status: 'expired' });
    expect(selects).toHaveLength(1);
  });

  it('a failing cycle throws (no recorded success for SchedulerJobStale)', async () => {
    startExemptionExpiryScheduler();
    mockDeliver.mockRejectedValueOnce(new Error('boom'));
    dueRows = [row('w1', 'org-a')];
    await expect(schedOpts!.run()).rejects.toThrow('boom');
  });
});
