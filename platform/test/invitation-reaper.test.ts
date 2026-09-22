// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the invitation reaper — the durable sweep that flips stale
 * `pending` invitations (past their `expiresAt`) to `expired` in place, WITHOUT
 * deleting the doc (an `expireAfterSeconds` TTL would destroy invite history).
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { leaderLockMock } from './helpers/leader-lock-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ invitation: { sweepIntervalMs: 1000 }, audit: { retentionDays: 90 } }));

const mockUpdateMany = jest.fn<(...a: unknown[]) => Promise<{ modifiedCount: number }>>();
jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Invitation: { updateMany: (...a: unknown[]) => mockUpdateMany(...a) },
}));

jest.unstable_mockModule('../src/utils/leader-lock.js', () => leaderLockMock());

const { sweepExpiredInvitations, invitationReaperSweep } = await import('../src/services/invitation-reaper.js');
const { buildSweep } = await import('../src/services/background-sweeps.js');

let sweep: { start(): void; stop(): void } | null = null;
function startReaper(intervalMs: number): void {
  sweep ??= buildSweep(invitationReaperSweep(intervalMs));
  sweep!.start();
}
function stopReaper(): void {
  sweep?.stop();
  sweep = null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
});

afterEach(() => {
  stopReaper();
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

describe('invitationReaperSweep', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('runs an immediate sweep and repeats on the interval', async () => {
    startReaper(1000);

    // Immediate first sweep.
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);

    // Advancing the clock triggers subsequent sweeps.
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockUpdateMany).toHaveBeenCalledTimes(3);
  });

  it('the lock key makes it a one-replica-per-window sweep, and a second start adds no second timer', async () => {
    startReaper(1000);
    startReaper(1000); // no-op while a timer is live
    expect(mockUpdateMany).toHaveBeenCalledTimes(1); // only the first immediate sweep

    await jest.advanceTimersByTimeAsync(1000);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2); // single interval, not doubled
  });

  it('stop halts the interval', async () => {
    startReaper(1000);
    stopReaper();
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1); // only the immediate sweep ran
  });
});
