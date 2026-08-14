// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the coarsened `/token` rate limiter (credential-stuffing fix).
 *
 * The key must be COARSE — `(source-ip, username)`, never the password — so a
 * client that varies the password on every attempt shares ONE bucket and the
 * cap actually engages. These run the in-memory fallback path (no REDIS_* env,
 * so `createEnvRedisClient` returns null).
 */

// Small cap so the test doesn't loop 60×. Set BEFORE importing the SUT (env is
// read at module load).
process.env.REGISTRY_TOKEN_RATE_LIMIT_MAX = '3';
process.env.REGISTRY_TOKEN_RATE_LIMIT_WINDOW_MS = '60000';

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// No Redis configured → createEnvRedisClient returns null → memory fallback.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createEnvRedisClient: () => null,
}));

const { checkTokenRateLimit, rateLimitKey } = await import('../src/services/token-rate-limiter.js');

describe('token rate limiter — coarse key', () => {
  it('does NOT include the password in the key (varied passwords share a bucket)', async () => {
    // The key is a pure function of (ip, username); the password is not an input.
    const k1 = rateLimitKey('10.0.0.1', 'alice');
    const k2 = rateLimitKey('10.0.0.1', 'alice');
    expect(k1).toBe(k2);
    expect(k1).not.toContain('password');
  });

  it('caps a stuffing run that varies the password (same ip+username = one bucket)', async () => {
    const key = rateLimitKey('10.0.0.2', 'victim');
    // 3 allowed (the cap), then denied — regardless of how the password varied,
    // because the password is not part of the key.
    expect(await checkTokenRateLimit(key)).toBe(true);
    expect(await checkTokenRateLimit(key)).toBe(true);
    expect(await checkTokenRateLimit(key)).toBe(true);
    expect(await checkTokenRateLimit(key)).toBe(false); // 4th over the cap
    expect(await checkTokenRateLimit(key)).toBe(false);
  });

  it('keeps separate buckets per (ip, username)', async () => {
    const a = rateLimitKey('10.0.0.3', 'bob');
    const b = rateLimitKey('10.0.0.4', 'bob'); // different ip
    const c = rateLimitKey('10.0.0.3', 'carol'); // different user
    // Exhaust bucket a.
    await checkTokenRateLimit(a); await checkTokenRateLimit(a); await checkTokenRateLimit(a);
    expect(await checkTokenRateLimit(a)).toBe(false);
    // b and c are unaffected — still allowed.
    expect(await checkTokenRateLimit(b)).toBe(true);
    expect(await checkTokenRateLimit(c)).toBe(true);
  });
});
