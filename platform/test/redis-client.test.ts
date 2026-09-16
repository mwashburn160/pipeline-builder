// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: the platform's Redis client must resolve Redis EXACTLY as
 * the stateless services do.
 *
 * It previously read `REDIS_URL` only. No deployment target sets that — they set
 * `REDIS_HOST` (docker, minikube) or `REDIS_SENTINELS` (ec2, eks) — so in every
 * deployment the client was never built, and silently:
 *   - revocations were never published to the other services;
 *   - OAuth/SSO login state, step-up single-use, and the sweep leader lock all
 *     fell back to per-process memory, breaking once platform ran >1 replica.
 * Nothing failed loudly. This pins the shared resolution so it can't recur.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockCreateEnvRedisClient = jest.fn<(label: string) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  createEnvRedisClient: (label: string) => mockCreateEnvRedisClient(label),
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { getRedisClient, __resetRedisClientForTests } = await import('../src/utils/redis-client.js');

beforeEach(() => {
  jest.clearAllMocks();
  __resetRedisClientForTests();
});

describe('getRedisClient', () => {
  it('builds through the SAME env resolution the services use (Sentinel / URL / HOST)', async () => {
    const client = { set: jest.fn() };
    mockCreateEnvRedisClient.mockReturnValue(client);

    await expect(getRedisClient()).resolves.toBe(client);
    expect(mockCreateEnvRedisClient).toHaveBeenCalledTimes(1);
  });

  it('does not depend on REDIS_URL being set', async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    process.env.REDIS_HOST = 'redis';
    try {
      const client = { set: jest.fn() };
      mockCreateEnvRedisClient.mockReturnValue(client);
      // The whole bug: with only REDIS_HOST (every target's actual config) the
      // old client returned undefined.
      await expect(getRedisClient()).resolves.toBe(client);
    } finally {
      if (saved !== undefined) process.env.REDIS_URL = saved;
      delete process.env.REDIS_HOST;
    }
  });

  it('returns undefined when no Redis is configured', async () => {
    mockCreateEnvRedisClient.mockReturnValue(null);
    await expect(getRedisClient()).resolves.toBeUndefined();
  });

  it('builds once and reuses the client', async () => {
    mockCreateEnvRedisClient.mockReturnValue({ set: jest.fn() });
    await getRedisClient();
    await getRedisClient();
    expect(mockCreateEnvRedisClient).toHaveBeenCalledTimes(1);
  });
});
