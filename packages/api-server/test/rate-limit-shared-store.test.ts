// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The global rate limiter's backing store.
 *
 * `createApp` only used a shared Redis store when a `redisUrl` OPTION was
 * passed — and no service passes one. So every api service rate-limited
 * per-pod: under an HPA (pipeline scales to 4 replicas, billing to 3) the
 * effective ceiling became `max × replicas` for any client the load balancer
 * spread across pods, i.e. the DoS control was weakest exactly when load was
 * highest. It now derives the client from the environment, like every other
 * Redis consumer in the package (idempotency, SSE tickets, token revocation).
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const createEnvRedisClient = jest.fn<(label: string) => unknown>();

// Spread the REAL api-core (createApp links against a lot of it) and override
// only the factory under test, mirroring `logs-ticket-route.test.ts`.
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  ...actualApiCore,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  createEnvRedisClient,
}));

const ORIGINAL = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  createEnvRedisClient.mockReturnValue(null);
  // `createApp` fails fast without it (prevents silent auth failures at runtime).
  process.env.JWT_SECRET ||= 'test-secret';
});
afterEach(() => { process.env = { ...ORIGINAL }; });

describe('rate-limit store selection', () => {
  it('asks for an env Redis client even when no redisUrl option is passed', async () => {
    // The regression: this call never happened, so the limiter silently stayed
    // per-process on every multi-replica deployment.
    const { createApp } = await import('../src/api/app-factory.js');
    createApp({ serviceName: 'test' } as never);

    expect(createEnvRedisClient).toHaveBeenCalledWith('rate-limit');
  });

  it('falls back to the in-memory store when no Redis is configured', async () => {
    // `createEnvRedisClient` returns null with no REDIS_* env — correct for
    // single-replica and local runs; the app must still start.
    createEnvRedisClient.mockReturnValue(null);
    const { createApp } = await import('../src/api/app-factory.js');
    expect(() => createApp({ serviceName: 'test' } as never)).not.toThrow();
  });

  it('does not ask for a rate-limit client when rate limiting is disabled', async () => {
    // The factory is shared (idempotency + SSE tickets also use it), so assert
    // on the LABEL rather than the call count.
    const { createApp } = await import('../src/api/app-factory.js');
    createApp({ serviceName: 'test', enableRateLimit: false } as never);
    expect(createEnvRedisClient).not.toHaveBeenCalledWith('rate-limit');
  });
});
