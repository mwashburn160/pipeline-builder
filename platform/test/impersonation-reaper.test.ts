// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { leaderLockMock } from './helpers/leader-lock-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUpdateMany = jest.fn<(...a: unknown[]) => Promise<{ modifiedCount?: number }>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/models/index.js', () => ({
  ImpersonationRequest: { updateMany: (...a: unknown[]) => mockUpdateMany(...a) },
}));
jest.unstable_mockModule('../src/utils/leader-lock.js', () => leaderLockMock());

const { sweepExpiredImpersonationRequests } = await import('../src/services/impersonation-reaper.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });
});

describe('sweepExpiredImpersonationRequests', () => {
  it('expires lapsed PENDING and APPROVED requests', async () => {
    const now = new Date('2026-09-16T12:00:00Z');
    await expect(sweepExpiredImpersonationRequests(now)).resolves.toBe(3);

    const [filter, update] = mockUpdateMany.mock.calls[0] as [any, any];
    expect(filter.status.$in).toEqual(['pending', 'approved']);
    expect(filter.expiresAt).toEqual({ $lte: now });
    expect(update).toEqual({ $set: { status: 'expired' } });
  });

  it('never touches final statuses — a consumed request\'s expiresAt is about approval, not the session', async () => {
    await sweepExpiredImpersonationRequests();
    const filter = mockUpdateMany.mock.calls[0]![0] as any;
    for (const s of ['consumed', 'denied', 'revoked', 'undeliverable', 'expired']) {
      expect(filter.status.$in).not.toContain(s);
    }
  });

  it('marks rows in place — it never deletes the record of who asked', async () => {
    await sweepExpiredImpersonationRequests();
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('never throws on a database error', async () => {
    mockUpdateMany.mockRejectedValue(new Error('mongo down'));
    await expect(sweepExpiredImpersonationRequests()).resolves.toBe(0);
  });
});
