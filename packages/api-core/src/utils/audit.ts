// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type winston from 'winston';
import type { AuditEvent } from '../types/audit-events.js';

/**
 * Emit a cross-service audit event as a structured log line.
 *
 * Best-effort: if the underlying logger transport fails, the caller's
 * mutation still succeeds — we never let audit-write failure roll back
 * the user-visible operation. The line is tagged `eventCategory: 'audit'`
 * so downstream log aggregators (Loki, CloudWatch) can route audit
 * events into a separate index.
 *
 * For platform's own audit events (user.login, org.create, …), use
 * platform's `helpers/audit.ts` instead — those persist to MongoDB.
 */
export function emitAudit(
  logger: winston.Logger,
  audit: AuditEvent,
): void {
  try {
    logger.info('audit', { eventCategory: 'audit', ...audit });
  } catch (err) {
    // The winston logger normally never throws synchronously, but if a
    // transport explodes during a route call, we don't want the mutation
    // to fail because the audit write didn't land.
    try {
      logger.warn('Failed to emit audit event', {
        event: audit.event,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Logger itself is unrecoverable — give up silently.
    }
  }
}
