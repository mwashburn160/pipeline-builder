// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-case on-call sweep.
 *
 * What is worth pinning here is the set of properties that let the sweep keep NO
 * state — because each of them is a thing that would otherwise have to be built,
 * and each is invisible until it is wrong:
 *
 *  - the dedup key is `case:<id>`, stable across ticks, so a case inside the
 *    window is re-sent every tick and stays ONE incident;
 *  - the trigger label is `case`, so a dead sweep is distinguishable from a
 *    working fleet alert in the one counter;
 *  - the gauge is written on the EMPTY tick too, since a gauge reports a state
 *    only if it is written when the state is zero;
 *  - a failed page does not abandon the rest of the batch;
 *  - the abort signal is checked BETWEEN cases, and stopping is lossless
 *    precisely because nothing records progress;
 *  - nothing tenant-owned reaches the payload — the on-call permission grants no
 *    tenant read access, so a case subject here would hand out what the
 *    permission withholds.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

interface SentEvent {
  dedupKey: string;
  action: string;
  trigger?: string;
  summary?: string;
  group?: string;
  customDetails?: Record<string, unknown>;
}

const sent: SentEvent[] = [];
const mockSend = jest.fn<(e: SentEvent) => Promise<{ ok: boolean; error?: string }>>();
const mockSetGauge = jest.fn<(name: string, labels: Record<string, string>, value: number) => void>();
const mockListCases = jest.fn<(leadMs: number, limit: number) => Promise<unknown[]>>();
const mockRecordAudit = jest.fn<(e: Record<string, unknown>) => void>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  envInt: (_k: string, d: number) => d,
  recordAudit: (e: Record<string, unknown>) => mockRecordAudit(e),
  sendPagerDutyEvent: async (e: SentEvent) => { sent.push(e); return mockSend(e); },
}));

// `stubModule` rather than a hand-rolled namespace: replacing the whole
// namespace drops every export it forgets, and those link as `undefined` the
// moment production code reaches one.
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  setGauge: (name: string, labels: Record<string, string>, value: number) => mockSetGauge(name, labels, value),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  listCasesDueForPage: (leadMs: number, limit: number) => mockListCases(leadMs, limit),
}));

const { runOnCallSweep, resolveCasePage, casePageKey, oncallSweepConfig } = await import('../src/services/oncall-sweep.js');

/** A case row with only the fields the sweep reads. */
const caseRow = (id: string, orgId = 'org-1') => ({
  id,
  orgId,
  severity: 'high',
  responseDueAt: new Date('2026-11-01T12:00:00Z'),
});

beforeEach(() => {
  sent.length = 0;
  mockSend.mockReset();
  mockSend.mockResolvedValue({ ok: true });
  mockSetGauge.mockReset();
  mockListCases.mockReset();
  mockRecordAudit.mockReset();
});

describe('oncallSweepConfig', () => {
  it('defaults the lead to 120 minutes, inside the margin the fleet alert leaves', () => {
    const cfg = oncallSweepConfig();
    expect(cfg.leadMs).toBe(120 * 60_000);
    expect(cfg.intervalMs).toBe(300_000);
    expect(cfg.batchSize).toBe(100);
  });
});

describe('casePageKey', () => {
  it('is stable for an id, which is the whole reason the sweep needs no state', () => {
    expect(casePageKey('abc')).toBe('case:abc');
    expect(casePageKey('abc')).toBe(casePageKey('abc'));
  });

  it('cannot collide with the Alertmanager leg, which keys on am:<fingerprint>', () => {
    expect(casePageKey('abc').startsWith('am:')).toBe(false);
  });
});

describe('runOnCallSweep', () => {
  it('pages each due case once, on a stable per-case key, labelled as the case trigger', async () => {
    mockListCases.mockResolvedValue([caseRow('c1'), caseRow('c2', 'org-2')]);
    const paged = await runOnCallSweep({ leadMs: 60_000, intervalMs: 1000, batchSize: 10, lockTtlMs: 1000 });

    expect(paged).toBe(2);
    expect(sent.map((e) => e.dedupKey)).toEqual(['case:c1', 'case:c2']);
    expect(sent.every((e) => e.action === 'trigger')).toBe(true);
    expect(sent.every((e) => e.trigger === 'case')).toBe(true);
    // The org is the provider's grouping dimension, so one tenant's burst reads
    // as one tenant's problem rather than a platform-wide one.
    expect(sent.map((e) => e.group)).toEqual(['org-1', 'org-2']);
  });

  it('passes the configured lead and batch size straight through to the query', async () => {
    mockListCases.mockResolvedValue([]);
    await runOnCallSweep({ leadMs: 7 * 60_000, intervalMs: 1000, batchSize: 42, lockTtlMs: 1000 });
    expect(mockListCases).toHaveBeenCalledWith(7 * 60_000, 42);
  });

  it('writes the gauge on an EMPTY tick — a gauge only reports a state if zero is written', async () => {
    mockListCases.mockResolvedValue([]);
    const paged = await runOnCallSweep({ leadMs: 60_000, intervalMs: 1000, batchSize: 10, lockTtlMs: 1000 });

    expect(paged).toBe(0);
    expect(mockSetGauge).toHaveBeenCalledWith('oncall_cases_due', {}, 0);
    expect(sent).toHaveLength(0);
  });

  it('publishes the count before paging, so the obligation is visible even with paging off', async () => {
    mockListCases.mockResolvedValue([caseRow('c1'), caseRow('c2'), caseRow('c3')]);
    await runOnCallSweep({ leadMs: 60_000, intervalMs: 1000, batchSize: 10, lockTtlMs: 1000 });
    expect(mockSetGauge).toHaveBeenCalledWith('oncall_cases_due', {}, 3);
  });

  it('finishes the batch when one page fails — one unreachable page must not take the rest', async () => {
    mockListCases.mockResolvedValue([caseRow('c1'), caseRow('c2'), caseRow('c3')]);
    mockSend.mockImplementation(async (e) => (e.dedupKey === 'case:c2' ? { ok: false, error: 'boom' } : { ok: true }));

    const paged = await runOnCallSweep({ leadMs: 60_000, intervalMs: 1000, batchSize: 10, lockTtlMs: 1000 });
    expect(paged).toBe(3);
    expect(sent.map((e) => e.dedupKey)).toEqual(['case:c1', 'case:c2', 'case:c3']);
  });

  it('survives a THROWING send and still pages the rest — the client promises not to, and the batch does not rely on it', async () => {
    mockListCases.mockResolvedValue([caseRow('c1'), caseRow('c2')]);
    mockSend.mockImplementation(async (e) => {
      if (e.dedupKey === 'case:c1') throw new Error('network');
      return { ok: true };
    });

    const paged = await runOnCallSweep({ leadMs: 60_000, intervalMs: 1000, batchSize: 10, lockTtlMs: 1000 });
    expect(paged).toBe(2);
    expect(sent.map((e) => e.dedupKey)).toEqual(['case:c1', 'case:c2']);
  });

  it('stops between cases when the lock is lost or shutdown begins', async () => {
    mockListCases.mockResolvedValue([caseRow('c1'), caseRow('c2'), caseRow('c3')]);
    const ctrl = new AbortController();
    mockSend.mockImplementation(async () => { ctrl.abort('lock-lost'); return { ok: true }; });

    const paged = await runOnCallSweep({ leadMs: 60_000, intervalMs: 1000, batchSize: 10, lockTtlMs: 1000 }, ctrl.signal);
    // One page sent, then the signal cut it short. Lossless: the next tick
    // re-derives the identical set, because nothing recorded progress.
    expect(paged).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('sends IDS ONLY — no case subject or body, which the on-call permission does not grant', async () => {
    mockListCases.mockResolvedValue([{ ...caseRow('c1'), subject: 'customer secret', description: 'private' }]);
    await runOnCallSweep({ leadMs: 60_000, intervalMs: 1000, batchSize: 10, lockTtlMs: 1000 });

    const payload = JSON.stringify(sent[0]);
    expect(payload).not.toContain('customer secret');
    expect(payload).not.toContain('private');
    expect(sent[0].customDetails).toEqual({
      caseId: 'c1',
      orgId: 'org-1',
      severity: 'high',
      responseDueAt: '2026-11-01T12:00:00.000Z',
    });
    expect(sent[0].summary).toContain('c1');
  });

  it('tolerates a null response_due_at rather than sending "Invalid Date"', async () => {
    mockListCases.mockResolvedValue([{ ...caseRow('c1'), responseDueAt: null }]);
    await runOnCallSweep({ leadMs: 60_000, intervalMs: 1000, batchSize: 10, lockTtlMs: 1000 });
    expect(sent[0].customDetails?.responseDueAt).toBe('unknown');
  });
});

describe('runOnCallSweep — support.oncall.paged audit', () => {
  const cfg = { leadMs: 120 * 60_000, intervalMs: 300_000, batchSize: 10, lockTtlMs: 1000 };
  /** A case whose lead window opened `openedAgoMs` ago (created long before). */
  const dueCase = (id: string, openedAgoMs: number) => ({
    id,
    orgId: 'org-1',
    displayNumber: 7,
    severity: 'high',
    subject: 'customer secret',
    responseDueAt: new Date(Date.now() + cfg.leadMs - openedAgoMs),
    createdAt: new Date(Date.now() - 24 * 3600_000),
  });

  it('audits ONCE, on the tick the case entered the window — not on every re-send', async () => {
    mockListCases.mockResolvedValue([dueCase('fresh', 60_000), dueCase('stale', 30 * 60_000)]);
    await runOnCallSweep(cfg);

    expect(sent).toHaveLength(2); // both are (re-)paged...
    expect(mockRecordAudit).toHaveBeenCalledTimes(1); // ...only the newly due one is a row
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'support.oncall.paged',
      affectedOrgId: 'org-1',
      targetType: 'support_case',
      targetId: 'fresh',
      outcome: 'success',
      details: expect.objectContaining({ caseNumber: 7, severity: 'high', leadMinutes: 120 }),
    }));
    expect(JSON.stringify(mockRecordAudit.mock.calls[0]![0])).not.toContain('customer secret');
  });

  it('treats a case CREATED inside the window as newly due', async () => {
    mockListCases.mockResolvedValue([{ ...dueCase('born-late', 60 * 60_000), createdAt: new Date(Date.now() - 1000) }]);
    await runOnCallSweep(cfg);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'born-late' }));
  });

  it('records a failed first page as a failure row', async () => {
    mockListCases.mockResolvedValue([dueCase('c1', 1000)]);
    mockSend.mockResolvedValue({ ok: false, error: 'boom' });
    await runOnCallSweep(cfg);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'c1', outcome: 'failure' }));
  });
});

describe('resolveCasePage', () => {
  it('resolves on the SAME key the sweep triggered on', async () => {
    await resolveCasePage('c1');
    expect(sent).toEqual([{ dedupKey: 'case:c1', action: 'resolve', trigger: 'case' }]);
  });

  it('swallows a failure — the reply it follows has already been written', async () => {
    mockSend.mockRejectedValue(new Error('network'));
    await expect(resolveCasePage('c1')).resolves.toBeUndefined();
  });
});
