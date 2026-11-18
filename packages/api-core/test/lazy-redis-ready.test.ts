// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lazily-built env Redis clients run without an offline queue, so a command
 * issued before the first connection completes would be REJECTED — the first
 * step-up per pod would fail and the first impersonation check would read
 * 'unavailable' (401).
 *
 * `createEnvRedisClient` closes that by waiting (bounded) for readiness before
 * every command (its own behaviour is pinned in env-redis-sentinel.test.ts).
 * What this suite pins is that the request-path accessors build their client
 * THROUGH it, never by hand.
 */
import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const calls: Array<{ label: string; opts: unknown }> = [];
const actualEnvRedis = await import('../src/services/env-redis.js');
jest.unstable_mockModule('../src/services/env-redis.js', () => ({
  ...actualEnvRedis,
  createEnvRedisClient: (label: string, opts?: unknown) => {
    calls.push({ label, opts });
    return {
      set: jest.fn(async () => 'OK'),
      get: jest.fn(async () => null),
    };
  },
}));

const { consumeStepUpJti } = await import('../src/middleware/step-up.js');
const { createEnvRedisTokenRevocationStore } = await import('../src/services/token-revocation.js');

const gateKeptOn = (label: string): boolean => calls.some((c) => c.label === label);

describe('lazy env Redis accessors keep the readiness gate on', () => {
  it('step-up jti consume', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    await expect(consumeStepUpJti('first-jti', exp)).resolves.toBe(true);
    expect(gateKeptOn('step-up-jti')).toBe(true);
  });

  it('token-revocation reader', async () => {
    const store = createEnvRedisTokenRevocationStore();
    await expect(store.getSessionRevocation('jti-1')).resolves.toBe('live');
    await expect(store.getCurrentVersion('user-1')).resolves.toBeNull();
    expect(gateKeptOn('revocation-reader')).toBe(true);
  });
});
