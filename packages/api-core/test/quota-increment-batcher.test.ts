// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-pod metering aggregator: units sum per (org, type, attribution group)
 * and leave as ONE metered increment per (org, type) per flush. Bounded, never
 * throws, counts what it loses.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { QuotaIncrementBatcher, MAX_GROUPS_PER_INCREMENT, type MeteredIncrementGroup } from '../src/services/quota-increment-batcher.js';
import type { QuotaType } from '../src/types/common.js';
import { resetCounterEmitter, setCounterEmitter } from '../src/utils/metric-emitter.js';

type Sent = { orgId: string; quotaType: QuotaType; groups: MeteredIncrementGroup[] };

let sent: Sent[];
let counters: Array<[string, Record<string, string>, number]>;
const sender = async (orgId: string, quotaType: QuotaType, groups: MeteredIncrementGroup[]) => {
  sent.push({ orgId, quotaType, groups: groups.map((g) => ({ ...g })) });
};

beforeEach(() => {
  sent = [];
  counters = [];
  setCounterEmitter((name, labels = {}, value = 1) => { counters.push([name, labels, value]); });
});
afterEach(() => { resetCounterEmitter(); });

describe('QuotaIncrementBatcher', () => {
  it('sums units per attribution group and sends one increment per (org, type)', async () => {
    const b = new QuotaIncrementBatcher(sender, { flushMs: 60_000, maxGroups: 100 });
    const u1 = { principalType: 'user' as const, principalId: 'u1', route: 'GET /a', requestId: 'r1' };
    b.add('org-1', 'apiCalls', u1);
    b.add('org-1', 'apiCalls', { ...u1, requestId: 'r2' }); // request id is not part of the group
    b.add('org-1', 'apiCalls', { principalType: 'user', principalId: 'u2', route: 'GET /a' });
    b.add('org-1', 'automationCalls', { principalType: 'service_account', principalId: 'sa' });
    b.add('org-2', 'apiCalls');
    expect(sent).toEqual([]);
    expect(b.pendingUnits()).toBe(5);

    await b.flush();
    b.stop();
    expect(b.pendingUnits()).toBe(0);
    const byKey = Object.fromEntries(sent.map((s) => [`${s.orgId}/${s.quotaType}`, s.groups]));
    expect(byKey['org-1/apiCalls']).toEqual([
      { amount: 2, attribution: { principalType: 'user', principalId: 'u1', route: 'GET /a' } },
      { amount: 1, attribution: { principalType: 'user', principalId: 'u2', route: 'GET /a' } },
    ]);
    expect(byKey['org-1/automationCalls']).toEqual([{ amount: 1, attribution: { principalType: 'service_account', principalId: 'sa' } }]);
    expect(byKey['org-2/apiCalls']).toEqual([{ amount: 1 }]);
    expect(sent).toHaveLength(3);
  });

  it('flushes on its interval', async () => {
    jest.useFakeTimers();
    try {
      const b = new QuotaIncrementBatcher(sender, { flushMs: 1000, maxGroups: 100 });
      b.add('org-1', 'apiCalls');
      await jest.advanceTimersByTimeAsync(1000);
      b.stop();
      expect(sent.map((s) => s.groups[0]!.amount)).toEqual([1]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends every unit on its own when batching is off (flushMs 0)', async () => {
    const b = new QuotaIncrementBatcher(sender, { flushMs: 0, maxGroups: 100 });
    b.add('org-1', 'apiCalls');
    b.add('org-1', 'apiCalls');
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
  });

  it('flushes early at the buffer bound, and drops (counted) only while that flush is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = async (orgId: string, quotaType: QuotaType, groups: MeteredIncrementGroup[]) => {
      await gate;
      await sender(orgId, quotaType, groups);
    };
    const b = new QuotaIncrementBatcher(slow, { flushMs: 60_000, maxGroups: 2 });
    b.add('org-1', 'apiCalls', { principalId: 'a' });
    b.add('org-1', 'apiCalls', { principalId: 'b' });
    b.add('org-1', 'apiCalls', { principalId: 'c' }); // at the bound → flush a+b, then buffer c
    b.add('org-1', 'apiCalls', { principalId: 'd' }); // buffered (2 groups)
    b.add('org-1', 'apiCalls', { principalId: 'e' }); // full and a flush in flight → dropped
    b.add('org-1', 'apiCalls', { principalId: 'c' }); // an EXISTING group still aggregates
    expect(counters.filter(([n]) => n === 'quota_increment_dropped_total')).toEqual([
      ['quota_increment_dropped_total', { quotaType: 'apiCalls' }, 1],
    ]);
    release();
    await b.flush();
    b.stop();
    const units = sent.flatMap((s) => s.groups).reduce((n, g) => n + g.amount, 0);
    expect(units).toBe(5); // a, b, c×2, d — e was dropped
  });

  it('splits a series with more groups than one increment may carry', async () => {
    const b = new QuotaIncrementBatcher(sender, { flushMs: 60_000, maxGroups: 10_000 });
    for (let i = 0; i < MAX_GROUPS_PER_INCREMENT + 3; i++) b.add('org-1', 'apiCalls', { principalId: `u${i}` });
    await b.flush();
    b.stop();
    expect(sent.map((s) => s.groups.length)).toEqual([MAX_GROUPS_PER_INCREMENT, 3]);
  });

  it('never throws on a failed send, and counts it', async () => {
    const b = new QuotaIncrementBatcher(async () => { throw new Error('boom'); }, { flushMs: 60_000, maxGroups: 10 });
    b.add('org-1', 'apiCalls');
    await expect(b.flush()).resolves.toBeUndefined();
    b.stop();
    expect(counters.filter(([n]) => n === 'quota_increment_failures_total').map(([, l]) => l)).toEqual([{ reason: 'exception', quotaType: 'apiCalls' }]);
  });
});
