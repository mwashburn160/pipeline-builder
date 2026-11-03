// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `incrementMetered` — the partial-admission increment behind the per-pod batch
 * flush — and the automationCalls soft band it (and every status read) binds on.
 *
 * `incrementUsage` is replaced by a fake with the SAME contract as the real
 * conditional update (all-or-nothing against the enforced cap, atomic per
 * call, interleaved by awaits), so the concurrency test exercises exactly the
 * retry-with-the-smaller-fit loop the real one runs against Mongo.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('../src/models/organization.js', () => ({
  Organization: { findOneAndUpdate: jest.fn<AnyFn>(), findById: jest.fn<AnyFn>(), find: jest.fn<AnyFn>(), updateOne: jest.fn<AnyFn>() },
}));
jest.unstable_mockModule('../src/config.js', () => ({
  config: { quota: { resetDays: 3, poolFallbackTtlMs: 0, defaults: { apiCalls: 25_000, automationCalls: 30_000 } } },
}));

const { QuotaService } = await import('../src/services/quota-service.js');
const { computeQuotaStatus, enforcedLimitExpr } = await import('../src/helpers/quota-helpers.js');
const { pooledStatusFromRows } = await import('../src/services/pooled-quota.js');
const { enforcedQuotaLimit } = await import('@pipeline-builder/api-core');

const resetAt = new Date(Date.now() + 86_400_000).toISOString();
const tick = () => new Promise((r) => setImmediate(r));

/** An org counter with the real increment's contract. */
function fakeCounter(svc: InstanceType<typeof QuotaService>, quotaType: 'apiCalls' | 'automationCalls', limit: number, used = 0) {
  const state = { used, writes: 0 };
  jest.spyOn(svc, 'incrementUsage').mockImplementation(async (_org: string, _type: string, amount: number) => {
    await tick(); // let other callers interleave between read and write
    state.writes += 1;
    const cap = enforcedQuotaLimit(quotaType, limit);
    if (limit === -1 || state.used + amount <= cap) {
      state.used += amount;
      return { exceeded: false, rootOrgId: 'org', quota: { type: quotaType, limit, used: state.used, remaining: Math.max(0, limit - state.used), resetAt } } as never;
    }
    return { exceeded: true, rootOrgId: 'org', quota: { type: quotaType, limit, used: state.used, remaining: Math.max(0, limit - state.used), resetAt } } as never;
  });
  return state;
}

describe('QuotaService.incrementMetered', () => {
  let svc: InstanceType<typeof QuotaService>;
  beforeEach(() => { svc = new QuotaService(); });

  it('counts the whole sum in ONE write when it fits', async () => {
    const state = fakeCounter(svc, 'apiCalls', 100, 10);
    const out = await svc.incrementMetered('org', 'apiCalls', 40);
    expect(out).toMatchObject({ counted: 40, overshoot: 0 });
    expect(state).toEqual({ used: 50, writes: 1 });
  });

  it('admits the part that fits and records the rest as overshoot', async () => {
    const state = fakeCounter(svc, 'apiCalls', 100, 90);
    const out = await svc.incrementMetered('org', 'apiCalls', 25);
    expect(out).toMatchObject({ counted: 10, overshoot: 15 });
    expect(state.used).toBe(100);
  });

  it('counts nothing on a full counter', async () => {
    const state = fakeCounter(svc, 'apiCalls', 100, 100);
    expect(await svc.incrementMetered('org', 'apiCalls', 3)).toMatchObject({ counted: 0, overshoot: 3 });
    expect(state).toEqual({ used: 100, writes: 1 });
  });

  it('lets automationCalls run into its soft band, and not past it', async () => {
    const state = fakeCounter(svc, 'automationCalls', 100, 95);
    const out = await svc.incrementMetered('org', 'automationCalls', 50);
    // 10% band: the enforced cap is 110.
    expect(out).toMatchObject({ counted: 15, overshoot: 35 });
    expect(state.used).toBe(110);
  });

  it('under concurrency: the counter never passes the cap and counted + overshoot = what was sent', async () => {
    const state = fakeCounter(svc, 'apiCalls', 500, 0);
    const amounts = Array.from({ length: 60 }, (_, i) => 1 + ((i * 7) % 23));
    const outs = await Promise.all(amounts.map((a) => svc.incrementMetered('org', 'apiCalls', a)));
    const counted = outs.reduce((n, o) => n + o.counted, 0);
    const overshoot = outs.reduce((n, o) => n + o.overshoot, 0);
    expect(state.used).toBeLessThanOrEqual(500);
    expect(counted).toBe(state.used);
    expect(counted + overshoot).toBe(amounts.reduce((n, a) => n + a, 0));
    // Total demand (≈700) exceeds the cap, so the cap is reached exactly or
    // within the last contended fits.
    expect(state.used).toBeGreaterThan(450);
  });
});

describe('the automationCalls soft band in status reads', () => {
  it('computeQuotaStatus allows automationCalls up to the band, but not other types', () => {
    const u = { used: 105, resetAt: new Date(resetAt) };
    expect(computeQuotaStatus(100, u, 'automationCalls')).toMatchObject({ allowed: true, limit: 100, remaining: 0 });
    expect(computeQuotaStatus(100, { ...u, used: 110 }, 'automationCalls').allowed).toBe(false);
    expect(computeQuotaStatus(100, u, 'apiCalls').allowed).toBe(false);
    expect(computeQuotaStatus(100, u).allowed).toBe(false);
  });

  it('the pooled status binds on the same band', () => {
    const rows = [{ _id: 'root', quotas: { automationCalls: 100 }, poolUsage: { automationCalls: { used: 105, resetAt: new Date(resetAt) } } }];
    expect(pooledStatusFromRows(rows as never, 'root', 'automationCalls')).toMatchObject({ allowed: true, limit: 100 });
  });

  it('enforcedLimitExpr wraps only automationCalls', () => {
    expect(enforcedLimitExpr('apiCalls', '$x')).toBe('$x');
    expect(enforcedLimitExpr('automationCalls', '$x')).toEqual({
      $cond: [{ $gt: ['$x', 0] }, { $floor: { $divide: [{ $multiply: ['$x', 110] }, 100] } }, '$x'],
    });
  });
});
