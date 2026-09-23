// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { auditSpoolKey, createEnvRedisAuditSpool, type AuditSpool, type AuditSpoolEntry } from './audit-spool.js';
import { createSafeClient, type RequestOptions } from './http-client.js';
import { setAuthzDenialAuditor, type AuthzDenialInfo } from '../middleware/permission-gates.js';
import { getServiceAuthHeader } from '../middleware/service-tokens.js';
import type { ServiceConfig } from '../types/common.js';
import { type RemoteAuditAction } from '../types/remote-audit-actions.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';
import { serviceEndpoint } from '../utils/service-registry.js';

const logger = createLogger('remote-audit');

/**
 * Audit ingest is best-effort and MUST NOT block the caller, but a transient
 * failure (429 / 5xx / connection reset / timeout) should not silently drop the
 * row on the first attempt. Each emission carries a stable per-event
 * `Idempotency-Key` (see `record`), so the http-client treats the POST as
 * retry-safe and the platform can dedup a retried delivery instead of writing a
 * duplicate row. Budget is kept small so a hard-down platform can't back the
 * worker up for long: base delay ×(2 retries) + a couple of 429 backoffs.
 */
const AUDIT_REQUEST_OPTIONS: Pick<RequestOptions, 'maxRateLimitRetries' | 'maxRetries'> = {
  maxRateLimitRetries: 2,
  maxRetries: 2,
};

export interface RemoteAuditEvent {
  action: RemoteAuditAction;
  actorId: string;
  actorEmail?: string;
  orgId?: string;
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
  /**
   * Did the audited action succeed or fail? Defaults to 'success' when omitted
   * (the platform ingest applies the same default). Denied-authz events set
   * 'failure' so a reviewer can filter attempts from completed actions.
   */
  outcome?: 'success' | 'failure';
  /**
   * When the audited action actually OCCURRED (ISO-8601), stamped at emission.
   * The platform stores this for reviewers; it is NOT the chain-ordering field
   * (the tamper-evident chain orders by ingest/`createdAt`). It matters for
   * SPOOLED events: one buffered during a platform outage is re-delivered — and
   * so chained — later, but `occurredAt` preserves when it really happened.
   */
  occurredAt?: string;
  /**
   * Stable per-emission dedup key (also sent as the `Idempotency-Key` header the
   * platform ingest dedups on). Stamped by `record()` and carried on the spooled
   * copy so a live attempt and its later re-delivery collapse to ONE stored row.
   */
  idempotencyKey?: string;
  details?: Record<string, unknown>;
}

/**
 * Client for POSTing audit events to the platform's `/audit-events` ingest
 * endpoint. Mints a fresh service token per call (5 min TTL)  there's no
 * meaningful caching benefit when emissions are sparse.
 */
export interface RemoteAuditClient {
  /**
   * Fire-and-forget audit emission. Failures are logged at warn level but
   * never thrown  the originating action (e.g. a plugin build) has its
   * own success/failure path that shouldn't get polluted by a flaky audit
   * downstream. When a {@link AuditSpool} is configured, an emission that
   * exhausts its live retries is buffered and re-delivered later instead of
   * being dropped.
   */
  record(event: RemoteAuditEvent, serviceName: string): void;
  /** Stop the background spool-drain timer (if any). Safe to call repeatedly. */
  close(): void;
}

/**
 * Configuration for the remote audit client.
 */
export interface RemoteAuditClientConfig {
  /** Platform service host (default: env PLATFORM_SERVICE_HOST or 'platform') */
  host?: string;
  /** Platform service port (default: env PLATFORM_SERVICE_PORT or 3000) */
  port?: number;
  /** Request timeout ms (default 3000  audit shouldn't block the worker). */
  timeout?: number;
  /**
   * Optional durable buffer. When set, an emission that exhausts its live retry
   * budget (sustained platform outage) is spooled and re-delivered — on the next
   * successful emission and on a periodic timer — instead of being lost.
   */
  spool?: AuditSpool;
  /** Spool-drain interval ms (default 30_000). Only used when `spool` is set. */
  drainIntervalMs?: number;
  /** Max entries drained per sweep (default 100). */
  drainBatchSize?: number;
}

/**
 * Construct a remote-audit client targeted at the platform service.
 *
 * Used by api/plugin's build worker to push `plugin.build.*` events into
 * the platform's MongoDB `audit_events` collection. Other services
 * with worker-style emitters can use the same client.
 *
 * @example
 * ```typescript
 * const auditClient = createRemoteAuditClient();
 * auditClient.record({
 * action: 'plugin.build.completed',
 * actorId: 'user-123',
 * orgId: 'org-acme',
 * targetType: 'plugin',
 * targetId: 'plugin-abc',
 * details: { name: 'my-plugin', version: '1.0.0' },
 * }, 'plugin');
 * ```
 */
export function createRemoteAuditClient(config: RemoteAuditClientConfig = {}): RemoteAuditClient {
  const serviceConfig: ServiceConfig = {
    host: config.host ?? serviceEndpoint('platform').host,
    port: config.port ?? serviceEndpoint('platform').port,
    timeout: config.timeout ?? 3000,
  };
  // Its own breaker route class: audit ingest failing (5xx while platform's
  // audit store is degraded) must not open the breaker that platform's JWKS and
  // key-exchange calls ride on — that would turn an audit brownout into an auth
  // outage in every service.
  const client = createSafeClient(serviceConfig, { breakerClass: 'audit' });
  const spool = config.spool;
  const drainBatchSize = config.drainBatchSize ?? 100;

  /**
   * Attempt ONE live delivery. Resolves `true` on a 2xx accept, `false` on any
   * non-2xx / thrown error (the http-client has already applied the retry
   * budget). A stable per-emission `Idempotency-Key` makes this non-idempotent
   * POST retry-safe and lets the platform ingest dedup a re-delivered event
   * instead of writing a duplicate audit row (and duplicate chain link).
   * `Idempotency-Key` is derived from the event so a SPOOLED re-delivery reuses
   * the same key as its original live attempt — the two collapse to one row.
   */
  async function deliver(event: RemoteAuditEvent, serviceName: string): Promise<boolean> {
    try {
      // Minting the token is INSIDE the try on purpose. It can throw — the
      // signing key unreadable, not an EC P-256 key, or `SERVICE_NAME` not
      // matching this client's name. Outside the `try`, `deliver` would reject
      // instead of resolving `false`; `record` fires it with a bare `.then`, so
      // the rejection would go unhandled and crash-loop the pod on its first
      // audited write. Inside, a key problem is just an undeliverable event:
      // spooled, or dropped and metered.
      const authHeader = getServiceAuthHeader({ serviceName, orgId: event.orgId, role: 'member' });
      const headers: Record<string, string> = {
        'Authorization': authHeader,
        'Idempotency-Key': event.idempotencyKey ?? randomUUID(),
      };
      const response = await client.post('/audit/events', event, { headers, ...AUDIT_REQUEST_OPTIONS });
      const ok = !!response && response.statusCode >= 200 && response.statusCode < 300;
      if (!ok) {
        logger.warn('Remote audit ingest non-ok', { action: event.action, statusCode: response?.statusCode });
      }
      return ok;
    } catch (err) {
      logger.warn('Remote audit ingest threw', { action: event.action, error: errorMessage(err) });
      return false;
    }
  }

  // Serialize spool drains so a periodic tick and an on-success drain can't both
  // pull the same batch. Stops early the moment a re-delivery fails (platform
  // still down) so we don't hammer it or churn the buffer.
  let draining = false;
  async function drain(): Promise<void> {
    if (!spool || draining) return;
    draining = true;
    try {
      for (;;) {
        const batch = await spool.take(drainBatchSize);
        if (batch.length === 0) return;
        const delivered: AuditSpoolEntry[] = [];
        const failed: AuditSpoolEntry[] = [];
        let platformDown = false;
        for (const entry of batch) {
          if (platformDown) { failed.push(entry); continue; }
          const ok = await deliver(entry.event, entry.serviceName);
          if (ok) {
            delivered.push(entry);
            emitCounter('audit_spool_redelivered_total', { service: entry.serviceName });
          } else {
            platformDown = true;
            failed.push(entry);
          }
        }
        // Acknowledge the delivered prefix so it clears the in-progress list; the
        // reliable take() moved the whole batch there, so unacked survivors are
        // reclaimed by recover() after a crash rather than being silently lost.
        if (delivered.length > 0) await spool.ack(delivered);
        if (failed.length > 0) {
          await spool.requeue(failed);
          return; // still down — try again on the next tick
        }
      }
    } catch (err) {
      logger.warn('Audit spool drain failed', { error: errorMessage(err) });
    } finally {
      draining = false;
    }
  }

  let drainTimer: ReturnType<typeof setInterval> | undefined;
  if (spool) {
    // Reclaim any batch stranded on the in-progress list by a prior crash, then
    // attempt to flush it. Both are best-effort (the spool swallows its errors).
    void spool.recover().then(() => drain());
    // Every tick: heartbeat (so peers never reclaim a batch this pod is still
    // delivering — even mid-drain), reclaim batches of pods that died, drain.
    drainTimer = setInterval(() => {
      void spool.heartbeat().then(() => spool.recover()).then(() => drain());
    }, config.drainIntervalMs ?? 30_000);
    // Don't let the drain timer keep the process alive on shutdown.
    (drainTimer as unknown as { unref?: () => void }).unref?.();
  }

  return {
    record(event, serviceName) {
      // Stamp when the action actually occurred (survives spool delay) and pin a
      // stable idempotency key so a live attempt and its spooled retry dedup.
      const stamped: RemoteAuditEvent = {
        ...event,
        occurredAt: event.occurredAt ?? new Date().toISOString(),
        idempotencyKey: event.idempotencyKey ?? randomUUID(),
      };
      void deliver(stamped, serviceName).then((ok) => {
        if (ok) {
          emitCounter('audit_emitted_total', { service: serviceName, outcome: stamped.outcome ?? 'success' });
          if (spool) void drain(); // platform is reachable — flush any backlog
        } else if (spool) {
          void spool.enqueue({ event: stamped, serviceName });
        } else {
          emitCounter('audit_dropped_total', { service: serviceName });
        }
      }).catch((err) => {
        // Belt and braces. `deliver` never rejects, but anything that throws
        // in the continuation would otherwise become an unhandled rejection —
        // and in this process that is a crash, not a log line. An audit event
        // must never take the service down.
        emitCounter('audit_dropped_total', { service: serviceName });
        logger.error('Remote audit record failed unexpectedly', { action: stamped.action, error: errorMessage(err) });
      });
    },
    close() {
      if (drainTimer) { clearInterval(drainTimer); drainTimer = undefined; }
    },
  };
}

/**
 * Register the standard `authz.denied` sink used by every remote-audit service
 * (pipeline, plugin, compliance, quota, message, billing, reporting, …).
 *
 * The shared `requireAuth` gate forwards each DENIED state-changing request to
 * the auditor set via {@link setAuthzDenialAuditor}; this wires that hook to the
 * service's {@link RemoteAuditClient}, forwarding a `failure`-outcome
 * `authz.denied` event so probing / privilege-escalation attempts leave a trail.
 * Emission is fire-and-forget (the client never throws). `getClient` is a getter
 * so the client stays lazily constructed (services memoize it on first use).
 *
 * Platform is intentionally NOT a caller — it is the audit authority and writes
 * `authz.denied` straight to its local store (with `affectedOrgId`), not through
 * a RemoteAuditClient.
 */
export function wireAuthzDenialAuditor(serviceName: string, getClient: () => RemoteAuditClient): void {
  setAuthzDenialAuditor((info: AuthzDenialInfo) => getClient().record({
    action: 'authz.denied',
    actorId: info.actorId ?? 'anonymous',
    actorEmail: info.actorEmail,
    orgId: info.orgId,
    outcome: 'failure',
    details: { method: info.method, path: info.path, required: info.required },
  }, serviceName));
}

/**
 * The process-wide remote-audit binding: which service this process is, and the
 * (lazily built) client its events go through. Bound ONCE at boot by
 * `wireServiceSecurity(serviceName)` — every stateless service calls it — so the
 * service identity is never repeated at a call site and can never drift.
 */
interface AuditBinding {
  serviceName: string;
  client: RemoteAuditClient | null;
}

let auditBinding: AuditBinding | null = null;

/**
 * Bind this process's service identity for {@link recordAudit}. Called by
 * `wireServiceSecurity`; tests go through `bindTestAuditService`
 * (`@pipeline-builder/api-core/testing`), which passes a spy `client`.
 *
 * Without `client`, the real one is built lazily on first emission: a
 * RemoteAuditClient wired to the durable env-Redis spool (null → no spool).
 * Lazy on purpose — building it at boot would force the spool's Redis connection
 * wherever the service module is merely imported. Rebinding closes the previous
 * client's spool-drain timer.
 */
export function bindAuditService(serviceName: string, client?: RemoteAuditClient): void {
  auditBinding?.client?.close();
  auditBinding = { serviceName, client: client ?? null };
}

/** Drop the binding (tests only — returns the process to the unbound state). */
export function unbindAuditService(): void {
  auditBinding?.client?.close();
  auditBinding = null;
}

function boundAudit(): AuditBinding & { client: RemoteAuditClient } {
  if (!auditBinding) {
    throw new Error('audit not initialised: call wireServiceSecurity(serviceName) at boot before recordAudit()');
  }
  auditBinding.client ??= createRemoteAuditClient({
    spool: createEnvRedisAuditSpool({ key: auditSpoolKey(auditBinding.serviceName) }) ?? undefined,
  });
  return auditBinding as AuditBinding & { client: RemoteAuditClient };
}

/**
 * The bound service's RemoteAuditClient. Throws "audit not initialised" before
 * `wireServiceSecurity` has run. Internal: callers emit through
 * {@link recordAudit}; `wireServiceSecurity` hands this getter to the
 * `authz.denied` sink.
 */
export function getBoundAuditClient(): RemoteAuditClient {
  return boundAudit().client;
}

/**
 * Record an event in the durable, hash-chained central audit trail (platform's
 * `POST /audit/events` ingest), attributed to the service bound at boot.
 *
 * FIRE-AND-FORGET: delivery never blocks or throws — emit only AFTER the
 * mutation succeeds, and keep `details` free of secrets/tokens, PII and AWS
 * account ids. The ONE thing that throws is calling it before
 * `wireServiceSecurity(serviceName)` has bound the service: that is a wiring
 * bug, and failing loudly beats silently attributing the event to nobody.
 *
 * (The winston/Loki log line is a different sink: `logAuditEvent`.)
 */
export function recordAudit(event: RemoteAuditEvent): void {
  const { client, serviceName } = boundAudit();
  client.record(event, serviceName);
}
