// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Redis path of the `/token` rate limiter counts with api-core's atomic
 * `incrWindow` (INCR + window TTL in one script). A separate INCR then PEXPIRE
 * could lose the expiry and leave a bucket over its cap forever.
 */

process.env.REGISTRY_TOKEN_RATE_LIMIT_MAX = '2';
process.env.REGISTRY_TOKEN_RATE_LIMIT_IP_MAX = '10';
process.env.REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS = '60000';

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const counts = new Map<string, number>();
const mockIncrWindow = jest.fn(async (_redis: unknown, key: string, _windowMs: number) => {
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  return n;
});
const fakeRedis = { eval: jest.fn() };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createEnvRedisClient: () => fakeRedis,
  incrWindow: (...a: [unknown, string, number]) => mockIncrWindow(...a),
}));

const { checkTokenRateLimit } = await import('../src/services/token-rate-limiter.js');

describe('token rate limiter — Redis path', () => {
  it('counts both buckets through incrWindow with the configured window', async () => {
    expect(await checkTokenRateLimit('10.9.0.1', 'alice')).toBe(true);
    expect(mockIncrWindow).toHaveBeenCalledWith(fakeRedis, 'reg:tokrl:ip:10.9.0.1', 60000);
    expect(mockIncrWindow).toHaveBeenCalledWith(fakeRedis, expect.stringContaining('alice'), 60000);
  });

  it('enforces the per-user cap from the shared counter', async () => {
    expect(await checkTokenRateLimit('10.9.0.2', 'bob')).toBe(true);
    expect(await checkTokenRateLimit('10.9.0.2', 'bob')).toBe(true);
    expect(await checkTokenRateLimit('10.9.0.2', 'bob')).toBe(false);
  });
});
