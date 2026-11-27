// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Server } from 'http';
import { assertJwtIssuerAudienceConfigured, buildRouteTable, createLogger, errorMessage, flushQuotaIncrements, installCrashHandlers, nextBackoffMs, resolveRedisConnection, retryForever, summarizeRouteTable, sleep } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { getConnection, closeConnection } from '@pipeline-builder/pipeline-data';
import type { Express } from 'express';
import { installGracefulShutdown } from './graceful-shutdown.js';
import { setReady, isReady } from './readiness.js';
import { apiServerConfig } from '../config.js';
import { SSEManager } from '../http/sse-connection-manager.js';

const logger = createLogger('server');


// Dependency-supervisor cadence. Initial connect retries with capped backoff;
// once connected, re-checks at a steady interval so a later outage flips the
// service NotReady (draining traffic) and a recovery flips it back — without
// ever exiting / restarting the process.
const READY_RETRY_BASE_MS = 1000;
const READY_RETRY_MAX_MS = 10000;
const READY_MONITOR_INTERVAL_MS = apiServerConfig.readiness.monitorIntervalMs;

/**
 * Establish and continuously monitor the service's datastore dependency,
 * flipping readiness state instead of crash-looping.
 *
 * - Establish phase: retry `onBeforeStart` (e.g. connectMongo) with capped
 *   backoff until it succeeds — a cold datastore must never exit the process.
 * - Monitor phase: poll `testDatabase` for the life of the process; flip
 *   ready/NotReady on transitions. While NotReady the readiness guard 503s
 *   business traffic and orchestrator readiness probes drain the instance.
 *
 * Runs in the background (the HTTP server is already listening). Stops when
 * `aborted()` returns true (graceful shutdown), so it never keeps a closing
 * process alive.
 */
async function superviseDependencies(
  name: string,
  onBeforeStart: (() => Promise<void>) | undefined,
  testDatabase: (() => Promise<boolean>) | false | undefined,
  aborted: () => boolean,
): Promise<void> {
  if (onBeforeStart) {
    await retryForever(onBeforeStart, {
      baseMs: READY_RETRY_BASE_MS,
      maxMs: READY_RETRY_MAX_MS,
      onAttemptFailed: (error, delayMs) => logger.warn(
        `${name}: dependency init failed, retrying in ${delayMs}ms`,
        { error: errorMessage(error) },
      ),
      shouldContinue: () => !aborted(),
    });
  }

  // No datastore to gate on → ready as soon as we are listening.
  if (testDatabase === false) {
    if (aborted()) return; // shutdown began while we were initializing
    setReady(true);
    logger.info(`${name} ready (no datastore dependency)`);
    return;
  }

  const probe = testDatabase ?? (() => getConnection().testConnection());
  let waitDelay = READY_RETRY_BASE_MS;
  while (!aborted()) {
    let ok = false;
    try {
      ok = await probe();
    } catch {
      ok = false;
    }

    // A probe that was in flight when shutdown began must not flip the
    // draining instance back to ready.
    if (aborted()) break;
    if (ok && !isReady()) {
      setReady(true);
      waitDelay = READY_RETRY_BASE_MS;
      logger.info(`${name} ready — dependencies connected`);
    } else if (!ok && isReady()) {
      setReady(false);
      logger.warn(`${name} degraded — dependency check failing (now NotReady)`);
    }

    // Steady cadence once ready; faster backoff while waiting so we flip to
    // ready promptly when the datastore comes up.
    if (isReady()) {
      await sleep(READY_MONITOR_INTERVAL_MS);
    } else {
      await sleep(waitDelay);
      waitDelay = nextBackoffMs(waitDelay, READY_RETRY_MAX_MS);
    }
  }
}

/**
 * Options for starting a server
 */
export interface StartServerOptions {
  /** Service name for logging */
  name?: string;
  /** Port to listen on (default: from config) */
  port?: number;
  /** SSE manager for graceful shutdown */
  sseManager?: SSEManager;
  /** Shutdown timeout in milliseconds (default: 15000) */
  shutdownTimeoutMs?: number;
  /** Callback after server starts */
  onStart?: (port: number) => void;
  /** Callback before shutdown */
  onShutdown?: () => Promise<void>;
  /** Runs before database check (e.g., initialize external connections) */
  onBeforeStart?: () => Promise<void>;
  /** Custom database health check, or false to skip. Default: PostgreSQL testConnection */
  testDatabase?: (() => Promise<boolean>) | false;
  /** Custom database close, or false to skip. Default: PostgreSQL closeConnection */
  closeDatabase?: (() => Promise<void>) | false;
}

/**
 * Result of starting a server
 */
export interface StartServerResult {
  /** HTTP server instance */
  server: Server;
  /** Port the server is listening on */
  port: number;
  /** Function to manually trigger shutdown */
  shutdown: () => Promise<void>;
}

/**
 * Start an Express server with graceful shutdown handling
 *
 * Features:
 * - Automatic database connection testing
 * - Graceful shutdown on SIGINT/SIGTERM
 * - SSE connection cleanup
 * - Configurable shutdown timeout
 *
 * @param app - Express application
 * @param options - Server options
 * @returns Server instance and control functions
 *
 * @example
 * ```typescript
 * const { app, sseManager } = createApp();
 *
 * app.post('/api/resource', requireAuth, handler);
 *
 * await startServer(app, {
 *   name: 'My Microservice',
 *   sseManager,
 *   onStart: (port) => console.log(`Listening on ${port}`),
 * });
 * ```
 */
export async function startServer(
  app: Express,
  options: StartServerOptions = {},
): Promise<StartServerResult> {
  const serverConfig = Config.get('server');
  const {
    name = 'Microservice',
    sseManager,
    shutdownTimeoutMs = 15000,
    onStart,
    onShutdown,
    onBeforeStart,
    testDatabase,
    closeDatabase,
  } = options;
  const port = options.port ?? serverConfig.port;

  // Validate auth configuration at server startup (not during CDK synthesis)
  Config.validateAuth();
  // Fail fast if this service has no internal signing key of its own, or no
  // public bundle to verify its peers with. Without them it would mint
  // tokens on an EPHEMERAL in-process key that no peer accepts, and reject every
  // peer's token — i.e. silently lose all service-to-service traffic. Checked
  // HERE rather than in `createApp` because it is a property of the running
  // deployment, not of the app object: route-table builders and test suites
  // assemble an app without ever signing anything.
  for (const envVar of ['SERVICE_SIGNING_KEY_FILE', 'SERVICE_KEY_BUNDLE_FILE'] as const) {
    if (!process.env[envVar]) {
      throw new Error(`${envVar} environment variable is required (generate with deploy/bin/service-signing-keys.sh). Set it before starting the server.`);
    }
  }
  // Fail fast on an unusable Redis configuration (throws RedisConfigError) — a
  // Redis client is created lazily on first use, so without this a bad config
  // would surface as request-time errors instead of a failed start.
  resolveRedisConnection();

  logger.info(`Starting ${name}...`);

  // Mark NotReady synchronously, BEFORE the port opens, so no request slips
  // through the readiness guard before the supervisor has run. The supervisor
  // flips it true once dependencies connect.
  setReady(false);

  // Listen FIRST, then establish + monitor the datastore in the background,
  // reporting NotReady until it connects. Testing the DB before listen and
  // exiting on failure crash-loops the whole fleet during a cold-DB stampede:
  // the process never opens its port, so /health (liveness), /ready and the
  // readiness guard can't answer and the orchestrator only sees a dead pod.
  // Opening the port first makes "dependency down" an observable state.
  const server = app.listen(port, () => {
    logger.info(`${name} listening on port: ${port}`);
    logger.info(`Platform URL: ${serverConfig.platformUrl}`);
    onStart?.(port);
  });

  // The shared shutdown routine (graceful-shutdown.ts): re-entry guard,
  // NotReady first, unref'd force-exit timer, then onShutdown + SSE close,
  // server.close, quota flush + datastore close, tracing flush, exit.
  const { shutdown, isShuttingDown } = installGracefulShutdown({
    server,
    name,
    timeoutMs: shutdownTimeoutMs,
    beforeClose: [
      ...(onShutdown ? [onShutdown] : []),
      ...(sseManager ? [() => { sseManager.shutdown(); logger.info('SSE connections closed'); }] : []),
    ],
    onStop: [
      // Every in-flight request has now finished and buffered its metering unit;
      // send them before exiting (api-core quota-increment-batcher). Never rejects.
      () => flushQuotaIncrements(),
      ...(closeDatabase === false ? [] : [async () => {
        await (closeDatabase ? closeDatabase() : closeConnection());
        logger.info('Database connection closed');
      }]),
    ],
  });

  // Background dependency supervisor — established + monitored after listen,
  // stopped on shutdown so it never keeps a closing process alive. Guard the
  // floating promise: every expected failure is handled inside, so a rejection
  // here means a programming error — log it and leave the service NotReady
  // rather than letting it become an unhandledRejection that crash-exits the
  // process (which would defeat the whole "never exit on dependency trouble"
  // goal).
  superviseDependencies(name, onBeforeStart, testDatabase, isShuttingDown).catch((error) => {
    logger.error('Dependency supervisor crashed; service will remain NotReady', { error: errorMessage(error) });
  });

  return {
    server,
    port,
    shutdown: () => shutdown(),
  };
}

/**
 * Simple server start wrapper with error handling
 *
 * @param app - Express application
 * @param options - Server options
 *
 * @example
 * ```typescript
 * const { app, sseManager } = createApp();
 * app.post('/api/resource', handler);
 *
 * void runServer(app, { name: 'My Service', sseManager });
 * ```
 */
export function runServer(app: Express, options: StartServerOptions = {}): void {
  // Route table of the fully assembled app (see api-core's route-table.ts): the
  // same introspection the per-service coverage test asserts on, logged once at
  // boot so an ungated or unaudited write route is visible in the running
  // service, not only in CI.
  logger.info('Route table built', summarizeRouteTable(buildRouteTable(app)));

  // Last-resort fault handlers for the production entrypoint: an unhandled
  // rejection / uncaught exception is logged (not silently fatal) then the
  // process exits for the orchestrator to restart. No-op under NODE_ENV=test.
  installCrashHandlers(logger);
  // Refuse to boot in production without JWT issuer/audience pinning. Without
  // this the misconfiguration only surfaces per request (every token check
  // fails closed with a 401), which looks like an auth outage, not a config one.
  assertJwtIssuerAudienceConfigured();
  startServer(app, options).catch((error) => {
    // startServer now listens-first and supervises the DB in the background, so
    // it only rejects on a genuinely fatal SETUP error (invalid auth config, a
    // failed onStart, the port already in use). Log message + stack explicitly:
    // an Error in winston metadata serializes to `{}` (message/stack are
    // non-enumerable), which would otherwise hide the cause behind `{error:{}}`.
    logger.error('Failed to start server', {
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
