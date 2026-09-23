// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { ANONYMOUS_ACTOR_ID, auditSpoolKey, createEnvRedisAuditSpool, createLogger, emitCounter, errorMessage, type AuditSpool, type RemoteAuditEvent } from '@pipeline-builder/api-core';
import { currentTraceId } from '@pipeline-builder/api-server';
import type { Request } from 'express';
import { appendAuditEvent } from './audit-chain.js';
import { type AuditAction } from '../models/audit-event.js';
import type { AuditCreateInput } from '../services/audit-service.js';

const logger = createLogger('audit');

/** Max stored User-Agent length — a hostile/oversized UA header shouldn't
 *  bloat audit documents. 512 covers every legitimate browser/CLI UA. */
const MAX_USER_AGENT_LEN = 512;

/** Control characters (C0 + DEL + C1) replaced before storage so the value
 *  can't inject into the audit UI / CSV export when later rendered. Built
 *  from a string (not a regex literal) to keep the source ASCII-only. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

/**
 * Sanitize a raw User-Agent header for storage: strip control characters
 * (defends the UI/CSV export against injection when the value is later
 * rendered) and truncate. Returns undefined for missing/empty input.
 */
function sanitizeUserAgent(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const cleaned = raw.replace(CONTROL_CHARS, ' ').trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_USER_AGENT_LEN);
}

/**
 * Record an audit event (fire-and-forget — never blocks the request).
 *
 * @param req - Express request (used to extract actor, IP, and request/trace
 *              correlation context)
 * @param action - Audit action identifier
 * @param options - Optional target, details, `affectedOrgId` for cross-tenant
 *                  operations, `roleId`, and `outcome`
 *
 * Tracing + identity context (`requestId`, `traceId`, `actorRole`,
 * `impersonatorId`, `userAgent`) is captured centrally here so the ~45 call
 * sites don't repeat the boilerplate — every audited action inherits it.
 *
 * Pass `affectedOrgId` whenever the action touches an org that is NOT the
 * actor's own (e.g. a sysadmin acting on org X's user/data). When omitted,
 * it defaults to the actor's `orgId`, so normal in-org operations don't have
 * to repeat the boilerplate.
 */
export function audit(
  req: Request,
  action: AuditAction,
  options: {
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
    /** Override when the action affects a different org than the actor's
     *  (sysadmin acting on another org). Defaults to the actor's own org. */
    affectedOrgId?: string;
    /** Permission role involved (org.role.* actions). Stored as a
     *  first-class, indexed field rather than buried in `details`. */
    roleId?: string;
    /** Did the action succeed? Defaults to 'success'; pass 'failure' on
     *  failure paths (e.g. login.failed) so reviewers can filter outcomes. */
    outcome?: 'success' | 'failure';
  } = {},
): void {
  const actorOrgId = req.user?.organizationId;
  // requestId: prefer the nginx-propagated `x-request-id`; fall back to a
  // fresh uuid so service-to-service / test / non-nginx calls still get a
  // correlation key (the field is never empty).
  const rawRequestId = req.headers['x-request-id'];
  const requestId = (Array.isArray(rawRequestId) ? rawRequestId[0] : rawRequestId) || randomUUID();
  const { targetType, targetId, details, affectedOrgId, roleId, outcome } = options;

  const event = {
    action,
    actorId: req.user?.sub || ANONYMOUS_ACTOR_ID,
    actorEmail: req.user?.email,
    actorRole: req.user?.role,
    orgId: actorOrgId,
    affectedOrgId: affectedOrgId ?? actorOrgId,
    targetType,
    targetId,
    roleId,
    impersonatorId: req.user?.impersonatorId,
    outcome: outcome ?? 'success',
    details,
    ip: req.ip,
    userAgent: sanitizeUserAgent(req.headers['user-agent']),
    requestId,
    traceId: currentTraceId(),
  };

  recordAuditEvent({
    ...event,
    // Stable per-emission key so a spooled retry of an append that actually
    // committed (e.g. a timeout after the write) dedups instead of doubling.
    idempotencyKey: randomUUID(),
  });
}

// ---------------------------------------------------------------------------
// Durable local delivery
//
// Platform writes its own audit events straight to Mongo. A write that fails
// (Mongo blip, failover, chain-slot contention exhausted) must not be DROPPED —
// for a security log that is the wrong failure mode. Failed events go to the
// same bounded, crash-safe Redis spool the remote-audit client
// uses (own key), and a background drain re-appends them.
// ---------------------------------------------------------------------------

/** Spool key for platform-local audit events (distinct from any service's). */
export const LOCAL_AUDIT_SPOOL_KEY = auditSpoolKey('platform-local');

let localSpool: AuditSpool | null | undefined;

function getLocalSpool(): AuditSpool | null {
  if (localSpool === undefined) localSpool = createEnvRedisAuditSpool({ key: LOCAL_AUDIT_SPOOL_KEY });
  return localSpool;
}

/** Test seam: inject (or clear with `undefined`) the local spool. */
export function setLocalAuditSpoolForTest(spool: AuditSpool | null | undefined): void {
  localSpool = spool;
}

/** Wire shape of a spooled local event — dates travel as ISO strings. The spool
 *  entry type is the remote-audit event; a local entry reuses the envelope. */
type SpooledLocalEvent = Omit<AuditCreateInput, 'occurredAt'> & { occurredAt?: string };

async function spoolLocalEvent(event: AuditCreateInput, occurredAt: Date): Promise<void> {
  const spool = getLocalSpool();
  if (!spool) {
    emitCounter('audit_local_dropped_total', { action: event.action });
    logger.error('Audit event DROPPED — write failed and no spool is configured (REDIS_URL/REDIS_SENTINELS unset)', {
      action: event.action,
    });
    return;
  }
  const wire: SpooledLocalEvent = { ...event, occurredAt: (event.occurredAt ?? occurredAt).toISOString() };
  await spool.enqueue({ event: wire as unknown as RemoteAuditEvent, serviceName: 'platform' });
}

/**
 * Durably record an audit event from platform code that has no response to
 * fail (request handlers via `audit()`, background sweeps, the authz-denial
 * sink). Fire-and-forget: returns immediately; a failed append is spooled and
 * retried by {@link drainLocalAuditSpool}.
 */
export function recordAuditEvent(event: AuditCreateInput): void {
  const occurredAt = new Date();
  appendAuditEvent(event).catch((err) => {
    logger.warn('Audit write failed; spooling for retry', { action: event.action, error: errorMessage(err) });
    void spoolLocalEvent(event, occurredAt).catch(() => undefined);
  });
}

/** Outcome of one drain pass. */
export interface LocalSpoolDrainResult {
  delivered: number;
  failed: number;
}

/**
 * One drain tick: refresh this pod's spool-owner heartbeat, reclaim entries
 * stranded in flight by an owner whose heartbeat went stale (a crashed pod —
 * not only at boot, since the pod that crashed may never come back), then
 * re-append up to `max` spooled local events. Delivered entries are acked,
 * failures returned to the head of the spool (retried next pass). Never throws.
 */
export async function drainLocalAuditSpool(max = 200): Promise<LocalSpoolDrainResult> {
  const result: LocalSpoolDrainResult = { delivered: 0, failed: 0 };
  const spool = getLocalSpool();
  if (!spool) return result;
  await spool.heartbeat();
  // Reclaim entries left in flight by owners whose heartbeat is stale.
  await spool.recover();
  const batch = await spool.take(max);
  if (batch.length === 0) return result;
  const delivered: typeof batch = [];
  const failed: typeof batch = [];
  for (const entry of batch) {
    const wire = entry.event as unknown as SpooledLocalEvent;
    try {
      await appendAuditEvent({ ...wire, ...(wire.occurredAt ? { occurredAt: new Date(wire.occurredAt) } : {}) } as AuditCreateInput);
      delivered.push(entry);
    } catch (err) {
      logger.warn('Spooled audit re-append failed (requeued)', { action: wire.action, error: errorMessage(err) });
      failed.push(entry);
    }
  }
  await spool.ack(delivered);
  await spool.requeue(failed);
  result.delivered = delivered.length;
  result.failed = failed.length;
  if (result.delivered > 0) emitCounter('audit_local_redelivered_total', {}, result.delivered);
  return result;
}
