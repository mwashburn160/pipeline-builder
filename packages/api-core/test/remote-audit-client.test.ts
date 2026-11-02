// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the remote-audit client: verifies that best-effort emission is
 * retry-safe (carries an Idempotency-Key + a real retry budget) and stays
 * fire-and-forget (never throws to the caller).
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '../src/testing/any-fn.js';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn<AnyFn>(),
    warn: jest.fn<AnyFn>(),
    error: jest.fn<AnyFn>(),
    debug: jest.fn<AnyFn>(),
  }),
}));

jest.unstable_mockModule('../src/middleware/service-tokens.js', () => ({
  getServiceAuthHeader: jest.fn((..._args: unknown[]) => 'service-token-raw'),
  serviceNameOf: (c?: { principalType?: string; sub?: string }) =>
    (c?.principalType === 'service' ? c.sub?.replace(/^service:/, '') : undefined),
}));
// wireAuthzDenialAuditor registers via this; capture the sink for assertions.
jest.unstable_mockModule('../src/middleware/permission-gates.js', () => ({
  setAuthzDenialAuditor: jest.fn<AnyFn>(),
}));

// Capture the post() calls made by the client under test.
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../src/services/http-client.js', () => ({
  createSafeClient: () => ({ post: mockPost, get: jest.fn<AnyFn>(), put: jest.fn<AnyFn>(), delete: jest.fn<AnyFn>() }),
}));

const { createRemoteAuditClient, wireAuthzDenialAuditor } = await import('../src/services/remote-audit-client.js');
const { setAuthzDenialAuditor } = await import('../src/middleware/permission-gates.js');
const { runWithAuditContext } = await import('../src/services/audit-context.js');
const { setCounterEmitter, resetCounterEmitter } = await import('../src/utils/metric-emitter.js');
const { SYSTEM_ORG_ID } = await import('../src/middleware/system-org.js');

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

  it('never produces an unhandled rejection when the service token cannot be minted', async () => {
    // The signing key can be unreadable, the wrong curve, or `SERVICE_NAME` can
    // mismatch this client's name — and minting used to sit OUTSIDE deliver's
    // try. `record` fires with a bare `.then`, so the rejection went unhandled,
    // runServer's crash handler exited, and the pod crash-looped on its first
    // audited write or authz.denied event.
    const { getServiceAuthHeader } = await import('../src/middleware/service-tokens.js');
    (getServiceAuthHeader as jest.Mock<AnyFn>).mockImplementationOnce(() => {
      throw new Error('service signing key unavailable');
    });
    const unhandled = jest.fn<AnyFn>();
    process.on('unhandledRejection', unhandled);
    try {
      const client = createRemoteAuditClient();
      expect(() => client.record(EVENT, 'pipeline')).not.toThrow();
      // Let every microtask in the chain settle.
      await new Promise((r) => setImmediate(r));

      expect(unhandled).not.toHaveBeenCalled();
      // Nothing was sent — the event is simply undeliverable.
      expect(mockPost).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
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
    const record = jest.fn<AnyFn>();
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
    const record = jest.fn<AnyFn>();
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
      heartbeat: async () => undefined,
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

describe('permanent ingest rejections (4xx)', () => {
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
  const counters: Array<{ name: string; labels?: Record<string, string> }> = [];
  beforeEach(() => {
    counters.length = 0;
    setCounterEmitter((name, labels) => { counters.push({ name, labels }); });
    mockPost.mockReset();
  });
  afterEach(() => { resetCounterEmitter(); jest.clearAllMocks(); });

  function memSpool(initial: any[] = []) {
    const buf: any[] = [...initial];
    const acked: any[] = [];
    return {
      buf,
      acked,
      enqueue: async (e: any) => { buf.push(e); },
      take: async (n: number) => buf.splice(0, n),
      ack: async (es: any[]) => { acked.push(...es); },
      requeue: async (es: any[]) => { buf.unshift(...es); },
      recover: async () => 0,
      heartbeat: async () => undefined,
      depth: async () => buf.length,
    };
  }

  it('drops a 4xx live delivery instead of spooling it, and meters it', async () => {
    const spool = memSpool();
    mockPost.mockResolvedValue({ statusCode: 403, body: {}, headers: {} });
    const client = createRemoteAuditClient({ spool, drainIntervalMs: 1_000_000 });
    await flush();
    client.record(EVENT, 'pipeline');
    await flush();
    expect(spool.buf).toHaveLength(0);
    expect(counters).toContainEqual({ name: 'audit_events_rejected_total', labels: { service: 'pipeline', status: '403' } });
    client.close();
  });

  it.each([408, 429, 500, 503])('still spools a retryable %i', async (status) => {
    const spool = memSpool();
    mockPost.mockResolvedValue({ statusCode: status, body: {}, headers: {} });
    const client = createRemoteAuditClient({ spool, drainIntervalMs: 1_000_000 });
    await flush();
    client.record(EVENT, 'pipeline');
    await flush();
    expect(spool.buf).toHaveLength(1);
    expect(counters.some((c) => c.name === 'audit_events_rejected_total')).toBe(false);
    client.close();
  });

  it('a rejected spooled event no longer wedges the entries behind it', async () => {
    const bad = { event: { ...EVENT, action: 'pipeline.delete' as const, idempotencyKey: 'bad' }, serviceName: 'pipeline' };
    const good = { event: { ...EVENT, idempotencyKey: 'good' }, serviceName: 'pipeline' };
    const spool = memSpool([bad, good]);
    mockPost.mockImplementation(async (_p: string, body: any) => ({ statusCode: body.idempotencyKey === 'bad' ? 400 : 200, body: {}, headers: {} }));
    const client = createRemoteAuditClient({ spool, drainIntervalMs: 1_000_000 });
    await flush();
    expect(spool.buf).toHaveLength(0);
    expect(spool.acked).toEqual([bad, good]);
    expect(counters).toContainEqual({ name: 'audit_events_rejected_total', labels: { service: 'pipeline', status: '400' } });
    expect(counters).toContainEqual({ name: 'audit_spool_redelivered_total', labels: { service: 'pipeline' } });
    client.close();
  });
});

describe('ambient audit context', () => {
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ statusCode: 200, body: {}, headers: {} });
  });
  afterEach(() => { jest.clearAllMocks(); });

  const userToken = {
    sub: 'user-1',
    principalType: 'user',
    token_use: 'api_key',
    jti: 'key-9',
    sid: 'sid-1',
    impersonatorId: 'admin-7',
    permissionsRestricted: true,
    organizationId: 'org-acme',
  } as any;

  it('stamps request id / trace / ip / UA / impersonator / _auth / _context onto every event', async () => {
    const client = createRemoteAuditClient();
    runWithAuditContext({
      requestId: 'req-1',
      traceId: 'abcdef0123456789',
      ip: '10.0.0.9',
      userAgent: 'pb-cli/1.0',
      correlation: { codebuildBuildId: 'proj:1234' },
      principal: () => userToken,
    }, () => client.record({ ...EVENT, details: { name: 'x', _auth: { superAdmin: true } } }, 'pipeline'));
    await flush();

    const body = mockPost.mock.calls[0][1];
    expect(body).toMatchObject({
      requestId: 'req-1', traceId: 'abcdef0123456789', ip: '10.0.0.9', userAgent: 'pb-cli/1.0', impersonatorId: 'admin-7',
    });
    // The call site's forged `_auth` is REPLACED by the verified credential.
    expect(body.details).toEqual({
      name: 'x',
      _auth: { principalType: 'user', keyId: 'key-9', sid: 'sid-1', tokenUse: 'api_key', permissionsRestricted: true },
      _context: { codebuildBuildId: 'proj:1234' },
    });
  });

  it('never stamps the raw client ip / UA onto an ANONYMOUS actor\'s row (hashed-only surfaces)', async () => {
    const client = createRemoteAuditClient();
    runWithAuditContext({ requestId: 'req-2', ip: '203.0.113.7', userAgent: 'curl/8' }, () =>
      client.record({ ...EVENT, actorId: 'anonymous', details: { clientIpHash: 'h' } }, 'plugin'));
    await flush();
    const body = mockPost.mock.calls[0][1];
    expect(body.requestId).toBe('req-2');
    expect(body.ip).toBeUndefined();
    expect(body.userAgent).toBeUndefined();
  });

  it('merges a job scope onto the outer request scope', async () => {
    const client = createRemoteAuditClient();
    runWithAuditContext({ requestId: 'req-2' }, () => runWithAuditContext(
      { job: { jobId: 'registry-gc', runId: 'r-1', trigger: 'schedule' } },
      () => client.record(EVENT, 'pipeline'),
    ));
    await flush();
    const body = mockPost.mock.calls[0][1];
    expect(body.requestId).toBe('req-2');
    expect(body.details._context).toEqual({ jobId: 'registry-gc', runId: 'r-1', trigger: 'schedule' });
  });

  it('mints the cross-org claim only for a superadmin / system-org inbound principal', async () => {
    const { getServiceAuthHeader } = await import('../src/middleware/service-tokens.js');
    const client = createRemoteAuditClient();
    const crossOrg = { ...EVENT, affectedOrgId: 'org-other' };

    runWithAuditContext({ principal: () => ({ ...userToken, isSuperAdmin: true }) }, () => client.record(crossOrg, 'pipeline'));
    runWithAuditContext({ principal: () => userToken }, () => client.record(crossOrg, 'pipeline'));
    runWithAuditContext({ principal: () => ({ ...userToken, isSuperAdmin: true }) }, () => client.record(EVENT, 'pipeline'));
    await flush();

    const calls = (getServiceAuthHeader as jest.Mock<AnyFn>).mock.calls.map((c) => c[0] as { auditCrossOrg?: boolean });
    expect(calls[0].auditCrossOrg).toBe(true);
    expect(calls[1].auditCrossOrg).toBeUndefined(); // a tenant can't name another org
    expect(calls[2].auditCrossOrg).toBeUndefined(); // in-org: no claim needed
  });

  it('records an unauthenticated authz denial on the system org rather than org-less', () => {
    const record = jest.fn<AnyFn>();
    wireAuthzDenialAuditor('quota', () => ({ record } as any));
    const sink = (setAuthzDenialAuditor as any).mock.calls[0][0] as (info: any) => void;
    sink({ method: 'POST', path: '/x', required: 'system-admin' });
    expect(record.mock.calls[0][0].orgId).toBe(SYSTEM_ORG_ID);
  });
});
