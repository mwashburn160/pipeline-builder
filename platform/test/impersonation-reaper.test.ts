// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { leaderLockMock } from './helpers/leader-lock-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUpdateMany = jest.fn<(...a: unknown[]) => Promise<{ modifiedCount?: number }>>();
const mockFind = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();
const mockRecordAuditEvent = jest.fn();

/** `find(filter).select().limit().lean()` resolving to `mockFind(filter)`. */
function findChain(filter: unknown) {
  const chain = { select: () => chain, limit: () => chain, lean: () => mockFind(filter) };
  return chain;
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ recordAuditEvent: (...a: unknown[]) => mockRecordAuditEvent(...a) }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  ImpersonationRequest: {
    find: (filter: unknown) => findChain(filter),
    updateMany: (...a: unknown[]) => mockUpdateMany(...a),
  },
}));
jest.unstable_mockModule('../src/utils/leader-lock.js', () => leaderLockMock());

const { sweepExpiredImpersonationRequests } = await import('../src/services/impersonation-reaper.js');

const LAPSED = ['r1', 'r2', 'r3'].map((id) => ({
  _id: id, status: 'pending', requesterId: 'op-1', targetUserId: `u-${id}`, organizationId: 'org-1',
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockFind.mockResolvedValue(LAPSED);
  mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });
});

describe('sweepExpiredImpersonationRequests', () => {
  it('expires lapsed PENDING and APPROVED requests', async () => {
    const now = new Date('2026-09-16T12:00:00Z');
    await expect(sweepExpiredImpersonationRequests(now)).resolves.toBe(3);

    const [filter, update] = mockUpdateMany.mock.calls[0] as [any, any];
    expect(filter.status.$in).toEqual(['pending', 'approved']);
    expect(filter.expiresAt).toEqual({ $lte: now });
    expect(filter._id).toEqual({ $in: ['r1', 'r2', 'r3'] });
    expect(update).toEqual({ $set: { status: 'expired' } });
  });

  it('audits each expiry by id against the org the request was for (system actor)', async () => {
    await sweepExpiredImpersonationRequests();
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(3);
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin.impersonate.expire',
      actorId: 'system',
      affectedOrgId: 'org-1',
      targetId: 'u-r1',
      details: expect.objectContaining({ impersonationRequestId: 'r1', previousStatus: 'pending' }),
    }));
  });

  it('does nothing — no write, no audit — when nothing has lapsed', async () => {
    mockFind.mockResolvedValue([]);
    await expect(sweepExpiredImpersonationRequests()).resolves.toBe(0);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  it('never touches final statuses — a consumed request\'s expiresAt is about approval, not the session', async () => {
    await sweepExpiredImpersonationRequests();
    const filter = mockFind.mock.calls[0]![0] as any;
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
