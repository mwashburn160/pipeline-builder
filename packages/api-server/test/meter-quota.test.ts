// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for meterQuotaOnSuccess — the finish-based quota METERING middleware
 * that complements checkQuota (which only gates). Verifies it increments once
 * per 2xx response, and skips non-2xx, unauthenticated, and service-principal
 * requests. Always calls next() and never throws.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIncrementQuota = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  incrementQuota: mockIncrementQuota,
  isServicePrincipal: (req: { user?: { principalType?: string } }) => req?.user?.principalType === 'service',
}));

const { meterQuotaOnSuccess } = await import('../src/api/meter-quota.js');

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

  it('meters 201/204 (any 2xx), not just 200', () => {
    for (const code of [201, 204]) {
      jest.clearAllMocks();
      const res = mockRes(code);
      meterQuotaOnSuccess(quotaService, 'apiCalls')(mockReq(), res as never, jest.fn<AnyFn>());
      res.finish();
      expect(mockIncrementQuota).toHaveBeenCalledTimes(1);
    }
  });
});
