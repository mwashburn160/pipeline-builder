// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Mock api-core before imports
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getIdentity: jest.fn(() => ({ orgId: 'fallback-org' })),
  sendError: jest.fn(),
  sendQuotaExceeded: jest.fn(),
}));

const { sendError, sendQuotaExceeded, getIdentity } = await import('@pipeline-builder/api-core');
const { checkQuota } = await import('../src/api/check-quota.js');

function mockReq(overrides: Record<string, unknown> = {}): any {
  return {
    headers: { authorization: 'Bearer tok' },
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

    expect(mockQuotaService.check).toHaveBeenCalledWith('org-1', 'apiCalls', 'Bearer tok');
    expect(next).toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
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

    // The 429 now routes through the shared sendQuotaExceeded (Retry-After +
    // X-Quota-* headers), keeping the custom "contact your administrator" copy.
    expect(sendQuotaExceeded).toHaveBeenCalledWith(
      res,
      'pipelines',
      { type: 'pipelines', limit: 100, used: 100, remaining: 0 },
      undefined,
      expect.stringContaining('Pipeline quota exceeded'),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when orgId is missing from context', async () => {
    const middleware = checkQuota(mockQuotaService, 'apiCalls');
    const req = mockReq({
      context: {
        identity: { orgId: undefined, userId: 'user-1' },
        log: jest.fn(),
      },
    });
    // Also mock getIdentity to return no orgId for fallback
    (getIdentity as jest.Mock).mockReturnValue({ orgId: undefined });
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(sendError).toHaveBeenCalledWith(
      res,
      400,
      'Organization ID is required for quota check',
      'VALIDATION_ERROR',
    );
    expect(next).not.toHaveBeenCalled();
    expect(mockQuotaService.check).not.toHaveBeenCalled();
  });

  it('throws when context middleware is missing', async () => {
    const middleware = checkQuota(mockQuotaService, 'apiCalls');
    const req = mockReq({ context: undefined });
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    // Should fail open (next called) but log the error — getContext throws,
    // which is caught by the fail-open catch block
    expect(next).toHaveBeenCalled();
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

  it('uses correct quota labels for each type', async () => {
    mockQuotaService.check.mockResolvedValue({
      allowed: false,
      limit: 10,
      used: 10,
      remaining: 0,
    });
    const res = mockRes();
    const next = jest.fn();

    // Test 'plugins' label
    await checkQuota(mockQuotaService, 'plugins')(mockReq(), res, next);
    expect(sendQuotaExceeded).toHaveBeenCalledWith(
      res,
      'plugins',
      expect.anything(),
      undefined,
      expect.stringContaining('Plugin quota exceeded'),
    );

    jest.clearAllMocks();

    // Test 'apiCalls' label
    await checkQuota(mockQuotaService, 'apiCalls')(mockReq(), mockRes(), jest.fn());
    expect(sendQuotaExceeded).toHaveBeenCalledWith(
      expect.anything(),
      'apiCalls',
      expect.anything(),
      undefined,
      expect.stringContaining('API call quota exceeded'),
    );
  });
});
