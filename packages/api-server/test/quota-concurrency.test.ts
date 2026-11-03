// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Concurrency at the cap, end to end through the REAL check (with its per-pod
 * cache), the REAL meter and the REAL per-pod increment batcher, against a fake
 * quota backend that applies a metered increment the way the quota service does
 * (atomically, partial admission, the rest recorded as overshoot).
 *
 * The property: however many requests race on however many pods, the counter
 * never exceeds the limit, and the ledger accounts for every served request —
 * counted + overshoot = served, counted = the counter.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

const { flushQuotaIncrements } = await import('@pipeline-builder/api-core');
const { apiCallsQuota } = await import('../src/api/meter-quota.js');
const { clearQuotaCheckCache } = await import('../src/api/check-quota.js');

/** One quota-service backend shared by every "pod". */
class FakeQuotaBackend {
  used = 0;
  ledger = { counted: 0, overshoot: 0 };
  constructor(readonly limit: number) {}

  /** A pod's client. Each pod gets its own object, hence its own batcher. */
  client(): Record<string, unknown> {
    return {
      check: async () => {
        await new Promise((r) => setImmediate(r));
        return {
          allowed: this.used < this.limit,
          limit: this.limit,
          used: this.used,
          remaining: Math.max(0, this.limit - this.used),
          resetAt: new Date(Date.now() + 3_600_000).toISOString(),
          unlimited: false,
        };
      },
      incrementMetered: async (_org: string, _type: string, _auth: string, groups: { amount: number }[]) => {
        await new Promise((r) => setImmediate(r));
        // The quota service's conditional update: admit what fits, in one step.
        const amount = groups.reduce((n, g) => n + g.amount, 0);
        const counted = Math.max(0, Math.min(amount, this.limit - this.used));
        this.used += counted;
        this.ledger.counted += counted;
        this.ledger.overshoot += amount - counted;
        return { counted, overshoot: amount - counted };
      },
    };
  }
}

/** Run one request through apiCallsQuota (meter + deferred check run by "requireAuth"). */
async function serve(quotaService: never, orgId: string): Promise<boolean> {
  const [meter, deferredCheck] = apiCallsQuota(quotaService);
  let finish: (() => void) | undefined;
  const res = {
    statusCode: 200,
    locals: {} as Record<string, unknown>,
    on: (evt: string, cb: () => void) => { if (evt === 'finish') finish = cb; },
    setHeader: () => undefined,
    status() { this.statusCode = 429; return this; },
    json() { return this; },
    headersSent: false,
  };
  const req = { method: 'GET', originalUrl: '/things', headers: {}, user: { sub: 'user-1', organizationId: orgId, principalType: 'user' } };
  await new Promise<void>((resolve) => meter(req as never, res as never, () => resolve()));
  await new Promise<void>((resolve) => deferredCheck(req as never, res as never, () => resolve()));
  // requireAuth's hand-over: run the armed check.
  const check = res.locals.deferredQuotaCheck as (rq: unknown, rs: unknown, n: () => void) => Promise<void>;
  let passed = false;
  await check(req, res, () => { passed = true; });
  if (!passed) res.statusCode = 429;
  finish?.(); // the response completes; only a 2xx is metered
  return passed;
}

describe('apiCalls at the cap, under concurrency', () => {
  beforeEach(() => { clearQuotaCheckCache(); });

  it('never counts past the limit across parallel requests on several pods, and the ledger adds up', async () => {
    const backend = new FakeQuotaBackend(50);
    const pods = [backend.client(), backend.client(), backend.client()];
    const N = 300;
    const outcomes = await Promise.all(
      Array.from({ length: N }, (_, i) => serve(pods[i % pods.length] as never, 'org-cc')),
    );
    await flushQuotaIncrements();
    const served = outcomes.filter(Boolean).length;

    expect(backend.used).toBeLessThanOrEqual(backend.limit);
    // Every served request is accounted for exactly once.
    expect(backend.ledger.counted + backend.ledger.overshoot).toBe(served);
    expect(backend.ledger.counted).toBe(backend.used);
    // More were served than fit (the counter lags by a flush), so the cap was
    // reached and the excess is VISIBLE as overshoot rather than lost.
    expect(served).toBeGreaterThanOrEqual(backend.limit);
    expect(backend.used).toBe(backend.limit);
    expect(backend.ledger.overshoot).toBe(served - backend.limit);
  });

  it('once the counter is full, the gate refuses and nothing more is counted', async () => {
    const backend = new FakeQuotaBackend(10);
    backend.used = 10;
    const pod = backend.client();
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => serve(pod as never, 'org-full')));
    await flushQuotaIncrements();
    expect(outcomes.every((o) => o === false)).toBe(true);
    expect(backend.used).toBe(10);
    expect(backend.ledger).toEqual({ counted: 0, overshoot: 0 });
  });
});
