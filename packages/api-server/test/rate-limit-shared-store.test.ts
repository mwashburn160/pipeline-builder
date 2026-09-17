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

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
beforeEach(async () => {
  jest.clearAllMocks();
  // The shared rate-limit connection is memoized per process — rebuild per test.
  (await import('../src/api/rate-limit-store.js')).__resetSharedRateLimitStoreForTests();
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

/** Boot the app with one business route, issue a GET, return the status. */
async function hitOnce(app: import('express').Express): Promise<number> {
  app.get('/biz', (_req, res) => { res.status(200).json({ ok: true }); });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address() as AddressInfo;
    return (await fetch(`http://127.0.0.1:${port}/biz`)).status;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('Redis-backed global rate limiter', () => {
  it('namespaces the bucket per service (rl:<SERVICE_NAME>:global:<ip>), not the shared rl:<ip> default', async () => {
    process.env.SERVICE_NAME = 'pipeline';
    const commands: string[][] = [];
    createEnvRedisClient.mockImplementation((label) => (label === 'rate-limit' ? {
      on: jest.fn(),
      call: jest.fn(async (...args: string[]) => {
        commands.push(args);
        if (args[0] === 'SCRIPT') return 'sha1';
        return [1, 60_000];
      }),
    } : null));

    const { createApp } = await import('../src/api/app-factory.js');
    const { app } = createApp({ enableOpenApi: false, enableHelmet: false });
    expect(await hitOnce(app)).toBe(200);

    const evalsha = commands.find((c) => c[0] === 'EVALSHA');
    expect(evalsha).toBeDefined();
    // EVALSHA <sha> 1 <key> <windowMs>
    expect(evalsha![3]).toMatch(/^rl:pipeline:global:/);
  });

  it('lets requests through (passOnStoreError) when the Redis store is failing', async () => {
    createEnvRedisClient.mockImplementation((label) => (label === 'rate-limit' ? {
      on: jest.fn(),
      call: jest.fn(async () => { throw new Error("Stream isn't writeable"); }),
    } : null));

    const { createApp } = await import('../src/api/app-factory.js');
    const { app } = createApp({ enableOpenApi: false, enableHelmet: false });
    expect(await hitOnce(app)).toBe(200);
  });
});

describe('Redis-backed per-org limiter (rateLimitByOrg)', () => {
  /** Run the limiter once for a verified org; resolve with whether next() ran. */
  async function runOnce(mw: (req: unknown, res: unknown, next: (err?: unknown) => void) => void): Promise<boolean> {
    const res = { setHeader: jest.fn(), getHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn(), headersSent: false };
    return new Promise((resolve) => {
      // next(err) is how a store error surfaces — only a clean next() counts as allowed.
      mw({ ip: '10.0.0.1', headers: {}, user: { organizationId: 'org-1' } }, res, (err?: unknown) => resolve(err === undefined));
      setTimeout(() => resolve(false), 1000);
    });
  }

  it('namespaces by service AND limiter name, sharing the one rate-limit connection', async () => {
    process.env.SERVICE_NAME = 'ask';
    const commands: string[][] = [];
    createEnvRedisClient.mockImplementation((label) => (label === 'rate-limit' ? {
      on: jest.fn(),
      call: jest.fn(async (...args: string[]) => { commands.push(args); return args[0] === 'SCRIPT' ? 'sha1' : [1, 60_000]; }),
    } : null));

    const { rateLimitByOrg } = await import('../src/api/rate-limit-by-org.js');
    expect(await runOnce(rateLimitByOrg({ name: 'ask', max: 5, windowMs: 60_000 }) as never)).toBe(true);
    rateLimitByOrg({ name: 'other', max: 5, windowMs: 60_000 });

    expect(commands.find((c) => c[0] === 'EVALSHA')![3]).toBe('rl:ask:ask:org:org-1');
    expect(createEnvRedisClient.mock.calls.filter(([l]) => l === 'rate-limit')).toHaveLength(1);
  });

  it('lets requests through (passOnStoreError) when the Redis store is failing', async () => {
    createEnvRedisClient.mockImplementation((label) => (label === 'rate-limit' ? {
      on: jest.fn(),
      call: jest.fn(async () => { throw new Error("Stream isn't writeable"); }),
    } : null));
    const { rateLimitByOrg } = await import('../src/api/rate-limit-by-org.js');
    expect(await runOnce(rateLimitByOrg({ name: 'failing', max: 5, windowMs: 60_000 }) as never)).toBe(true);
  });
});
