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
const { checkQuota, deferredCheckQuota } = await import('../src/api/check-quota.js');

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

describe('deferredCheckQuota', () => {
  const mockQuotaService = { check: jest.fn(), increment: jest.fn(), getUsage: jest.fn() } as any;
  beforeEach(() => { jest.clearAllMocks(); });

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
