// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the invitation reaper — the durable sweep that flips stale
 * `pending` invitations (past their `expiresAt`) to `expired` in place, WITHOUT
 * deleting the doc (an `expireAfterSeconds` TTL would destroy invite history).
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { invitation: { sweepIntervalMs: 1000 } },
}));

const mockUpdateMany = jest.fn<(...a: unknown[]) => Promise<{ modifiedCount: number }>>();
jest.unstable_mockModule('../src/models/index.js', () => ({
  Invitation: { updateMany: (...a: unknown[]) => mockUpdateMany(...a) },
}));

const { sweepExpiredInvitations, startInvitationReaper, stopInvitationReaper } =
  await import('../src/services/invitation-reaper.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
});

afterEach(() => {
  stopInvitationReaper();
});

describe('sweepExpiredInvitations', () => {
  it('flips stale pending rows to expired (in place, never deletes)', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 4 });
    const n = await sweepExpiredInvitations();

    expect(n).toBe(4);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateMany.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];

    // Only pending rows whose expiry has lapsed.
    expect(filter.status).toBe('pending');
    expect(filter.expiresAt).toEqual({ $lte: expect.any(Date) });
    // Marked expired in place — a $set, NOT a delete.
    expect(update).toEqual({ $set: { status: 'expired' } });
  });

  it('is a safe no-op returning 0 when nothing is stale', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    expect(await sweepExpiredInvitations()).toBe(0);
  });

  it('never throws on a Mongo error (logs and returns 0)', async () => {
    mockUpdateMany.mockRejectedValue(new Error('mongo down'));
    await expect(sweepExpiredInvitations()).resolves.toBe(0);
  });
});

describe('startInvitationReaper', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('runs an immediate sweep and repeats on the interval', async () => {
    startInvitationReaper(1000);

    // Immediate first sweep.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);

    // Advancing the clock triggers subsequent sweeps.
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockUpdateMany).toHaveBeenCalledTimes(3);
  });

  it('is idempotent — a second start does not add a second timer', async () => {
    startInvitationReaper(1000);
    startInvitationReaper(1000); // no-op while a timer is live
    expect(mockUpdateMany).toHaveBeenCalledTimes(1); // only the first immediate sweep

    await jest.advanceTimersByTimeAsync(1000);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2); // single interval, not doubled
  });

  it('stop halts the interval', async () => {
    startInvitationReaper(1000);
    stopInvitationReaper();
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1); // only the immediate sweep ran
  });
});
