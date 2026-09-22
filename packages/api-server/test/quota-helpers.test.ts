// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIncrementQuota = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  incrementQuota: mockIncrementQuota,
}));

const { incrementQuotaFromCtx } = await import('../src/api/quota-helpers.js');

function mockCtx(): any {
  return { log: jest.fn() };
}

describe('incrementQuotaFromCtx', () => {
  beforeEach(() => {
    mockIncrementQuota.mockReset();
  });

  it('meters the org through incrementQuota (which authenticates as the service, never the user)', () => {
    const ctx = mockCtx();
    incrementQuotaFromCtx({} as any, { ctx, orgId: 'org-1' }, 'apiCalls' as any);
    expect(mockIncrementQuota).toHaveBeenCalledWith(
      {},
      'org-1',
      'apiCalls',
      expect.any(Function),
    );
  });

  it('binds the log function as a WARN-level logger', () => {
    const ctx = mockCtx();
    incrementQuotaFromCtx({} as any, { ctx, orgId: 'org-3' }, 'plugins' as any);
    const boundLogger = mockIncrementQuota.mock.calls[0][3] as (m: string, d: unknown) => void;
    boundLogger('quota close to limit', { used: 99 });
    expect(ctx.log).toHaveBeenCalledWith('WARN', 'quota close to limit', { used: 99 });
  });
});
