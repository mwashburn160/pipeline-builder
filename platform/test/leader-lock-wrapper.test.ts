// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * runWithLeaderLock (utils/leader-lock.ts) NEVER rejects.
 *
 * Every platform sweep fires it from a timer with `void`, so a rejection is an
 * unhandled promise rejection — which exits the process. That is exactly how
 * platform crash-looped on minikube: the first sweep's lock SET ran before the
 * Redis connection was up.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockGetRedisClient = jest.fn<() => Promise<unknown>>();
const mockLoggerError = jest.fn();
const mockWithLeaderLock = jest.fn<(...a: any[]) => Promise<boolean>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: mockLoggerError, debug: jest.fn() }),
  withLeaderLock: (...a: any[]) => mockWithLeaderLock(...a),
}));
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: () => mockGetRedisClient(),
}));

const { runWithLeaderLock } = await import('../src/utils/leader-lock.js');

beforeEach(() => {
  jest.clearAllMocks();
  // Behave like api-core: run fn when "acquired".
  mockWithLeaderLock.mockImplementation(async (_r: unknown, _k: string, _t: number, fn: () => Promise<void>) => { await fn(); return true; });
});

describe('runWithLeaderLock', () => {
  it('logs a failing job instead of rejecting (Redis configured)', async () => {
    mockGetRedisClient.mockResolvedValue({});
    await expect(runWithLeaderLock('platform:leader:x', 1000, async () => { throw new Error('mongo down'); }))
      .resolves.toBe(true);
    expect(mockLoggerError).toHaveBeenCalledWith('Background job failed', expect.objectContaining({ key: 'platform:leader:x', error: 'mongo down' }));
  });

  it('logs a failing job instead of rejecting (no Redis)', async () => {
    mockGetRedisClient.mockResolvedValue(undefined);
    await expect(runWithLeaderLock('platform:leader:x', 1000, async () => { throw new Error('boom'); }))
      .resolves.toBe(true);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});
