// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * api/server.ts beyond shutdown ordering (server-shutdown.test.ts): the
 * dependency SUPERVISOR — a failing onBeforeStart is retried (never exits), the
 * readiness probe flips the instance ready / NotReady / ready as the datastore
 * comes and goes, and a probe that throws counts as down — plus the full
 * shutdown (SSE drain, custom DB close, onShutdown failure tolerated, exit 0),
 * the fail-fast signing-key check, and runServer's fatal-setup exit.
 */

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import express from 'express';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.READINESS_MONITOR_INTERVAL_MS = '5';

const retryFailures: string[] = [];
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  installCrashHandlers: jest.fn(),
  resolveRedisConnection: () => null,
  nextBackoffMs: () => 5,
  // Same contract as the real one: retry until fn resolves or shouldContinue says stop.
  retryForever: async (fn: () => Promise<void>, o: { onAttemptFailed?: (e: unknown, d: number) => void; shouldContinue?: () => boolean }) => {
    for (;;) {
      try { await fn(); return; } catch (e) {
        o.onAttemptFailed?.(e, 1);
        retryFailures.push((e as Error).message);
        if (o.shouldContinue && !o.shouldContinue()) return;
      }
    }
  },
}));
let dbUp = true;
const closeConnection = jest.fn(async () => undefined);
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ port: 0, platformUrl: 'http://platform' }), getAny: () => ({ serviceName: 'test' }), validateAuth: () => undefined },
  CoreConstants: new Proxy({}, { get: () => 60_000 }),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  getConnection: () => ({ testConnection: async () => { if (dbUp === null) throw new Error('probe crashed'); return dbUp; } }),
  closeConnection,
}));
jest.unstable_mockModule('../src/api/tracing.js', () => ({ shutdownTracing: async () => { throw new Error('otel gone'); } }));

const { startServer, runServer } = await import('../src/api/server.js');
const { isReady } = await import('../src/api/readiness.js');

const savedEnv = { ...process.env };
beforeAll(() => {
  process.env.SERVICE_SIGNING_KEY_FILE = '/dev/null';
  process.env.SERVICE_KEY_BUNDLE_FILE = '/dev/null';
});
afterAll(() => { process.env = savedEnv; });

/**
 * shutdown() arms an unref'd force-exit timer; keep it short and let it fire
 * while process.exit is still mocked, or it would really exit the jest worker later.
 */
const FORCE_EXIT_MS = 20;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond` holds (the supervisor's first NotReady back-off is its 1 s base). */
const until = async (cond: () => boolean, maxMs = 3000) => { for (let t = 0; t < maxMs && !cond(); t += 10) await tick(10); };

describe('dependency supervisor', () => {
  it('retries a failing onBeforeStart, then follows the datastore up / down / up', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let attempts = 0;
    dbUp = true;
    const result = await startServer(express(), {
      port: 0,
      closeDatabase: false,
      shutdownTimeoutMs: FORCE_EXIT_MS,
      onBeforeStart: async () => { if (++attempts < 3) throw new Error(`mongo cold ${attempts}`); },
    });
    await until(() => isReady());
    expect(retryFailures).toEqual(['mongo cold 1', 'mongo cold 2']);
    expect(isReady()).toBe(true);

    dbUp = false;
    await until(() => !isReady());
    expect(isReady()).toBe(false);

    dbUp = null as unknown as boolean; // a probe that throws is "down"
    await tick();
    expect(isReady()).toBe(false);

    dbUp = true;
    await until(() => isReady());
    expect(isReady()).toBe(true);

    await result.shutdown();
    await tick(FORCE_EXIT_MS * 3);
    exit.mockRestore();
  }, 15_000);
});

describe('shutdown', () => {
  it('drains SSE, tolerates a failing onShutdown and tracing, closes the DB its own way, exits 0', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const sseShutdown = jest.fn();
    const closeDatabase = jest.fn(async () => { throw new Error('close failed'); });
    const result = await startServer(express(), {
      port: 0,
      testDatabase: false,
      shutdownTimeoutMs: FORCE_EXIT_MS,
      sseManager: { shutdown: sseShutdown } as never,
      onShutdown: async () => { throw new Error('queue close failed'); },
      closeDatabase,
      onStart: jest.fn(),
    });
    await until(() => isReady());
    await result.shutdown();
    await result.shutdown(); // concurrent / repeated signal is a no-op
    await until(() => exit.mock.calls.length > 0);
    expect(sseShutdown).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    await tick(FORCE_EXIT_MS * 3);
    exit.mockRestore();
  });

  it('uses the default Postgres close when none is given', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    dbUp = true;
    const result = await startServer(express(), { port: 0, shutdownTimeoutMs: FORCE_EXIT_MS });
    await result.shutdown();
    await until(() => exit.mock.calls.length > 0);
    expect(closeConnection).toHaveBeenCalled();
    await tick(FORCE_EXIT_MS * 3);
    exit.mockRestore();
  });
});

describe('fatal setup', () => {
  it('refuses to start without its signing key; runServer exits 1 on that', async () => {
    const saved = process.env.SERVICE_SIGNING_KEY_FILE;
    delete process.env.SERVICE_SIGNING_KEY_FILE;
    await expect(startServer(express(), { port: 0 })).rejects.toThrow('SERVICE_SIGNING_KEY_FILE environment variable is required');
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    runServer(express(), { port: 0 });
    await until(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    process.env.SERVICE_SIGNING_KEY_FILE = saved;
  });
});
