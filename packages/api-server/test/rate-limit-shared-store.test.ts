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
import { apiCoreMock } from './helpers/mock-api-core.js';

const createEnvRedisClient = jest.fn<(label: string) => unknown>();

// Spread the REAL api-core (createApp links against a lot of it) and override
// only the factory under test, mirroring `logs-ticket-route.test.ts`.
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
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

/** Run the limiter once for a verified org; resolve with whether next() ran. */
async function runOnce(mw: (req: unknown, res: unknown, next: (err?: unknown) => void) => void): Promise<boolean> {
  const res = { setHeader: jest.fn(), getHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn(), headersSent: false };
  return new Promise((resolve) => {
    // next(err) is how a store error surfaces — only a clean next() counts as allowed.
    mw({ ip: '10.0.0.1', headers: {}, user: { organizationId: 'org-1' } }, res, (err?: unknown) => resolve(err === undefined));
    setTimeout(() => resolve(false), 1000);
  });
}

describe('Redis-backed per-org limiter (rateLimitByOrg)', () => {
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

/**
 * The store's script loading.
 *
 * `rate-limit-redis` keeps its `SCRIPT LOAD` promises on the instance and every
 * `increment` awaits them; express-rate-limit calls `init` once, at route setup,
 * and never again. So a single rejection there — which the no-offline-queue env
 * client produces whenever setup wins the race to a still-connecting socket —
 * used to leave that limiter off for the life of the process, passing every
 * request unlimited while Redis sat there perfectly healthy.
 */
describe('rate-limit store script loading', () => {
  it('does not load scripts at route setup — only when the first request arrives', async () => {
    // Deferring past setup is what removes the boot race: by the time a request
    // arrives, the lazily built connection has long since become ready.
    const commands: string[][] = [];
    createEnvRedisClient.mockImplementation((label) => (label === 'rate-limit' ? {
      on: jest.fn(),
      call: jest.fn(async (...args: string[]) => { commands.push(args); return args[0] === 'SCRIPT' ? 'sha1' : [1, 60_000]; }),
    } : null));

    const { rateLimitByOrg } = await import('../src/api/rate-limit-by-org.js');
    const mw = rateLimitByOrg({ name: 'deferred', max: 5, windowMs: 60_000 });
    expect(commands).toHaveLength(0);

    expect(await runOnce(mw as never)).toBe(true);
    expect(commands.some((c) => c[0] === 'SCRIPT')).toBe(true);
  });

  it('retries the load on the next request instead of caching the rejection forever', async () => {
    // THE REGRESSION. Only the first SCRIPT LOAD fails; everything after it is
    // healthy. Before the retry, request 2 re-awaited request 1's rejected
    // promise and never issued an EVALSHA again.
    let loads = 0;
    const commands: string[][] = [];
    createEnvRedisClient.mockImplementation((label) => (label === 'rate-limit' ? {
      on: jest.fn(),
      call: jest.fn(async (...args: string[]) => {
        commands.push(args);
        if (args[0] === 'SCRIPT') {
          loads += 1;
          if (loads <= 2) throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
          return 'sha1';
        }
        return [1, 60_000];
      }),
    } : null));

    const { rateLimitByOrg } = await import('../src/api/rate-limit-by-org.js');
    const mw = rateLimitByOrg({ name: 'retrying', max: 5, windowMs: 60_000 });

    // Request 1: the load fails, and passOnStoreError lets it through unlimited.
    expect(await runOnce(mw as never)).toBe(true);
    expect(commands.some((c) => c[0] === 'EVALSHA')).toBe(false);

    // Request 2: a FRESH load, which succeeds — the limiter is enforcing again.
    expect(await runOnce(mw as never)).toBe(true);
    expect(commands.find((c) => c[0] === 'EVALSHA')![3]).toBe('rl:api:retrying:org:org-1');
  });

  it('loads the scripts once across many requests when the first load succeeds', async () => {
    // The retry must not turn into a per-request SCRIPT LOAD on the happy path.
    const commands: string[][] = [];
    createEnvRedisClient.mockImplementation((label) => (label === 'rate-limit' ? {
      on: jest.fn(),
      call: jest.fn(async (...args: string[]) => { commands.push(args); return args[0] === 'SCRIPT' ? 'sha1' : [1, 60_000]; }),
    } : null));

    const { rateLimitByOrg } = await import('../src/api/rate-limit-by-org.js');
    const mw = rateLimitByOrg({ name: 'stable', max: 50, windowMs: 60_000 });
    for (let i = 0; i < 3; i += 1) expect(await runOnce(mw as never)).toBe(true);

    // Two loads total: the increment script and the get script, from one init.
    expect(commands.filter((c) => c[0] === 'SCRIPT')).toHaveLength(2);
    expect(commands.filter((c) => c[0] === 'EVALSHA')).toHaveLength(3);
  });
});

/** The wrapper's own surface, exercised directly rather than through a limiter. */
describe('shared store surface', () => {
  /** A fake Redis whose SCRIPT LOADs succeed, recording every command. */
  function fakeRedis(commands: string[][]) {
    createEnvRedisClient.mockImplementation((label) => (label === 'rate-limit' ? {
      on: jest.fn(),
      call: jest.fn(async (...args: string[]) => {
        commands.push(args);
        return args[0] === 'SCRIPT' ? 'sha1' : [1, 60_000];
      }),
    } : null));
  }

  it('forwards get/increment/decrement/resetKey through the deferred init', async () => {
    const commands: string[][] = [];
    fakeRedis(commands);
    const { createSharedRateLimitStore } = await import('../src/api/rate-limit-store.js');
    const store = createSharedRateLimitStore('surface')!;
    expect(store.prefix).toBe('rl:surface:');

    store.init!({ windowMs: 60_000 } as never);
    // Scripts load once, on the first call — not at construction.
    expect(commands).toHaveLength(0);

    await store.increment('k');
    await store.get!('k');
    await store.decrement('k');
    await store.resetKey('k');

    expect(commands.filter((c) => c[0] === 'SCRIPT')).toHaveLength(2);
    expect(commands.some((c) => c[0] === 'DEL')).toBe(true);
  });

  it('passes a call through untouched when init was never called', async () => {
    // express-rate-limit always calls init first; a caller that doesn't must not
    // get invented options — the underlying store simply answers as it would.
    const commands: string[][] = [];
    fakeRedis(commands);
    const { createSharedRateLimitStore } = await import('../src/api/rate-limit-store.js');
    const store = createSharedRateLimitStore('no-init')!;

    await store.resetKey('k');
    expect(commands.some((c) => c[0] === 'SCRIPT')).toBe(false);
    expect(commands.some((c) => c[0] === 'DEL')).toBe(true);
  });
});
