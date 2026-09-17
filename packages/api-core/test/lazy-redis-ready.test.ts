// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lazily-built env Redis clients run without an offline queue, so a command
 * issued before the first connection completes is REJECTED. The request-path
 * accessors must wait (bounded) for readiness, otherwise the first step-up per
 * pod fails and the first impersonation check reads 'unavailable' (401).
 *
 * The fake below behaves like ioredis with `enableOfflineQueue: false`: status
 * starts 'connecting', commands reject until it flips to 'ready'.
 */
import { jest, describe, it, expect } from '@jest/globals';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const clients: Array<ReturnType<typeof connectingClient>> = [];
function connectingClient() {
  const listeners: Record<string, Array<() => void>> = {};
  const offline = async () => { throw new Error("Stream isn't writeable and enableOfflineQueue options is false"); };
  const c = {
    status: 'connecting',
    once(evt: string, cb: () => void) { (listeners[evt] ||= []).push(cb); },
    off(evt: string, cb: () => void) { listeners[evt] = (listeners[evt] || []).filter((x) => x !== cb); },
    connect() {
      c.status = 'ready';
      const cbs = listeners.ready || [];
      listeners.ready = [];
      cbs.forEach((cb) => cb());
    },
    set: jest.fn(async (..._a: unknown[]) => (c.status === 'ready' ? 'OK' : offline())),
    get: jest.fn(async (_k: string) => (c.status === 'ready' ? null : offline())),
  };
  return c;
}

const actualEnvRedis = await import('../src/services/env-redis.js');
jest.unstable_mockModule('../src/services/env-redis.js', () => ({
  ...actualEnvRedis,
  createEnvRedisClient: () => {
    const c = connectingClient();
    clients.push(c);
    // The connection completes shortly after construction.
    setTimeout(() => c.connect(), 20);
    return c;
  },
}));

const { consumeStepUpJti } = await import('../src/middleware/step-up.js');
const { createEnvRedisTokenRevocationStore } = await import('../src/services/token-revocation.js');

describe('lazy env Redis accessors wait for the first connection', () => {
  it('the first step-up jti consume on a pod succeeds (does not fail closed on a still-connecting client)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    await expect(consumeStepUpJti('first-jti', exp)).resolves.toBe(true);
  });

  it('the first impersonation check reads live, not unavailable', async () => {
    const store = createEnvRedisTokenRevocationStore();
    await expect(store.getSessionRevocation!('jti-1')).resolves.toBe('live');
  });

  it('the first tokenVersion read reaches Redis instead of silently failing open', async () => {
    const store = createEnvRedisTokenRevocationStore();
    await expect(store.getCurrentVersion('user-1')).resolves.toBeNull();
    expect(clients[clients.length - 1].get).toHaveBeenCalledTimes(1);
    expect(clients[clients.length - 1].get.mock.results[0].type).toBe('return');
    await expect(clients[clients.length - 1].get.mock.results[0].value).resolves.toBeNull();
  });
});
