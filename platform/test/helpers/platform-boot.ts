// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Boots the REAL `src/index.ts` entrypoint (its own `startServer()` and signal
 * handlers) with every collaborator that would reach outside the process
 * stubbed: Mongo never connects, token signing / audit-key checks pass, the
 * routes are empty. What is real is exactly what the shutdown suites assert on:
 * the HTTP listener, api-server's readiness flag and its `shutdownTracing()`
 * (driven through the preload's global hook), and the signal handlers.
 *
 * Every observable shutdown step is appended to `events` so a suite can assert
 * ORDER, not just occurrence. Call before importing anything else from src.
 */
import http from 'node:http';
import { jest } from '@jest/globals';
import express, { type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { mockConfig } from './config-mock.js';

export interface PlatformBoot {
  events: string[];
  exit: jest.Mock<(code?: number) => void>;
  /** api-server's readiness flag — the same module instance index.ts uses. */
  isReady: () => boolean;
  setReady: (ready: boolean) => void;
  /** Re-install the observing spies (after `restoreMocks` undid them). */
  arm: () => void;
  /** The listener index.ts opened. */
  server: () => http.Server;
  /** Remove the signal listeners index.ts installed and close the listener. */
  cleanup: () => void;
}

/** The preload publishes its SDK shutdown here (api-server tracing.ts). */
const OTEL_SHUTDOWN_KEY = Symbol.for('pipeline-builder.otel.shutdown');

export async function bootPlatform(opts: { shutdownTimeoutMs?: number; mongoCloseHangs?: boolean } = {}): Promise<PlatformBoot> {
  const events: string[] = [];
  const passthrough = (_req: Request, _res: Response, next: NextFunction): void => next();

  process.env.SERVICE_SIGNING_KEY_FILE = '/dev/null';
  process.env.SERVICE_KEY_BUNDLE_FILE = '/dev/null';

  jest.unstable_mockModule('../../src/config/index.js', () => mockConfig({
    app: { port: 0 },
    server: { shutdownTimeoutMs: opts.shutdownTimeoutMs ?? 2_000, readinessMonitorIntervalMs: 60_000, trustProxy: false },
    billing: { enabled: false },
  }));
  jest.unstable_mockModule('../../src/middleware/index.js', () => ({
    notFoundHandler: (_req: Request, res: Response) => { res.status(404).end(); },
    errorHandler: (_err: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(500).end(); },
  }));
  jest.unstable_mockModule('../../src/middleware/limiters.js', () => ({ generalLimiter: passthrough, scimLimiter: passthrough }));
  jest.unstable_mockModule('../../src/middleware/rate-limit-keys.js', () => ({ peekJwtClaims: () => ({}) }));
  jest.unstable_mockModule('../../src/middleware/require-write-access.js', () => ({
    denyReadOnlyImpersonationWrite: jest.fn(),
    isWriteBlockedByImpersonation: () => false,
  }));
  jest.unstable_mockModule('../../src/routes/jwks.js', () => ({ default: express.Router() }));
  jest.unstable_mockModule('../../src/routes/mount.js', () => ({ mountApiRoutes: () => undefined }));
  jest.unstable_mockModule('../../src/utils/index-reconcile.js', () => ({ reconcileIndexes: async () => undefined }));
  jest.unstable_mockModule('../../src/utils/redis-client.js', () => ({ assertRedisConfiguredForProduction: () => undefined }));
  jest.unstable_mockModule('../../src/observability/metrics.js', () => ({
    setMetricsRegistry: () => undefined, incCounter: () => undefined, setGauge: () => undefined,
  }));
  jest.unstable_mockModule('../../src/observability/secret-rotation.js', () => ({ registerPlatformSecretRotationProbes: () => undefined }));
  jest.unstable_mockModule('../../src/observability/scraper.js', () => ({
    startPlatformMetricsScraper: () => undefined,
    stopPlatformMetricsScraper: () => { events.push('scraper.stop'); },
  }));
  jest.unstable_mockModule('../../src/services/token-signing/index.js', () => ({ initTokenSigning: async () => undefined }));
  jest.unstable_mockModule('../../src/config/audit-chain-key.js', () => ({ requireAuditChainHmacKey: () => undefined }));

  // Tracing: the preload's flush hook.
  (globalThis as Record<symbol, unknown>)[OTEL_SHUTDOWN_KEY] = async () => { events.push('tracing.shutdown'); };

  const { isReady, setReady } = await import('@pipeline-builder/api-server');

  const exit = jest.fn((code?: number) => { events.push(`exit(${code ?? 0})`); });
  let listening: http.Server | undefined;
  const realClose = http.Server.prototype.close;
  const realListen = http.Server.prototype.listen;

  /**
   * (Re)install the observing spies. platform's jest config sets
   * `restoreMocks`, which undoes every spy after each test — so a suite that
   * boots once in `beforeAll` calls this again in `beforeEach`.
   */
  const arm = (): void => {
    // Mongo: never connects (initDependencies parks in its retry), and close is observed.
    jest.spyOn(mongoose, 'connect').mockImplementation(() => new Promise(() => { /* never settles */ }));
    jest.spyOn(mongoose.connection, 'close').mockImplementation((async () => {
      events.push('mongo.close');
      if (opts.mongoCloseHangs) await new Promise(() => { /* never settles */ });
    }) as never);
    // Every server.close call, with the readiness state at that instant.
    jest.spyOn(http.Server.prototype, 'close').mockImplementation(function (this: http.Server, cb?: (err?: Error) => void) {
      events.push(`server.close(ready=${isReady()})`);
      return realClose.call(this, cb);
    });
    // Capture the listener index.ts opens.
    jest.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: unknown[]) {
      listening = this;
      return (realListen as (...a: unknown[]) => http.Server).apply(this, args);
    } as never);
    jest.spyOn(process, 'exit').mockImplementation(exit as never);
  };
  arm();

  const before = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
  await import('../../src/index.js');
  // Let startServer()'s awaits run so the listener and signal handlers exist.
  await new Promise((r) => setTimeout(r, 50));

  return {
    events,
    exit,
    isReady,
    setReady,
    arm,
    server: () => listening as http.Server,
    cleanup: () => {
      jest.restoreAllMocks();
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        for (const l of process.listeners(sig)) if (!before[sig].includes(l)) process.removeListener(sig, l);
      }
      delete (globalThis as Record<symbol, unknown>)[OTEL_SHUTDOWN_KEY];
    },
  };
}

/** Resolve once `pred` holds (or after `ms`). */
export async function waitFor(pred: () => boolean, ms = 1_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}
