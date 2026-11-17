// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The incident client: the ONE support call that fails CLOSED.
 *
 * Spending an incident is a purchase decision, not a promise, so every failure
 * mode — a refusal, or an outcome that stays unknown after retrying the same
 * idempotency key — must read as "not consumed" (no case opened), and none may
 * throw into the send path. Refund is best-effort and must never throw either.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockWarn = jest.fn<AnyFn>();
const mockError = jest.fn<AnyFn>();

/** One request made through the shared http-client, shaped like the old fetch call for the assertions. */
type HttpCall = { config: Record<string, unknown>; path: string; body: unknown; options: Record<string, any> };
let httpCalls: HttpCall[] = [];
let replyFor: (call: HttpCall) => Promise<{ statusCode: number; body: unknown }> = async () => ({ statusCode: 200, body: {} });
class FakeHttpClient {
  constructor(private readonly config: Record<string, unknown>) {}
  async post(path: string, body: unknown, options: Record<string, unknown>) {
    const call = { config: this.config, path, body, options };
    httpCalls.push(call);
    return { ...(await replyFor(call)), headers: {} };
  }
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  InternalHttpClient: FakeHttpClient,
  createLogger: () => ({ warn: mockWarn, info: () => {}, debug: () => {}, error: mockError }),
  getServiceAuthHeader: () => 'Bearer service-token',
  envInt: (_n: string, d: number) => d,
  errorMessage: (e: unknown) => String(e),
  SYSTEM_ORG_ID: '000000000000000000000001',
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { billingHost: 'billing', billingPort: 3000 } }) },
}));

const { consumeSupportIncident, refundSupportIncident } = await import('../src/services/support-incident-client.js');

type Reply = { ok: boolean; status?: number; body?: unknown } | Error;
const toReply = (init: Reply) => (init instanceof Error
  ? async () => { throw init; }
  : async () => ({ statusCode: init.status ?? (init.ok ? 200 : 500), body: init.body ?? {} }));
/** Every call answers `init`. */
function respond(init: Reply): void {
  replyFor = toReply(init);
}
/** Calls answer `replies` in order, the last one repeating. */
function respondSeq(...replies: Reply[]): void {
  let i = 0;
  replyFor = async () => toReply(replies[Math.min(i++, replies.length - 1)])();
}
const KEY = 'submission-0001';
const bodyOf = (call: HttpCall) => call.body as Record<string, unknown>;
const urls = () => httpCalls.map((c) => c.path.split('/').pop());
const TIMEOUT = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

beforeEach(() => {
  httpCalls = [];
  mockWarn.mockReset();
  mockError.mockReset();
});

describe('consumeSupportIncident', () => {
  it('POSTs the consume route with the service token and the idempotency key, true on consumed:true', async () => {
    respond({ ok: true, body: { data: { consumed: true, remaining: 0 } } });
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(true);
    const [call] = httpCalls;
    expect(call.config).toEqual({ host: 'billing', port: 3000, timeout: 3000 });
    expect(call.path).toBe('/billing/internal/support-incidents/org-1/consume');
    expect(call.options.headers).toEqual({ Authorization: 'Bearer service-token' });
    // The loop below owns retrying (same key); the client must not add its own,
    // and a 429 must stay a definite refusal.
    expect(call.options).toMatchObject({ maxRetries: 0, maxRateLimitRetries: 0 });
    expect(bodyOf(call)).toEqual({ idempotencyKey: KEY });
    expect(httpCalls).toHaveLength(1);
  });

  it('returns false on consumed:false (none left) — a definite answer, not retried', async () => {
    respond({ ok: true, body: { data: { consumed: false, remaining: 0 } } });
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(false);
    expect(httpCalls).toHaveLength(1);
  });

  it('a 4xx is a definite refusal — false, not retried, nothing refunded', async () => {
    respond({ ok: false, status: 403, body: {} });
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(false);
    expect(urls()).toEqual(['consume']);
    expect(mockWarn).toHaveBeenCalledWith('Incident consume refused by billing', { orgId: 'org-1', status: 403 });
  });

  it('RETRIES a timeout with the SAME key and takes the replayed outcome', async () => {
    // The first attempt may have committed; billing replays it under the key.
    respondSeq(TIMEOUT, { ok: true, body: { data: { consumed: true, remaining: 0 } } });
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(true);
    expect(urls()).toEqual(['consume', 'consume']);
    expect(httpCalls.map(bodyOf)).toEqual([{ idempotencyKey: KEY }, { idempotencyKey: KEY }]);
  });

  it('retries a 5xx (it may follow a committed spend)', async () => {
    respondSeq({ ok: false, status: 503, body: {} }, { ok: true, body: { data: { consumed: false, remaining: 0 } } });
    await expect(consumeSupportIncident('team-1', KEY)).resolves.toBe(false);
    expect(urls()).toEqual(['consume', 'consume']);
  });

  it('fails CLOSED after bounded retries — and REFUNDS under the same key so a committed spend comes back', async () => {
    respondSeq(TIMEOUT, TIMEOUT, TIMEOUT, { ok: true, body: { data: { refunded: true, balance: 1 } } });
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(false);
    expect(urls()).toEqual(['consume', 'consume', 'consume', 'refund']);
    expect(bodyOf(httpCalls[3])).toEqual({ idempotencyKey: KEY });
    expect(mockWarn).toHaveBeenCalledWith('Incident consume unavailable', expect.objectContaining({ orgId: 'org-1' }));
  });

  it('treats a body that does not literally say consumed:true/false as UNKNOWN', async () => {
    respondSeq({ ok: true, body: { data: { consumed: 'yes' } } }, { ok: true, body: null }, { ok: true, body: {} }, { ok: true, body: {} });
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(false);
    expect(urls()).toEqual(['consume', 'consume', 'consume', 'refund']);
  });

  it('treats an unparseable reply (the client hands back {}) as UNKNOWN, never as a throw', async () => {
    replyFor = async (call) => ({ statusCode: 200, body: call.path.endsWith('/refund') ? { data: { refunded: true, balance: 1 } } : {} });
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(false);
    expect(urls()).toEqual(['consume', 'consume', 'consume', 'refund']);
  });

  it('treats an open circuit breaker as UNKNOWN (an earlier attempt may have committed) and still refunds', async () => {
    const open = Object.assign(new Error('Circuit open for billing:3000'), { name: 'CircuitOpenError' });
    respondSeq(TIMEOUT, open, open, open);
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(false);
    expect(urls()).toEqual(['consume', 'consume', 'consume', 'refund']);
  });

  it('url-encodes the org id', async () => {
    respond({ ok: true, body: { data: { consumed: true, remaining: 0 } } });
    await consumeSupportIncident('a/b', KEY);
    expect(httpCalls[0].path).toBe('/billing/internal/support-incidents/a%2Fb/consume');
  });
});

describe('refundSupportIncident', () => {
  it('POSTs the refund route with the spend key', async () => {
    respond({ ok: true, body: { data: { refunded: true, balance: 1 } } });
    await expect(refundSupportIncident('org-1', KEY)).resolves.toBeUndefined();
    expect(httpCalls[0].path).toBe('/billing/internal/support-incidents/org-1/refund');
    expect(bodyOf(httpCalls[0])).toEqual({ idempotencyKey: KEY });
    expect(mockError).not.toHaveBeenCalled();
  });

  it('logs an ERROR (never throws) when billing refuses the refund', async () => {
    respond({ ok: false, status: 500 });
    await expect(refundSupportIncident('org-1', KEY)).resolves.toBeUndefined();
    expect(mockError).toHaveBeenCalledWith('Incident refund refused by billing', { orgId: 'org-1', status: 500 });
  });

  it('logs an ERROR (never throws) when billing is unreachable', async () => {
    respond(new Error('ECONNREFUSED'));
    await expect(refundSupportIncident('org-1', KEY)).resolves.toBeUndefined();
    expect(mockError).toHaveBeenCalledWith(
      'Incident refund unavailable — a concession was spent on a failed case',
      expect.objectContaining({ orgId: 'org-1' }),
    );
  });
});
