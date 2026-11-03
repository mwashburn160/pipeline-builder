// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mock api-core before imports
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: jest.fn(),
  sendQuotaExceeded: jest.fn(),
  getQuotaServiceAuthHeader: (orgId: string) => `Bearer service-token-for-${orgId}`,
}));

const { sendError, sendQuotaExceeded, runDeferredQuotaCheck } = await import('@pipeline-builder/api-core');
const { checkQuota, deferredCheckQuota, clearQuotaCheckCache } = await import('../src/api/check-quota.js');
const { setIdempotencyStore, createMemoryStore } = await import('../src/api/idempotency-middleware.js');

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    headers: { authorization: 'Bearer tok' },
    user: { sub: 'user-1', organizationId: 'org-1' },
    context: {
      identity: { orgId: 'org-1', userId: 'user-1' },
      log: jest.fn(),
    },
    ...overrides,
  };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('checkQuota', () => {
  const mockQuotaService = {
    check: jest.fn(),
    increment: jest.fn(),
    getUsage: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    clearQuotaCheckCache();
  });

  it('calls next() when quota is allowed', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: true });
    const middleware = checkQuota(mockQuotaService, 'apiCalls');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    // Authenticates as the SERVICE (never forwards the user's bearer token).
    expect(mockQuotaService.check).toHaveBeenCalledWith('org-1', 'apiCalls', 'Bearer service-token-for-org-1');
    expect(next).toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });

  it('skips the check (fails open) for an unauthenticated request — never mints service creds for a header-derived org', async () => {
    const middleware = checkQuota(mockQuotaService, 'apiCalls');
    const req = mockReq({ user: undefined, context: { identity: { orgId: 'victim-org' }, log: jest.fn() } });
    const next = jest.fn();

    await middleware(req, mockRes(), next);

    expect(mockQuotaService.check).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('returns 429 when quota is exceeded', async () => {
    mockQuotaService.check.mockResolvedValue({
      allowed: false,
      limit: 100,
      used: 100,
      remaining: 0,
    });
    const middleware = checkQuota(mockQuotaService, 'pipelines');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    // The 429 routes through the shared sendQuotaExceeded with NO custom copy:
    // its default body names the quota, the reset date and the upgrade page.
    expect(sendQuotaExceeded).toHaveBeenCalledWith(
      res,
      'pipelines',
      { type: 'pipelines', limit: 100, used: 100, remaining: 0 },
      undefined,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through (no 400, no check) when the caller has no org — requireOrgId is the gate', async () => {
    const middleware = checkQuota(mockQuotaService, 'apiCalls');
    const req = mockReq({
      user: { sub: 'user-1' },
      context: { identity: { orgId: undefined, userId: 'user-1' }, log: jest.fn() },
    });
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(sendError).not.toHaveBeenCalled();
    expect(mockQuotaService.check).not.toHaveBeenCalled();
  });

  it('falls back to the verified auth org when no request context is attached (platform)', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: true });
    const middleware = checkQuota(mockQuotaService, 'apiCalls');
    const req = mockReq({ context: undefined });
    const next = jest.fn();

    await middleware(req, mockRes(), next);

    expect(mockQuotaService.check).toHaveBeenCalledWith('org-1', 'apiCalls', 'Bearer service-token-for-org-1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('never checks a service principal — peer traffic is never metered, so it is never refused', async () => {
    const next = jest.fn();
    await checkQuota(mockQuotaService, 'apiCalls')(mockReq({ user: { sub: 'service:plugin', principalType: 'service', organizationId: 'org-1' } }), mockRes(), next);
    expect(mockQuotaService.check).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('never checks a console-polling exempt route for apiCalls, but still checks other types there', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: true });
    const exempt = { method: 'GET', originalUrl: '/messages/unread/count?x=1' };
    const next = jest.fn();
    await checkQuota(mockQuotaService, 'apiCalls')(mockReq(exempt), mockRes(), next);
    expect(mockQuotaService.check).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);

    await checkQuota(mockQuotaService, 'aiCalls')(mockReq(exempt), mockRes(), jest.fn());
    expect(mockQuotaService.check).toHaveBeenCalledWith('org-1', 'aiCalls', expect.any(String));
  });

  it('runs next() exactly once even when a downstream handler throws synchronously', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: true });
    const next = jest.fn(() => { throw new Error('downstream'); });
    await expect(checkQuota(mockQuotaService, 'apiCalls')(mockReq(), mockRes(), next)).rejects.toThrow('downstream');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('is tagged as an apiCalls check gate for the route table', async () => {
    const { getRouteGates } = await import('@pipeline-builder/api-core');
    expect(getRouteGates(checkQuota(mockQuotaService, 'apiCalls'))).toEqual([{ kind: 'quota', mode: 'check', quotaType: 'apiCalls' }]);
  });

  it('fails open when quota service throws', async () => {
    mockQuotaService.check.mockRejectedValue(new Error('Service down'));
    const middleware = checkQuota(mockQuotaService, 'apiCalls');
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });

  it('checks an ORG SERVICE ACCOUNT against automationCalls, never apiCalls', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: false, limit: 10, used: 10, remaining: 0 });
    const res = mockRes();
    const req = mockReq({ user: { sub: 'sa-1', organizationId: 'org-1', principalType: 'service_account' } });

    await checkQuota(mockQuotaService, 'apiCalls')(req, res, jest.fn());

    expect(mockQuotaService.check).toHaveBeenCalledWith('org-1', 'automationCalls', 'Bearer service-token-for-org-1');
    expect(sendQuotaExceeded).toHaveBeenCalledWith(res, 'automationCalls', expect.objectContaining({ type: 'automationCalls' }), undefined);
  });

  it('a person keeps apiCalls, and non-apiCalls types never switch', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: true });
    await checkQuota(mockQuotaService, 'apiCalls')(mockReq(), mockRes(), jest.fn());
    const sa = mockReq({ user: { sub: 'sa-1', organizationId: 'org-1', principalType: 'service_account' } });
    await checkQuota(mockQuotaService, 'aiCalls')(sa, mockRes(), jest.fn());
    expect(mockQuotaService.check.mock.calls.map((c: unknown[]) => c[1])).toEqual(['apiCalls', 'aiCalls']);
  });
});

describe('checkQuota exemptions', () => {
  const mockQuotaService = { check: jest.fn(), increment: jest.fn() } as any;
  beforeEach(() => { jest.clearAllMocks(); clearQuotaCheckCache(); });

  it('never checks an impersonation session on apiCalls (but does on other types)', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: true, limit: 10, used: 0, remaining: 10 });
    const imp = mockReq({ user: { sub: 'user-1', organizationId: 'org-1', impersonatorId: 'admin-1' } });
    const next = jest.fn();
    await checkQuota(mockQuotaService, 'apiCalls')(imp, mockRes(), next);
    expect(mockQuotaService.check).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    await checkQuota(mockQuotaService, 'aiCalls')(imp, mockRes(), jest.fn());
    expect(mockQuotaService.check).toHaveBeenCalledWith('org-1', 'aiCalls', expect.any(String));
  });

  it('still checks a request whose on-behalf header a USER forged', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: false, limit: 10, used: 10, remaining: 0, resetAt: new Date(Date.now() + 3_600_000).toISOString() });
    const forged = mockReq({ headers: { 'authorization': 'Bearer tok', 'x-pb-on-behalf': 'eyJhbGciOiJub25lIn0.e30.' } });
    const next = jest.fn();
    await checkQuota(mockQuotaService, 'apiCalls')(forged, mockRes(), next);
    expect(mockQuotaService.check).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(sendQuotaExceeded).toHaveBeenCalledTimes(1);
  });

  it('skips the gate for a retry of a COMPLETED idempotent mutation (it will be replayed, not run)', async () => {
    const store = createMemoryStore();
    setIdempotencyStore(store);
    mockQuotaService.check.mockResolvedValue({ allowed: false, limit: 10, used: 10, remaining: 0, resetAt: new Date(Date.now() + 3_600_000).toISOString() });
    const req = mockReq({ method: 'POST', baseUrl: '/pipelines', route: { path: '/' }, body: { a: 1 }, headers: { 'authorization': 'Bearer tok', 'idempotency-key': 'k1' } });
    // No original on record yet: the gate runs (and refuses).
    const blocked = jest.fn();
    await checkQuota(mockQuotaService, 'apiCalls')(req, mockRes(), blocked);
    expect(blocked).not.toHaveBeenCalled();

    // Record the real original through the middleware's own key derivation.
    const { idempotencyMiddleware } = await import('../src/api/idempotency-middleware.js');
    const res: any = { statusCode: 201, locals: {}, setHeader: jest.fn(), on: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await new Promise<void>((resolve) => idempotencyMiddleware()({ ...req }, res, () => resolve()));
    res.json({ ok: true }); // the original completes with a 2xx → cached for replay
    await new Promise((r) => setImmediate(r));

    clearQuotaCheckCache();
    mockQuotaService.check.mockClear();
    const retried = jest.fn();
    await checkQuota(mockQuotaService, 'apiCalls')({ ...req }, mockRes(), retried);
    expect(retried).toHaveBeenCalledTimes(1);
    expect(mockQuotaService.check).not.toHaveBeenCalled();
  });
});

describe('checkQuota per-pod cache', () => {
  const mockQuotaService = { check: jest.fn(), increment: jest.fn() } as any;
  beforeEach(() => { jest.clearAllMocks(); clearQuotaCheckCache(); });
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

  it('reuses an ALLOWED reading for the same org and type', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: true, limit: 1000, used: 10, remaining: 990, resetAt: inAnHour() });
    for (let i = 0; i < 5; i++) await checkQuota(mockQuotaService, 'apiCalls')(mockReq(), mockRes(), jest.fn());
    expect(mockQuotaService.check).toHaveBeenCalledTimes(1);
    // A different type or org is its own reading.
    await checkQuota(mockQuotaService, 'aiCalls')(mockReq(), mockRes(), jest.fn());
    await checkQuota(mockQuotaService, 'apiCalls')(mockReq({ user: { sub: 'u', organizationId: 'org-2' }, context: undefined }), mockRes(), jest.fn());
    expect(mockQuotaService.check).toHaveBeenCalledTimes(3);
  });

  it('re-asks once this pod has passed as many requests as the reading had headroom for', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: true, limit: 100, used: 98, remaining: 2, resetAt: inAnHour() });
    for (let i = 0; i < 3; i++) await checkQuota(mockQuotaService, 'apiCalls')(mockReq(), mockRes(), jest.fn());
    // 2 passes used the first reading's headroom; the 3rd re-reads.
    expect(mockQuotaService.check).toHaveBeenCalledTimes(2);
  });

  it('reuses a DENIED reading (no read per refused request), but never past the reset', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: false, limit: 10, used: 10, remaining: 0, resetAt: inAnHour() });
    for (let i = 0; i < 4; i++) await checkQuota(mockQuotaService, 'apiCalls')(mockReq(), mockRes(), jest.fn());
    expect(mockQuotaService.check).toHaveBeenCalledTimes(1);
    expect(sendQuotaExceeded).toHaveBeenCalledTimes(4);

    clearQuotaCheckCache();
    mockQuotaService.check.mockClear();
    mockQuotaService.check.mockResolvedValue({ allowed: false, limit: 10, used: 10, remaining: 0, resetAt: new Date(Date.now() - 1).toISOString() });
    for (let i = 0; i < 2; i++) await checkQuota(mockQuotaService, 'apiCalls')(mockReq(), mockRes(), jest.fn());
    expect(mockQuotaService.check).toHaveBeenCalledTimes(2);
  });

  it('never caches a fail-open sentinel — recovery is seen on the next request', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: true, limit: -1, used: 0, remaining: -1, resetAt: inAnHour(), unlimited: true, failOpen: true });
    for (let i = 0; i < 3; i++) await checkQuota(mockQuotaService, 'apiCalls')(mockReq(), mockRes(), jest.fn());
    expect(mockQuotaService.check).toHaveBeenCalledTimes(3);
  });

  it('shares ONE read between concurrent misses', async () => {
    let resolve!: (v: unknown) => void;
    mockQuotaService.check.mockReturnValue(new Promise((r) => { resolve = r; }));
    const nexts = Array.from({ length: 10 }, () => jest.fn());
    const runs = nexts.map((n) => checkQuota(mockQuotaService, 'apiCalls')(mockReq(), mockRes(), n));
    resolve({ allowed: true, limit: 1000, used: 0, remaining: 1000, resetAt: inAnHour() });
    await Promise.all(runs);
    expect(mockQuotaService.check).toHaveBeenCalledTimes(1);
    expect(nexts.every((n) => n.mock.calls.length === 1)).toBe(true);
  });

  it('honours the automationCalls soft band as headroom', async () => {
    // limit 100, used 100: nominally full, but the 10% band leaves 10 more.
    mockQuotaService.check.mockResolvedValue({ allowed: true, limit: 100, used: 100, remaining: 0, resetAt: inAnHour() });
    const sa = () => mockReq({ user: { sub: 'sa', organizationId: 'org-1', principalType: 'service_account' } });
    for (let i = 0; i < 10; i++) await checkQuota(mockQuotaService, 'apiCalls')(sa(), mockRes(), jest.fn());
    expect(mockQuotaService.check).toHaveBeenCalledTimes(1);
  });
});

describe('deferredCheckQuota', () => {
  const mockQuotaService = { check: jest.fn(), increment: jest.fn(), getUsage: jest.fn() } as any;
  beforeEach(() => { jest.clearAllMocks(); clearQuotaCheckCache(); });

  it('arms the check at mount time and runs it once, when requireAuth hands over', async () => {
    mockQuotaService.check.mockResolvedValue({ allowed: false, limit: 5, used: 5, remaining: 0 });
    const res: any = { locals: {} };
    const mountNext = jest.fn();
    deferredCheckQuota(mockQuotaService, 'apiCalls')(mockReq(), res, mountNext);
    // Arming checks nothing — there is no verified caller yet.
    expect(mountNext).toHaveBeenCalledTimes(1);
    expect(mockQuotaService.check).not.toHaveBeenCalled();

    // requireAuth's hand-over runs it; a second requireAuth finds the slot empty.
    const authNext = jest.fn();
    runDeferredQuotaCheck(mockReq(), res, authNext);
    await new Promise((r) => setImmediate(r));
    expect(mockQuotaService.check).toHaveBeenCalledTimes(1);
    expect(sendQuotaExceeded).toHaveBeenCalledTimes(1);
    expect(authNext).not.toHaveBeenCalled();

    const again = jest.fn();
    runDeferredQuotaCheck(mockReq(), res, again);
    expect(again).toHaveBeenCalledTimes(1);
    expect(mockQuotaService.check).toHaveBeenCalledTimes(1);
  });

  it('is tagged as the check gate, so a prefix mount shows on every route under it', async () => {
    const { getRouteGates } = await import('@pipeline-builder/api-core');
    expect(getRouteGates(deferredCheckQuota(mockQuotaService, 'apiCalls'))).toEqual([{ kind: 'quota', mode: 'check', quotaType: 'apiCalls' }]);
  });
});
