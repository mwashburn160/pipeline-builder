// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Server } from 'http';
import { createLogger, errorMessage, installCrashHandlers } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { getConnection, closeConnection } from '@pipeline-builder/pipeline-data';
import type { Express } from 'express';
import { setReady, isReady } from './readiness.js';
import { shutdownTracing } from './tracing.js';
import { SSEManager } from '../http/sse-connection-manager.js';

const logger = createLogger('server');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Dependency-supervisor cadence. Initial connect retries with capped backoff;
// once connected, re-checks at a steady interval so a later outage flips the
// service NotReady (draining traffic) and a recovery flips it back — without
// ever exiting / restarting the process.
const READY_RETRY_BASE_MS = 1000;
const READY_RETRY_MAX_MS = 10000;
const READY_MONITOR_INTERVAL_MS = parseInt(process.env.READINESS_MONITOR_INTERVAL_MS || '15000', 10);

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
    let delay = READY_RETRY_BASE_MS;
    while (!aborted()) {
      try {
        await onBeforeStart();
        break;
      } catch (error) {
        logger.warn(`${name}: dependency init failed, retrying in ${delay}ms`, { error: errorMessage(error) });
        await sleep(delay);
        delay = Math.min(delay * 2, READY_RETRY_MAX_MS);
      }
    }
  }

  // No datastore to gate on → ready as soon as we are listening.
  if (testDatabase === false) {
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
      waitDelay = Math.min(waitDelay * 2, READY_RETRY_MAX_MS);
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

  logger.info(`Starting ${name}...`);

  // Mark NotReady synchronously, BEFORE the port opens, so no request slips
  // through the readiness guard before the supervisor has run. The supervisor
  // flips it true once dependencies connect.
  setReady(false);

  // Listen FIRST. Previously the process tested the DB and `process.exit(1)`'d
  // on failure (to be restarted), so during a cold-DB stampede services
  // crash-looped and never even opened their port. Now we open the port
  // immediately — /health (liveness), /ready (readiness) and the readiness
  // guard all respond at once — and establish + monitor the datastore in the
  // background, reporting NotReady until it connects instead of exiting.
  const server = app.listen(port, () => {
    logger.info(`${name} listening on port: ${port}`);
    logger.info(`Platform URL: ${serverConfig.platformUrl}`);
    onStart?.(port);
  });

  // Shutdown handler (guarded against concurrent signals)
  let shuttingDown = false;

  // Background dependency supervisor — established + monitored after listen,
  // stopped on shutdown so it never keeps a closing process alive. Guard the
  // floating promise: every expected failure is handled inside, so a rejection
  // here means a programming error — log it and leave the service NotReady
  // rather than letting it become an unhandledRejection that crash-exits the
  // process (which would defeat the whole "never exit on dependency trouble"
  // goal).
  superviseDependencies(name, onBeforeStart, testDatabase, () => shuttingDown).catch((error) => {
    logger.error('Dependency supervisor crashed; service will remain NotReady', { error: errorMessage(error) });
  });

  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (signal) {
      logger.info(`${signal} received, shutting down gracefully...`);
    }

    // Custom shutdown callback
    if (onShutdown) {
      try {
        await onShutdown();
      } catch (error) {
        logger.error('Error in onShutdown callback', { error });
      }
    }

    // Close SSE connections
    if (sseManager) {
      sseManager.shutdown();
      logger.info('SSE connections closed');
    }

    // Close HTTP server
    server.close(async () => {
      logger.info('HTTP server closed');

      // Shutdown OpenTelemetry tracing
      await shutdownTracing().catch(err => logger.error('Error shutting down tracing', { error: err }));

      // Close database connection
      if (closeDatabase !== false) {
        try {
          if (closeDatabase) {
            await closeDatabase();
          } else {
            await closeConnection();
          }
          logger.info('Database connection closed');
        } catch (error) {
          logger.error('Error closing database', { error });
        }
      }

      process.exit(0);
    });

    // Force shutdown after timeout
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, shutdownTimeoutMs).unref();
  };

  // Register signal handlers
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

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
  // Last-resort fault handlers for the production entrypoint: an unhandled
  // rejection / uncaught exception is logged (not silently fatal) then the
  // process exits for the orchestrator to restart. No-op under NODE_ENV=test.
  installCrashHandlers(logger);
  startServer(app, options).catch((error) => {
    // startServer now listens-first and supervises the DB in the background, so
    // it only rejects on a genuinely fatal SETUP error (invalid auth config, a
    // failed onStart, the port already in use). Log message + stack explicitly:
    // an Error in winston metadata serializes to `{}` (message/stack are
    // non-enumerable), which would otherwise hide the cause behind `{error:{}}`.
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
