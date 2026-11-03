// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the quota service client — the fail-open / fail-closed
 * enforcement policy that gates paid resources.
 *
 * The client talks to the quota service through `createSafeClient` (from
 * services/http-client.js), which returns a parsed `{ statusCode, body }` for a
 * REACHABLE response (including 4xx/5xx) and `null` when the service is
 * UNREACHABLE (connection error / timeout). We mock at that boundary so the
 * tests exercise the real fail-open vs fail-closed branching in quota.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { QuotaTier } from '../src/types/quota-tiers.js';

// Mock boundaries: the safe HTTP client (so no real network) and the logger
// (avoids Winston open handles). Re-registered on every fresh module load.
const mockGet = jest.fn<(...args: any[]) => any>();
const mockPost = jest.fn<(...args: any[]) => any>();
const mockPut = jest.fn<(...args: any[]) => any>();
const mockDelete = jest.fn<(...args: any[]) => any>();

function registerMocks(): void {
  jest.unstable_mockModule('../src/utils/logger.js', () => ({
    createLogger: () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }),
  }));
  jest.unstable_mockModule('../src/services/http-client.js', () => ({
    createSafeClient: () => ({ get: mockGet, post: mockPost, put: mockPut, delete: mockDelete }),
  }));
}

/**
 * Load a fresh copy of quota.ts and return a client. quota.ts reads
 * `QUOTA_RESERVE_FAIL_OPEN` at MODULE LOAD time, so toggling it requires a
 * module reset + re-import (not just a per-call env change).
 */
async function loadQuotaService(opts: { reserveFailOpen?: boolean } = {}) {
  jest.resetModules();
  if (opts.reserveFailOpen) {
    process.env.QUOTA_RESERVE_FAIL_OPEN = 'true';
  } else {
    delete process.env.QUOTA_RESERVE_FAIL_OPEN;
  }
  registerMocks();
  const mod = await import('../src/services/quota.js');
  return mod.createQuotaService();
}

/** Build a fake reachable HTTP response (what createSafeClient yields). */
function httpResponse(statusCode: number, body: unknown) {
  return { statusCode, body, headers: {} };
}

const AUTH = 'Bearer test-token';

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPut.mockReset();
  mockDelete.mockReset();
});

// ---------------------------------------------------------------------------
// reserve() — the crown-jewel fail-open/fail-closed logic
// ---------------------------------------------------------------------------

describe('quota.reserve', () => {
  it('returns exceeded:true (429 path) when the service reports over-limit', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(
      httpResponse(429, {
        success: false,
        code: 'QUOTA_EXCEEDED',
        details: { quota: { type: 'pipelines', limit: 5, used: 5, remaining: 0, resetAt: '2026-08-01T00:00:00Z' } },
      }),
    );

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.exceeded).toBe(true);
    expect(result.quota).toEqual({ type: 'pipelines', limit: 5, used: 5, remaining: 0, resetAt: '2026-08-01T00:00:00Z' });
    // A real over-limit is NOT an outage.
    expect(result.unavailable).toBeUndefined();
  });

  it('returns exceeded:true even when a 429 omits the quota detail (safe default)', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(429, { success: false, code: 'QUOTA_EXCEEDED' }));

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.exceeded).toBe(true);
    expect(result.quota).toEqual({ type: 'pipelines', limit: 0, used: 0, remaining: 0 });
    // Recognized by `code` (the field sendError emits) — a genuine over-limit,
    // not an unconfirmed reservation answered as a 503.
    expect(result.unavailable).toBeUndefined();
  });

  it('FAILS CLOSED on an errored-but-reachable response (HTTP 500) by default', async () => {
    // Reachable-but-erroring quota service is often an OVERLOADED one; failing
    // open here would pile unmetered expensive work onto it. Default = deny.
    const quotaService = await loadQuotaService(); // QUOTA_RESERVE_FAIL_OPEN unset
    mockPost.mockResolvedValue(httpResponse(500, { success: false }));

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.exceeded).toBe(true);
    expect(result.unavailable).toBe(true);
    expect(result.quota).toEqual({ type: 'pipelines', limit: 0, used: 0, remaining: 0 });
  });

  it('FAILS OPEN on an errored response when QUOTA_RESERVE_FAIL_OPEN=true', async () => {
    const quotaService = await loadQuotaService({ reserveFailOpen: true });
    mockPost.mockResolvedValue(httpResponse(500, { success: false }));

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.exceeded).toBe(false);
    expect(result.quota).toEqual({ type: 'pipelines', limit: -1, used: 0, remaining: -1 });
  });

  // Explicit reserve fail mode: an UNCONFIRMED reservation — unreachable,
  // timed out, circuit open (all surface as a null response from the safe
  // client), or a non-QUOTA_EXCEEDED 429 — is denied by default. Quota types are
  // per-period FLOW counters with no reconciliation, so fail-open would let an
  // org consume unmetered billable units for the length of the incident.
  it('FAILS CLOSED on an UNREACHABLE / timed-out / circuit-open service (null response) by default', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(null);

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.unavailable).toBe(true);
    expect(result.exceeded).toBe(true);
    expect(result.quota).toEqual({ type: 'pipelines', limit: 0, used: 0, remaining: 0 });
  });

  it('FAILS CLOSED on a 429 that is NOT a genuine QUOTA_EXCEEDED (gateway / rate limiter) by default', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(429, { success: false, code: 'RATE_LIMIT_EXCEEDED' }));

    const result = await quotaService.reserve('org1', 'pipelines', AUTH);

    expect(result.unavailable).toBe(true);
    expect(result.exceeded).toBe(true);
    expect(result.quota).toEqual({ type: 'pipelines', limit: 0, used: 0, remaining: 0 });
  });

  it('FAILS OPEN on every unconfirmed outcome when QUOTA_RESERVE_FAIL_OPEN=true', async () => {
    const quotaService = await loadQuotaService({ reserveFailOpen: true });
    for (const outcome of [null, httpResponse(429, { success: false, code: 'RATE_LIMIT_EXCEEDED' }), httpResponse(503, { success: false })]) {
      mockPost.mockResolvedValueOnce(outcome);
      const result = await quotaService.reserve('org1', 'pipelines', AUTH);
      expect(result.exceeded).toBe(false);
    }
  });

  it('a genuine QUOTA_EXCEEDED 429 is denied even with QUOTA_RESERVE_FAIL_OPEN=true', async () => {
    const quotaService = await loadQuotaService({ reserveFailOpen: true });
    mockPost.mockResolvedValue(httpResponse(429, { success: false, code: 'QUOTA_EXCEEDED' }));

    expect((await quotaService.reserve('org1', 'pipelines', AUTH)).exceeded).toBe(true);
  });

  it('returns exceeded:false with the reserved quota on a 200 success', async () => {
    const quotaService = await loadQuotaService();
    const quota = { type: 'pipelines', limit: 10, used: 4, remaining: 6, resetAt: '2026-08-01T00:00:00Z' };
    mockPost.mockResolvedValue(httpResponse(200, { success: true, data: { quota } }));

    const result = await quotaService.reserve('org1', 'pipelines', AUTH, 1);

    expect(result.exceeded).toBe(false);
    expect(result.quota).toEqual(quota);
    // Reserve is an atomic check+increment on the increment endpoint.
    expect(mockPost).toHaveBeenCalledWith(
      '/quotas/org1/increment',
      { quotaType: 'pipelines', amount: 1 },
      expect.objectContaining({ headers: expect.objectContaining({ 'x-org-id': 'org1', 'Authorization': AUTH }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// check() — fail-open read path
// ---------------------------------------------------------------------------

describe('quota.check', () => {
  it('returns the service status on a 200 success (happy path)', async () => {
    const quotaService = await loadQuotaService();
    const status = { allowed: true, limit: 100, used: 10, remaining: 90, resetAt: '2026-08-01T00:00:00Z', unlimited: false };
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quotaType: 'apiCalls', status } }));

    const result = await quotaService.check('org1', 'apiCalls', AUTH);

    expect(result).toEqual(status);
    expect(mockGet).toHaveBeenCalledWith('/quotas/org1/apiCalls', expect.any(Object));
  });

  it('FAILS OPEN (allowed) when the service is unreachable (null response)', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(null);

    const result = await quotaService.check('org1', 'apiCalls', AUTH);

    expect(result.allowed).toBe(true);
    expect(result.unlimited).toBe(true);
    expect(result.failOpen).toBe(true);
  });

  it('FAILS OPEN (allowed) on a non-ok response (HTTP 500)', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(500, { success: false }));

    const result = await quotaService.check('org1', 'apiCalls', AUTH);

    expect(result.allowed).toBe(true);
    expect(result.failOpen).toBe(true);
  });

  it('reads a counter quota on a short budget with NO retry (QUOTA_CHECK_TIMEOUT_MS, default 300)', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quotaType: 'apiCalls', status: { allowed: true } } }));
    await quotaService.check('org1', 'apiCalls', AUTH);
    expect(mockGet.mock.calls[0]![1]).toEqual(expect.objectContaining({ timeout: 300, maxRetries: 0, maxRateLimitRetries: 0 }));
  });

  it('keeps the client timeout and one retry for the MEASURED storageBytes read', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quotaType: 'storageBytes', status: { allowed: true } } }));
    await quotaService.check('org1', 'storageBytes', AUTH);
    const opts = mockGet.mock.calls[0]![1] as Record<string, unknown>;
    expect(opts.timeout).toBeUndefined();
    expect(opts.maxRetries).toBe(1);
  });
});

describe('quota.incrementMetered', () => {
  it('posts the summed groups as one metered increment and returns what was counted', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(200, { success: true, data: { counted: 3, overshoot: 2 } }));
    const groups = [{ amount: 4, attribution: { principalId: 'u1' } }, { amount: 1 }];
    const out = await quotaService.incrementMetered('org1', 'apiCalls', AUTH, groups);
    expect(out).toEqual({ counted: 3, overshoot: 2 });
    expect(mockPost).toHaveBeenCalledWith('/quotas/org1/increment', { quotaType: 'apiCalls', amount: 5, meter: true, groups }, expect.any(Object));
  });

  it('answers null and counts a lost batch when the quota service does not answer ok', async () => {
    jest.resetModules();
    registerMocks();
    const counts: [string, Record<string, string> | undefined][] = [];
    const { setCounterEmitter } = await import('../src/utils/metric-emitter.js');
    setCounterEmitter((name, labels) => { counts.push([name, labels]); });
    const { createQuotaService } = await import('../src/services/quota.js');
    const quotaService = createQuotaService();
    mockPost.mockResolvedValueOnce(null).mockResolvedValueOnce(httpResponse(503, { success: false }));
    expect(await quotaService.incrementMetered('org1', 'apiCalls', AUTH, [{ amount: 2 }])).toBeNull();
    expect(await quotaService.incrementMetered('org1', 'apiCalls', AUTH, [{ amount: 2 }])).toBeNull();
    expect(counts.filter(([n]) => n === 'quota_increment_failures_total').map(([, l]) => l?.reason)).toEqual(['unreachable', 'non-ok']);
  });
});

describe('callQuotaExemption', () => {
  it('skips service principals, impersonation sessions, and nothing else without a valid marker', async () => {
    jest.resetModules();
    registerMocks();
    const { callQuotaExemption } = await import('../src/services/quota.js');
    expect(callQuotaExemption({ headers: {}, user: { principalType: 'service', sub: 'service:x' } } as never)).toBe('service');
    expect(callQuotaExemption({ headers: {}, user: { principalType: 'user', sub: 'u1', organizationId: 'o1', impersonatorId: 'admin1' } } as never)).toBe('impersonation');
    expect(callQuotaExemption({ headers: {}, user: { principalType: 'user', sub: 'u1', organizationId: 'o1' } } as never)).toBeUndefined();
    // A user-supplied marker that is not a service-signed token changes nothing.
    expect(callQuotaExemption({ headers: { 'x-pb-on-behalf': 'forged' }, user: { principalType: 'user', sub: 'u1', organizationId: 'o1' } } as never)).toBeUndefined();
    expect(callQuotaExemption({ headers: {} } as never)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// increment() / decrement() — fire-and-forget, never throw
// ---------------------------------------------------------------------------

describe('quota.increment', () => {
  it('posts to the increment endpoint on the happy path', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(200, { success: true }));

    await expect(quotaService.increment('org1', 'apiCalls', AUTH, 2)).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledWith(
      '/quotas/org1/increment',
      { quotaType: 'apiCalls', amount: 2 },
      expect.any(Object),
    );
  });

  it('does not throw when the service is unreachable (null response)', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(null);
    await expect(quotaService.increment('org1', 'apiCalls', AUTH)).resolves.toBeUndefined();
  });
});

describe('usage attribution + metering selection', () => {
  it('sends an explicit attribution block and its request id', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(200, { success: true }));
    const attribution = { principalType: 'service_account' as const, principalId: 'sa-1', keyId: 'k-1', route: 'GET /plugins/:name', requestId: 'req-1' };

    await quotaService.increment('org1', 'automationCalls', AUTH, 1, attribution);

    const [, body, opts] = mockPost.mock.calls[0] as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(body).toEqual({ quotaType: 'automationCalls', amount: 1, attribution });
    expect(opts.headers['X-Request-Id']).toBe('req-1');
  });

  it('falls back to the ambient request context when none is passed', async () => {
    const quotaService = await loadQuotaService();
    const { runWithAuditContext } = await import('../src/services/audit-context.js');
    mockPost.mockResolvedValue(httpResponse(200, { success: true, data: { quota: { type: 'aiCalls', limit: 5, used: 1, remaining: 4 } } }));

    await runWithAuditContext(
      { requestId: 'ctx-req', principal: () => ({ sub: 'u-1', principalType: 'user', jti: 'tok-1' } as never) },
      () => quotaService.reserve('org1', 'aiCalls', AUTH),
    );

    const [, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.attribution).toEqual({ principalType: 'user', principalId: 'u-1', keyId: 'tok-1', requestId: 'ctx-req' });
  });

  it('sends no attribution outside any scope (the body keeps its original shape)', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(200, { success: true }));
    await quotaService.decrement('org1', 'plugins', AUTH, 1);
    expect(mockPost.mock.calls[0][1]).toEqual({ quotaType: 'plugins', amount: 1 });
  });

  it('counts a LOST metering increment, but not an over-limit 429', async () => {
    jest.resetModules();
    registerMocks();
    const emitter = await import('../src/utils/metric-emitter.js');
    const counts: Array<[string, Record<string, string> | undefined]> = [];
    emitter.setCounterEmitter((name, labels) => { counts.push([name, labels]); });
    const mod = await import('../src/services/quota.js');
    const quotaService = mod.createQuotaService();

    mockPost.mockResolvedValueOnce(httpResponse(429, { success: false, code: 'QUOTA_EXCEEDED' }));
    await quotaService.increment('org1', 'apiCalls', AUTH);
    mockPost.mockResolvedValueOnce(null);
    await quotaService.increment('org1', 'apiCalls', AUTH);
    mockPost.mockResolvedValueOnce(httpResponse(500, {}));
    await quotaService.increment('org1', 'apiCalls', AUTH);
    emitter.resetCounterEmitter();

    expect(counts.filter(([n]) => n === 'quota_increment_failures_total').map(([, l]) => l?.reason)).toEqual(['unreachable', 'non-ok']);
  });

  it('meteredQuotaTypeFor: an org service account spends automationCalls instead of apiCalls', async () => {
    jest.resetModules();
    registerMocks();
    const { meteredQuotaTypeFor } = await import('../src/services/quota.js');
    expect(meteredQuotaTypeFor({ user: { principalType: 'service_account' } } as never, 'apiCalls')).toBe('automationCalls');
    expect(meteredQuotaTypeFor({ user: { principalType: 'user' } } as never, 'apiCalls')).toBe('apiCalls');
    // A personal access key (the exchanged key token, or anything minted while
    // holding one) is automation whoever owns it.
    expect(meteredQuotaTypeFor({ user: { principalType: 'user', token_use: 'api_key' } } as never, 'apiCalls')).toBe('automationCalls');
    expect(meteredQuotaTypeFor({ user: { principalType: 'user', token_use: 'access', parentKeyId: 'k1' } } as never, 'apiCalls')).toBe('automationCalls');
    expect(meteredQuotaTypeFor({ user: { principalType: 'user', token_use: 'access' } } as never, 'apiCalls')).toBe('apiCalls');
    expect(meteredQuotaTypeFor({ user: { principalType: 'service_account' } } as never, 'aiCalls')).toBe('aiCalls');
    expect(meteredQuotaTypeFor({} as never, 'apiCalls')).toBe('apiCalls');
  });

  it('quotaAttributionFromRequest: principal, key, route PATTERN, pipeline and request id', async () => {
    jest.resetModules();
    registerMocks();
    const { quotaAttributionFromRequest } = await import('../src/services/quota.js');
    const req = {
      method: 'POST',
      baseUrl: '/pipelines',
      route: { path: '/:pipelineId/register' },
      params: { pipelineId: 'pipe-9' },
      headers: { 'x-request-id': 'r-1' },
      user: { sub: 'sa-1', principalType: 'service_account', parentKeyId: 'key-1', jti: 'tok' },
    };
    expect(quotaAttributionFromRequest(req as never)).toEqual({
      principalType: 'service_account',
      principalId: 'sa-1',
      keyId: 'key-1',
      route: 'POST /pipelines/:pipelineId/register',
      pipelineId: 'pipe-9',
      requestId: 'r-1',
    });
    // No route matched, header pipeline id, an invalid id dropped, no user.
    expect(quotaAttributionFromRequest({ method: 'GET', headers: { 'x-pipeline-id': ['p-2'] }, params: {} } as never)).toEqual({ pipelineId: 'p-2' });
    expect(quotaAttributionFromRequest({ method: 'GET', headers: { 'x-pipeline-id': 'bad id!' }, params: {} } as never)).toEqual({});
  });
});

describe('quota.decrement', () => {
  it('posts to the decrement endpoint, forwarding a resetAt snapshot when given', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(200, { success: true }));

    await expect(
      quotaService.decrement('org1', 'pipelines', AUTH, 1, '2026-08-01T00:00:00Z'),
    ).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledWith(
      '/quotas/org1/decrement',
      { quotaType: 'pipelines', amount: 1, resetAtSnapshot: '2026-08-01T00:00:00Z' },
      expect.any(Object),
    );
  });

  it('never throws on rollback failure (null response)', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(null);
    await expect(quotaService.decrement('org1', 'pipelines', AUTH)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getTier() — used for build-queue partitioning; fail-open to developer
// ---------------------------------------------------------------------------

describe('quota.getTier', () => {
  it('returns the org tier on a 200 success (happy path)', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quota: { tier: 'pro' } } }));

    const tier: QuotaTier = await quotaService.getTier('org1', AUTH);
    expect(tier).toBe('pro');
  });

  it('falls back to the default (developer) tier for an INVALID tier value', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quota: { tier: 'megacorp' } } }));

    expect(await quotaService.getTier('org1', AUTH)).toBe('developer');
  });

  it('falls back to the default (developer) tier when the tier field is MISSING', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quota: {} } }));

    expect(await quotaService.getTier('org1', AUTH)).toBe('developer');
  });

  it('fails open to the default tier when the service is unreachable (null response)', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(null);

    expect(await quotaService.getTier('org1', AUTH)).toBe('developer');
  });
});

describe('quota.getTierStrict (fail-closed)', () => {
  it('returns the confirmed tier', async () => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(httpResponse(200, { success: true, data: { quota: { tier: 'team' } } }));
    expect(await quotaService.getTierStrict('org1', AUTH)).toBe('team');
  });

  it.each([
    ['unreachable', null],
    ['a 5xx', httpResponse(503, { success: false })],
    ['a non-success body', httpResponse(200, { success: false })],
    ['a missing tier', httpResponse(200, { success: true, data: { quota: {} } })],
    ['an unrecognized tier', httpResponse(200, { success: true, data: { quota: { tier: 'megacorp' } } })],
  ])('returns null — never DEFAULT_TIER — when %s', async (_label, response) => {
    const quotaService = await loadQuotaService();
    mockGet.mockResolvedValue(response);
    expect(await quotaService.getTierStrict('org1', AUTH)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// incrementQuota() — metering helper authenticates as the SERVICE
// ---------------------------------------------------------------------------

describe('incrementQuota (metering helper)', () => {
  it('sends a signed service-principal token scoped to the org, never a user token', async () => {
    process.env.SERVICE_NAME = 'pipeline';
    try {
      jest.resetModules();
      registerMocks();
      const mod = await import('../src/services/quota.js');
      const quotaService = mod.createQuotaService();
      mockPost.mockResolvedValue(httpResponse(200, { success: true }));

      mod.incrementQuota(quotaService, 'org1', 'apiCalls', jest.fn());
      // Buffered: nothing leaves until the pod's batch flushes.
      expect(mockPost).not.toHaveBeenCalled();
      const { flushQuotaIncrements } = await import('../src/services/quota-increment-batcher.js');
      await flushQuotaIncrements();

      expect(mockPost).toHaveBeenCalledTimes(1);
      const [path, body, opts] = mockPost.mock.calls[0] as [string, Record<string, unknown>, { headers: Record<string, string> }];
      expect(path).toBe('/quotas/org1/increment');
      expect(body).toEqual({ quotaType: 'apiCalls', amount: 1, meter: true, groups: [{ amount: 1 }] });
      const auth = opts.headers.Authorization;
      expect(auth).toMatch(/^Bearer /);
      // The token is this service's OWN ES256 mint — never an HMAC token
      // and never a user token. Signature verification against the per-service
      // key bundle is covered in jwt-rotation.test.ts.
      const { default: jwt } = await import('jsonwebtoken');
      const { decodeJwtHeader } = await import('../src/utils/jwk.js');
      expect(decodeJwtHeader(auth.slice(7))?.alg).toBe('ES256');
      expect(decodeJwtHeader(auth.slice(7))?.kid).toBeTruthy();
      const decoded = jwt.decode(auth.slice(7)) as Record<string, unknown>;
      expect(decoded.sub).toBe('service:pipeline');
      expect(decoded.principalType).toBe('service');
      expect(decoded.organizationId).toBe('org1');
      expect(decoded.role).toBe('member');
      expect(decoded.isAdmin).toBe(false);
    } finally {
      delete process.env.SERVICE_NAME;
    }
  });
});

// ---------------------------------------------------------------------------
// sendQuotaReserveDenied() — 503 for an unconfirmed reservation, 429 for over-limit
// ---------------------------------------------------------------------------

describe('sendQuotaReserveDenied', () => {
  function mockRes() {
    const res = {
      headersSent: false,
      headers: {} as Record<string, unknown>,
      statusCode: 0,
      body: undefined as unknown,
      setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
      status(code: number) { this.statusCode = code; return this; },
      json(b: unknown) { this.body = b; return this; },
    };
    return res;
  }

  it('answers 503 SERVICE_UNAVAILABLE when the quota service could not confirm the slot', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(null);
    const mod = await import('../src/services/quota.js');
    const reservation = await quotaService.reserve('org1', 'aiCalls', AUTH);

    const res = mockRes();
    mod.sendQuotaReserveDenied(res as never, 'aiCalls', reservation);

    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).toContain('SERVICE_UNAVAILABLE');
    expect(res.headers['Retry-After']).toBeDefined();
    expect(res.headers['X-Quota-Limit']).toBeUndefined();
  });

  it('answers 429 QUOTA_EXCEEDED for a genuine over-limit', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(429, {
      success: false,
      code: 'QUOTA_EXCEEDED',
      details: { quota: { type: 'aiCalls', limit: 5, used: 5, remaining: 0, resetAt: '2099-01-01T00:00:00Z' } },
    }));
    const mod = await import('../src/services/quota.js');
    const reservation = await quotaService.reserve('org1', 'aiCalls', AUTH);

    const res = mockRes();
    mod.sendQuotaReserveDenied(res as never, 'aiCalls', reservation);

    expect(res.statusCode).toBe(429);
    expect(JSON.stringify(res.body)).toContain('QUOTA_EXCEEDED');
    expect(res.headers['X-Quota-Limit']).toBe(5);
  });

  it.each(['AI_MEMBER_SHARE_EXCEEDED', 'AI_TOKEN_BUDGET_EXCEEDED'])('relays an AI-control refusal (%s) as a 429 with its own code and message', async (code) => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(429, {
      success: false,
      code,
      message: 'Your share is spent.',
      details: { quota: { type: 'aiCalls', limit: 2, used: 2, remaining: 0, resetAt: '2099-01-01T00:00:00Z' } },
    }));
    const mod = await import('../src/services/quota.js');
    const reservation = await quotaService.reserve('org1', 'aiCalls', AUTH);
    // A genuine, final denial — never mistaken for an outage (503).
    expect(reservation).toMatchObject({ exceeded: true, code, message: 'Your share is spent.' });
    expect(reservation.unavailable).toBeUndefined();

    const res = mockRes();
    mod.sendQuotaReserveDenied(res as never, 'aiCalls', reservation);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ code, message: 'Your share is spent.' });
    expect(res.headers['Retry-After']).toBeDefined();
  });
});

describe('quota.reportUsage (after-the-call AI usage report)', () => {
  it('posts a report-shaped increment with the token counts and attribution', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(httpResponse(200, { success: true }));
    await quotaService.reportUsage!('org1', 'aiCalls', AUTH, { tokensIn: 120.7, tokensOut: 30 }, { feature: 'ask', model: 'm', keySource: 'org' });
    expect(mockPost).toHaveBeenCalledWith(
      '/quotas/org1/increment',
      { quotaType: 'aiCalls', report: true, tokensIn: 120, tokensOut: 30, attribution: { feature: 'ask', model: 'm', keySource: 'org' } },
      expect.any(Object),
    );
  });

  it('never throws — an unreachable quota service is only counted', async () => {
    const quotaService = await loadQuotaService();
    mockPost.mockResolvedValue(null);
    await expect(quotaService.reportUsage!('org1', 'aiCalls', AUTH, { tokensIn: 1, tokensOut: 1 }, { feature: 'ask' })).resolves.toBeUndefined();
    mockPost.mockRejectedValue(new Error('boom'));
    await expect(quotaService.reportUsage!('org1', 'aiCalls', AUTH, { tokensIn: 1, tokensOut: 1 }, { feature: 'ask' })).resolves.toBeUndefined();
  });

  it('sends nothing when there are no tokens and no attribution', async () => {
    const quotaService = await loadQuotaService();
    await quotaService.reportUsage!('org1', 'aiCalls', AUTH, { tokensIn: 0, tokensOut: 0 });
    expect(mockPost).not.toHaveBeenCalled();
  });
});
