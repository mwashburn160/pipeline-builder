// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Logger } from 'winston';
import { createLogger } from './logger';

let installed = false;

/**
 * Install last-resort process-level fault handlers.
 *
 * Without these, an uncaught exception or an unhandled promise rejection in a
 * fire-and-forget async path crashes the container with NO structured log line
 * (and on modern Node terminates the process by default). That makes incidents
 * undebuggable from logs. This logs the fault through the service logger, then
 * exits non-zero so the orchestrator restarts a CLEAN process — a faulted
 * process is in an undefined state and must not keep serving.
 *
 * This is orthogonal to graceful SIGTERM shutdown (handled in api-server /
 * platform): that drains on a normal stop; this is the abnormal-fault path.
 *
 * Idempotent — call once at process start; repeat calls are no-ops. Skipped
 * under NODE_ENV=test so it never competes with the test runner's own handlers.
 */
export function installCrashHandlers(log: Logger = createLogger('process')): void {
  if (installed || process.env.NODE_ENV === 'test') return;
  installed = true;

  const fatal = (kind: string, error: Error, extra: Record<string, unknown> = {}): void => {
    log.error(`${kind} — exiting for restart`, { error: error.message, stack: error.stack, ...extra });
    // Give winston a tick to flush async transports, then exit. `unref` so this
    // timer never keeps an otherwise-idle process alive.
    setTimeout(() => process.exit(1), 100).unref();
  };

  process.on('uncaughtException', (error: Error, origin: string) => fatal('Uncaught exception', error, { origin }));
  process.on('unhandledRejection', (reason: unknown) => {
    fatal('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
  });
}
