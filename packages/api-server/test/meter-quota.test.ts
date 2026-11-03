// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for meterQuotaOnSuccess — the finish-based quota METERING middleware
 * that complements checkQuota (which only gates). Verifies it increments once
 * per 2xx response, and skips non-2xx, unauthenticated, and service-principal
 * requests. Always calls next() and never throws.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIncrementQuota = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  incrementQuota: mockIncrementQuota,
  isServicePrincipal: (req: { user?: { principalType?: string } }) => req?.user?.principalType === 'service',
}));

const { apiCallsQuota, meterQuotaOnSuccess } = await import('../src/api/meter-quota.js');
const { getRouteGates } = await import('@pipeline-builder/api-core');

const quotaService = { check: jest.fn<AnyFn>(), increment: jest.fn<AnyFn>(), getUsage: jest.fn<AnyFn>() } as never;

interface MockRes {
  statusCode: number;
  on: (evt: string, cb: () => void) => void;
  finish: () => void;
}

function mockReq(overrides: Record<string, unknown> = {}): never {
  return {
    headers: { authorization: 'Bearer tok' },
    user: { organizationId: 'org-1', sub: 'user-1' },
    ...overrides,
  } as never;
}

/** res double that records the `finish` handler so the test can fire it. */
function mockRes(statusCode = 200): MockRes {
  let finishCb: (() => void) | null = null;
  return {
    statusCode,
    on(evt: string, cb: () => void) { if (evt === 'finish') finishCb = cb; },
    finish() { finishCb?.(); },
  };
}

describe('meterQuotaOnSuccess', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('increments apiCalls once on a 2xx response for a user request', () => {
    const req = mockReq();
    const res = mockRes(200);
    const next = jest.fn<AnyFn>();

    meterQuotaOnSuccess(quotaService, 'apiCalls')(req, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    // Nothing metered until the response finishes.
    expect(mockIncrementQuota).not.toHaveBeenCalled();

    res.finish();
    expect(mockIncrementQuota).toHaveBeenCalledTimes(1);
    // No auth header argument: incrementQuota authenticates as the SERVICE — the
    // caller's user token ('Bearer tok') must never be forwarded (it 403s).
    expect(mockIncrementQuota).toHaveBeenCalledWith(
      quotaService, 'org-1', 'apiCalls', expect.any(Function),
      // Usage-ledger attribution, read off the VERIFIED request.
      expect.objectContaining({ principalId: 'user-1' }),
    );
    expect(mockIncrementQuota.mock.calls[0]).not.toContain('Bearer tok');
  });

  it('does NOT meter a non-2xx response', () => {
    const res = mockRes(429);
    meterQuotaOnSuccess(quotaService, 'apiCalls')(mockReq(), res as never, jest.fn<AnyFn>());
    res.finish();
    expect(mockIncrementQuota).not.toHaveBeenCalled();
  });

  it('does NOT meter when there is no verified org (unauthenticated)', () => {
    const res = mockRes(200);
    meterQuotaOnSuccess(quotaService, 'apiCalls')(mockReq({ user: undefined }), res as never, jest.fn<AnyFn>());
    res.finish();
    expect(mockIncrementQuota).not.toHaveBeenCalled();
  });

  it('does NOT meter an unverified request even when context carries a header-derived org', () => {
    const res = mockRes(200);
    const req = mockReq({ user: undefined, context: { identity: { orgId: 'victim-org' } } });
    meterQuotaOnSuccess(quotaService, 'apiCalls')(req, res as never, jest.fn<AnyFn>());
    res.finish();
    expect(mockIncrementQuota).not.toHaveBeenCalled();
  });

  it('does NOT meter a service-principal (internal S2S) request', () => {
    const res = mockRes(200);
    const req = mockReq({ user: { organizationId: 'org-1', sub: 'service:plugin', principalType: 'service' } });
    meterQuotaOnSuccess(quotaService, 'apiCalls')(req, res as never, jest.fn<AnyFn>());
    res.finish();
    expect(mockIncrementQuota).not.toHaveBeenCalled();
  });

  it('does NOT meter an impersonation session on apiCalls', () => {
    const res = mockRes(200);
    const req = mockReq({ user: { organizationId: 'org-1', sub: 'user-1', impersonatorId: 'admin-1' } });
    meterQuotaOnSuccess(quotaService, 'apiCalls')(req, res as never, jest.fn<AnyFn>());
    res.finish();
    expect(mockIncrementQuota).not.toHaveBeenCalled();
  });

  it('does NOT meter an on-behalf hop signed by ask for this user, but DOES meter a forged one', async () => {
    const { onBehalfHeaders } = await import('@pipeline-builder/api-core');
    const prev = process.env.SERVICE_NAME;
    process.env.SERVICE_NAME = 'ask';
    let marker: string | undefined;
    try {
      marker = onBehalfHeaders({ sub: 'user-1', organizationId: 'org-1' })['x-pb-on-behalf'];
    } finally {
      if (prev === undefined) delete process.env.SERVICE_NAME; else process.env.SERVICE_NAME = prev;
    }
    expect(marker).toBeTruthy();
    const signed = mockRes(200);
    meterQuotaOnSuccess(quotaService, 'apiCalls')(mockReq({ headers: { 'authorization': 'Bearer tok', 'x-pb-on-behalf': marker } }), signed as never, jest.fn<AnyFn>());
    signed.finish();
    expect(mockIncrementQuota).not.toHaveBeenCalled();

    const forged = mockRes(200);
    meterQuotaOnSuccess(quotaService, 'apiCalls')(mockReq({ headers: { 'authorization': 'Bearer tok', 'x-pb-on-behalf': 'forged.by.user' } }), forged as never, jest.fn<AnyFn>());
    forged.finish();
    expect(mockIncrementQuota).toHaveBeenCalledTimes(1);
  });

  it('meters a personal access key on automationCalls', () => {
    const res = mockRes(200);
    const req = mockReq({ user: { organizationId: 'org-1', sub: 'user-1', principalType: 'user', token_use: 'api_key' } });
    meterQuotaOnSuccess(quotaService, 'apiCalls')(req, res as never, jest.fn<AnyFn>());
    res.finish();
    expect(mockIncrementQuota).toHaveBeenCalledWith(quotaService, 'org-1', 'automationCalls', expect.any(Function), expect.any(Object));
  });

  it('meters 201/204 (any 2xx), not just 200', () => {
    for (const code of [201, 204]) {
      jest.clearAllMocks();
      const res = mockRes(code);
      meterQuotaOnSuccess(quotaService, 'apiCalls')(mockReq(), res as never, jest.fn<AnyFn>());
      res.finish();
      expect(mockIncrementQuota).toHaveBeenCalledTimes(1);
    }
  });

  it('meters an ORG SERVICE ACCOUNT on automationCalls, not apiCalls', () => {
    const res = mockRes(200);
    const req = mockReq({ user: { organizationId: 'org-1', sub: 'sa-1', principalType: 'service_account', parentKeyId: 'key-9' } });
    meterQuotaOnSuccess(quotaService, 'apiCalls')(req, res as never, jest.fn<AnyFn>());
    res.finish();
    expect(mockIncrementQuota).toHaveBeenCalledWith(
      quotaService, 'org-1', 'automationCalls', expect.any(Function),
      expect.objectContaining({ principalType: 'service_account', principalId: 'sa-1', keyId: 'key-9' }),
    );
  });

  it('attributes the matched route PATTERN and the pipeline, never the raw URL', () => {
    const res = mockRes(200);
    const req = mockReq({
      method: 'GET',
      baseUrl: '/plugins',
      route: { path: '/:name' },
      params: { name: 'secret-name' },
      headers: { 'authorization': 'Bearer tok', 'x-pipeline-id': 'pipe-1', 'x-request-id': 'req-1' },
    });
    meterQuotaOnSuccess(quotaService, 'apiCalls')(req, res as never, jest.fn<AnyFn>());
    res.finish();
    const attribution = mockIncrementQuota.mock.calls[0][4] as Record<string, string>;
    expect(attribution).toMatchObject({ route: 'GET /plugins/:name', pipelineId: 'pipe-1', requestId: 'req-1' });
    expect(JSON.stringify(attribution)).not.toContain('secret-name');
  });

  it('does NOT meter a response replayed from the idempotency cache', () => {
    const res = { ...mockRes(200), locals: { idempotentReplay: true } };
    meterQuotaOnSuccess(quotaService, 'apiCalls')(mockReq(), res as never, jest.fn<AnyFn>());
    res.finish();
    expect(mockIncrementQuota).not.toHaveBeenCalled();
  });

  it('skips a console-polling exempt route for apiCalls (but meters other types there)', () => {
    const exempt = { method: 'GET', originalUrl: '/user/profile' };
    const res = mockRes(200);
    meterQuotaOnSuccess(quotaService, 'apiCalls')(mockReq(exempt), res as never, jest.fn<AnyFn>());
    res.finish();
    expect(mockIncrementQuota).not.toHaveBeenCalled();

    const res2 = mockRes(200);
    meterQuotaOnSuccess(quotaService, 'aiCalls')(mockReq(exempt), res2 as never, jest.fn<AnyFn>());
    res2.finish();
    expect(mockIncrementQuota).toHaveBeenCalledTimes(1);
  });

  it('is tagged as a meter gate, and apiCallsQuota pairs the meter with the deferred check', () => {
    expect(getRouteGates(meterQuotaOnSuccess(quotaService, 'apiCalls'))).toEqual([{ kind: 'quota', mode: 'meter', quotaType: 'apiCalls' }]);
    expect(apiCallsQuota(quotaService).flatMap((fn) => getRouteGates(fn))).toEqual([
      { kind: 'quota', mode: 'meter', quotaType: 'apiCalls' },
      { kind: 'quota', mode: 'check', quotaType: 'apiCalls' },
    ]);
  });
});
