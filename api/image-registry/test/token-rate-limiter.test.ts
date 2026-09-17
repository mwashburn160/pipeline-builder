// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the `/token` rate limiter. Every request must pass BOTH buckets:
 *   - per (source-ip, username), never the password — caps credential stuffing
 *     (one account, many passwords);
 *   - per source-ip — caps password spraying (one password, many usernames).
 * These run the in-memory fallback path (no REDIS_* env, so
 * `createEnvRedisClient` returns null).
 */

// Small caps so the test doesn't loop 60×. Set BEFORE importing the SUT (env is
// read at module load). The per-IP cap is above the per-user cap, as in prod.
process.env.REGISTRY_TOKEN_RATE_LIMIT_MAX = '3';
process.env.REGISTRY_TOKEN_RATE_LIMIT_IP_MAX = '5';
process.env.REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS = '60000';

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// No Redis configured → createEnvRedisClient returns null → memory fallback.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createEnvRedisClient: () => null,
}));

const { checkTokenRateLimit } = await import('../src/services/token-rate-limiter.js');

describe('token rate limiter — per (ip, username) bucket', () => {
  it('caps a stuffing run against one account (password is not part of the key)', async () => {
    // 3 allowed (the per-user cap), then denied — the password is not an input,
    // so however it varied these all land in one bucket.
    expect(await checkTokenRateLimit('10.0.0.2', 'victim')).toBe(true);
    expect(await checkTokenRateLimit('10.0.0.2', 'victim')).toBe(true);
    expect(await checkTokenRateLimit('10.0.0.2', 'victim')).toBe(true);
    expect(await checkTokenRateLimit('10.0.0.2', 'victim')).toBe(false); // 4th over the cap
  });

  it('keeps separate user buckets per (ip, username)', async () => {
    for (let i = 0; i < 3; i++) await checkTokenRateLimit('10.0.0.3', 'bob');
    expect(await checkTokenRateLimit('10.0.0.3', 'bob')).toBe(false);
    // A different ip or a different user on the same ip is unaffected.
    expect(await checkTokenRateLimit('10.0.0.4', 'bob')).toBe(true);
    expect(await checkTokenRateLimit('10.0.0.3', 'carol')).toBe(true);
  });
});

describe('token rate limiter — per-ip bucket (password spraying)', () => {
  it('caps a spray across DISTINCT usernames from one ip', async () => {
    // Each username is used once, so no per-user bucket ever fills — only the
    // per-ip cap (5) can stop this.
    for (let i = 0; i < 5; i++) {
      expect(await checkTokenRateLimit('10.0.1.1', `user-${i}`)).toBe(true);
    }
    expect(await checkTokenRateLimit('10.0.1.1', 'user-5')).toBe(false);
    expect(await checkTokenRateLimit('10.0.1.1', 'user-6')).toBe(false);
    // Another source ip still has its own budget.
    expect(await checkTokenRateLimit('10.0.1.2', 'user-5')).toBe(true);
  });
});
