// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the remote-audit client: verifies that best-effort emission is
 * retry-safe (carries an Idempotency-Key + a real retry budget) and stays
 * fire-and-forget (never throws to the caller).
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  getServiceAuthHeader: jest.fn(() => 'service-token-raw'),
  // wireAuthzDenialAuditor registers via this; capture the sink for assertions.
  setAuthzDenialAuditor: jest.fn(),
}));

// Capture the post() calls made by the client under test.
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../src/services/http-client.js', () => ({
  createSafeClient: () => ({ post: mockPost, get: jest.fn(), put: jest.fn(), delete: jest.fn() }),
}));

const { createRemoteAuditClient, wireAuthzDenialAuditor } = await import('../src/services/remote-audit-client.js');
const { setAuthzDenialAuditor } = await import('../src/middleware/auth.js');

const EVENT = {
  action: 'pipeline.create' as const,
  actorId: 'user-1',
  orgId: 'org-acme',
  targetType: 'pipeline',
  targetId: 'pl-123',
};

describe('createRemoteAuditClient.record', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ statusCode: 200, body: {}, headers: {} });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('posts to /audit/events with a retry budget (transient failures are not single-shot)', async () => {
    const client = createRemoteAuditClient();
    client.record(EVENT, 'pipeline');
    // record() is fire-and-forget; let the microtask settle.
    await Promise.resolve();

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body, options] = mockPost.mock.calls[0];
    expect(path).toBe('/audit/events');
    // record() stamps occurredAt + a stable idempotencyKey onto the emitted body.
    expect(body).toEqual(expect.objectContaining(EVENT));
    expect(typeof body.occurredAt).toBe('string');
    expect(typeof body.idempotencyKey).toBe('string');
    // The whole point of the fix: this POST must be allowed to retry.
    expect(options.maxRetries).toBeGreaterThanOrEqual(2);
    expect(options.maxRateLimitRetries).toBeGreaterThanOrEqual(1);
  });

  it('carries an Idempotency-Key so the non-idempotent POST is retry-safe + dedup-able', async () => {
    const client = createRemoteAuditClient();
    client.record(EVENT, 'pipeline');
    await Promise.resolve();

    const options = mockPost.mock.calls[0][2];
    expect(options.headers.Authorization).toBe('service-token-raw');
    expect(typeof options.headers['Idempotency-Key']).toBe('string');
    expect(options.headers['Idempotency-Key'].length).toBeGreaterThan(0);
  });

  it('gives each emission a distinct Idempotency-Key', async () => {
    const client = createRemoteAuditClient();
    client.record(EVENT, 'pipeline');
    client.record(EVENT, 'pipeline');
    await Promise.resolve();

    const k1 = mockPost.mock.calls[0][2].headers['Idempotency-Key'];
    const k2 = mockPost.mock.calls[1][2].headers['Idempotency-Key'];
    expect(k1).not.toBe(k2);
  });

  it('never throws to the caller when the POST rejects (fire-and-forget)', async () => {
    mockPost.mockRejectedValue(new Error('platform down'));
    const client = createRemoteAuditClient();
    expect(() => client.record(EVENT, 'pipeline')).not.toThrow();
    // Let the rejected promise settle without an unhandled rejection.
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('wireAuthzDenialAuditor', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('registers a sink that forwards a failure-outcome authz.denied event to the client', () => {
    const record = jest.fn();
    const fakeClient = { record } as any;
    wireAuthzDenialAuditor('pipeline', () => fakeClient);

    // The helper registered exactly one sink with setAuthzDenialAuditor.
    expect(setAuthzDenialAuditor).toHaveBeenCalledTimes(1);
    const sink = (setAuthzDenialAuditor as any).mock.calls[0][0] as (info: any) => void;

    sink({ actorId: 'u-1', actorEmail: 'u@x.io', orgId: 'org-acme', method: 'POST', path: '/pipelines', required: 'pipelines:write' });

    expect(record).toHaveBeenCalledWith({
      action: 'authz.denied',
      actorId: 'u-1',
      actorEmail: 'u@x.io',
      orgId: 'org-acme',
      outcome: 'failure',
      details: { method: 'POST', path: '/pipelines', required: 'pipelines:write' },
    }, 'pipeline');
  });

  it('defaults a missing actorId to "anonymous"', () => {
    const record = jest.fn();
    wireAuthzDenialAuditor('quota', () => ({ record } as any));
    const sink = (setAuthzDenialAuditor as any).mock.calls[0][0] as (info: any) => void;
    sink({ method: 'DELETE', path: '/quotas/x', required: 'system-admin' });
    expect(record.mock.calls[0][0].actorId).toBe('anonymous');
  });
});

describe('remote-audit spool integration', () => {
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
  function memSpool() {
    const buf: any[] = [];
    return {
      enqueue: async (e: any) => { buf.push(e); },
      // take() removes from the buffer in this simple model, so ack() is a no-op
      // and recover() has nothing to reclaim; requeue() puts failures back.
      take: async (n: number) => buf.splice(0, n),
      ack: async () => undefined,
      requeue: async (es: any[]) => { buf.unshift(...es); },
      recover: async () => 0,
      depth: async () => buf.length,
    };
  }

  afterEach(() => { jest.clearAllMocks(); });

  it('spools an emission when the platform is down, then drains it on the next success', async () => {
    const spool = memSpool();
    const client = createRemoteAuditClient({ spool, drainIntervalMs: 1_000_000 });

    // Platform down: the live attempt fails → the event is buffered, not lost.
    mockPost.mockReset();
    mockPost.mockRejectedValue(new Error('platform down'));
    client.record(EVENT, 'pipeline');
    await flush();
    expect(await spool.depth()).toBe(1);

    // Platform recovers: the next successful emission drains the backlog too.
    mockPost.mockReset();
    mockPost.mockResolvedValue({ statusCode: 200, body: {}, headers: {} });
    client.record({ ...EVENT, action: 'pipeline.update' as const }, 'pipeline');
    await flush();

    expect(mockPost.mock.calls.length).toBeGreaterThanOrEqual(2); // new event + drained backlog
    expect(await spool.depth()).toBe(0);
    client.close();
  });

  it('reuses the same Idempotency-Key for a spooled event across its re-delivery', async () => {
    const spool = memSpool();
    const client = createRemoteAuditClient({ spool, drainIntervalMs: 1_000_000 });

    mockPost.mockReset();
    mockPost.mockRejectedValue(new Error('down'));
    client.record(EVENT, 'pipeline');
    await flush();
    const spooled = (await spool.depth()) === 1;
    expect(spooled).toBe(true);

    mockPost.mockReset();
    mockPost.mockResolvedValue({ statusCode: 200, body: {}, headers: {} });
    client.record({ ...EVENT, action: 'pipeline.update' as const }, 'pipeline');
    await flush();

    // Every post carried a string Idempotency-Key; the drained one keeps its own.
    for (const call of mockPost.mock.calls) {
      expect(typeof call[2].headers['Idempotency-Key']).toBe('string');
    }
    client.close();
  });
});
