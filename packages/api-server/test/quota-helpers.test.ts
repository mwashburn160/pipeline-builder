// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIncrementQuota = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  incrementQuota: mockIncrementQuota,
}));

const { incrementQuotaFromCtx } = await import('../src/api/quota-helpers.js');

function mockReq(authHeader?: string): any {
  return { headers: authHeader !== undefined ? { authorization: authHeader } : {} };
}

function mockCtx(): any {
  return { log: jest.fn() };
}

describe('incrementQuotaFromCtx', () => {
  beforeEach(() => {
    mockIncrementQuota.mockReset();
  });

  it('meters via incrementQuota WITHOUT forwarding the user authorization header', () => {
    const req = mockReq('Bearer abc');
    const ctx = mockCtx();
    incrementQuotaFromCtx({} as any, { req, ctx, orgId: 'org-1' }, 'apiCalls' as any);
    expect(mockIncrementQuota).toHaveBeenCalledWith(
      {},
      'org-1',
      'apiCalls',
      expect.any(Function),
    );
    expect(mockIncrementQuota.mock.calls[0]).not.toContain('Bearer abc');
  });

  it('binds the log function as a WARN-level logger', () => {
    const req = mockReq('tok');
    const ctx = mockCtx();
    incrementQuotaFromCtx({} as any, { req, ctx, orgId: 'org-3' }, 'plugins' as any);
    const boundLogger = mockIncrementQuota.mock.calls[0][3] as (m: string, d: unknown) => void;
    boundLogger('quota close to limit', { used: 99 });
    expect(ctx.log).toHaveBeenCalledWith('WARN', 'quota close to limit', { used: 99 });
  });
});
