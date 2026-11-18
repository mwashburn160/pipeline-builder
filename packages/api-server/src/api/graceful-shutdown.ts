// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Server } from 'http';
import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { setReady } from './readiness.js';
import { shutdownTracing } from './tracing.js';

const logger = createLogger('shutdown');

/** One teardown step. A throw/rejection is logged and the next step still runs. */
export type ShutdownHook = () => void | Promise<void>;

export interface GracefulShutdownOptions {
  /** The listening HTTP server to drain. */
  server: Server;
  /** Service name, for logs. */
  name?: string;
  /** Force-exit (code 1) after this long. Default 15000. */
  timeoutMs?: number;
  /** Run after the readiness flip, BEFORE server.close (e.g. close SSE streams so close() can finish). */
  beforeClose?: ShutdownHook[];
  /** Run after server.close has drained in-flight requests, before tracing flush + exit (stop sweeps, close datastores). */
  onStop?: ShutdownHook[];
  /** Signals to install on. Default SIGTERM + SIGINT; `[]` installs none (call `shutdown` yourself). */
  signals?: NodeJS.Signals[];
}

export interface GracefulShutdownHandle {
  /** Trigger shutdown (idempotent — only the first call does anything). */
  shutdown: (signal?: string) => Promise<void>;
  /** True once shutdown has begun. */
  isShuttingDown: () => boolean;
  /** Remove the signal listeners this installed (tests). */
  uninstall: () => void;
}

async function runHooks(phase: string, hooks: ShutdownHook[]): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      logger.error(`Error in ${phase} shutdown hook`, { error: errorMessage(error) });
    }
  }
}

/**
 * The fleet's ONE graceful-shutdown routine (api-server's `startServer` and
 * platform's entrypoint both use it):
 *
 * 1. Re-entry guard — a second SIGTERM/SIGINT while draining is a no-op. The
 *    listeners stay installed (`on`, not `once`) so a second signal is absorbed
 *    instead of falling through to Node's default "terminate now".
 * 2. Readiness flips NotReady FIRST, so the load balancer / readiness probe stops
 *    sending new work while the rest runs.
 * 3. The force-exit timer is armed BEFORE awaiting anything (a hung hook can't
 *    make the pod ignore SIGTERM until SIGKILL) and unref'd (it never itself
 *    keeps the process alive).
 * 4. `beforeClose` hooks, then `server.close` (waits for in-flight requests),
 *    then `onStop` hooks, then `await shutdownTracing()` so the final spans —
 *    including those of the teardown itself — are exported, then `exit(0)`.
 */
export function installGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdownHandle {
  const {
    server,
    name = 'service',
    timeoutMs = 15_000,
    beforeClose = [],
    onStop = [],
    signals = ['SIGTERM', 'SIGINT'],
  } = options;

  let shuttingDown = false;

  const shutdown = async (signal?: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    setReady(false);
    logger.info(signal ? `${name}: ${signal} received, shutting down gracefully...` : `${name}: shutting down gracefully...`);

    const forceExit = setTimeout(() => {
      logger.error(`${name}: forced shutdown after ${timeoutMs}ms timeout`);
      process.exit(1);
    }, timeoutMs);
    forceExit.unref();

    await runHooks('beforeClose', beforeClose);

    // A close error (server already stopped) must not skip the teardown.
    await new Promise<void>((resolve) => server.close((err) => {
      if (err) logger.warn(`${name}: server.close reported`, { error: errorMessage(err) });
      else logger.info(`${name}: HTTP server closed`);
      resolve();
    }));

    await runHooks('onStop', onStop);

    await shutdownTracing().catch((error) => logger.error('Error shutting down tracing', { error: errorMessage(error) }));

    // Finished in time: the force-exit must not fire later (it would turn a
    // clean exit into exit(1) wherever exit() returns, e.g. under a test spy).
    clearTimeout(forceExit);
    process.exit(0);
  };

  const listeners = signals.map((sig) => {
    const listener = (): void => { void shutdown(sig); };
    process.on(sig, listener);
    return [sig, listener] as const;
  });

  return {
    shutdown,
    isShuttingDown: () => shuttingDown,
    uninstall: () => {
      for (const [sig, listener] of listeners) process.removeListener(sig, listener);
    },
  };
}
