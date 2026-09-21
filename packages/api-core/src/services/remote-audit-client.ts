// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { createEnvRedisAuditSpool, type AuditSpool, type AuditSpoolEntry } from './audit-spool.js';
import { createSafeClient, type RequestOptions } from './http-client.js';
import { getServiceAuthHeader, setAuthzDenialAuditor, type AuthzDenialInfo } from '../middleware/auth.js';
import type { ServiceConfig } from '../types/common.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage } from '../utils/response.js';

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

/**
 * The exact set of audit actions a NON-PLATFORM (remote) service is permitted to
 * emit through `POST /audit/events`. This is the SINGLE SOURCE — `RemoteAuditAction`
 * is derived from it, so the type and the runtime allow-list can never drift.
 *
 * SECURITY: platform's ingest validates `action` against this subset (via
 * {@link isRemoteAuditAction}), NOT the full platform `AuditAction` union — a
 * `service:*` token must not be able to forge platform-authority events
 * (`admin.superadmin.grant`, `org.ownership.transfer`, `user.login`, …). Keep
 * this list free of any platform-only action.
 */
export const REMOTE_AUDIT_ACTIONS = [
  'plugin.build.completed',
  'plugin.build.failed',
  'plugin.build.timeout',
  // Plugin lifecycle mutations (api/plugin route handlers) — the destructive /
  // publishing surface that builds already audit's counterpart: registry delete,
  // source upload, and deploy-to-cluster. `targetId` is the plugin id.
  'plugin.delete',
  'plugin.restore',
  // Manual purge: permanent hard-delete of a soft-deleted plugin tombstone on
  // demand (finalizes what the retention sweep would otherwise do later).
  'plugin.purge',
  'plugin.update',
  'plugin.upload',
  'plugin.deploy',
  // Plugin bulk mutations (api/plugin bulk-plugin route) + DLQ purge (drops all
  // dead-lettered build jobs, cross-org, sysadmin). `details` carries counts.
  'plugin.bulk.update',
  'plugin.bulk.delete',
  'plugin.dlq.purge',
  // Build re-runs from the queue-triage surface: re-enqueue a FAILED build
  // (`plugin.build.retry`) or a dead-lettered one (`plugin.dlq.replay`). Both
  // re-run an image build + plugin persist on the caller's authority, so they
  // are audited mutations; `affectedOrgId` carries the job's owning org.
  'plugin.build.retry',
  'plugin.dlq.replay',
  // Pipeline mutations — emitted by api/pipeline's route handlers
  // (create/update/delete + CodePipeline execution trigger/cancel) and
  // posted to platform's `POST /audit/events` ingest.
  'pipeline.create',
  'pipeline.update',
  'pipeline.delete',
  'pipeline.restore',
  // Manual purge: permanent hard-delete of a soft-deleted pipeline /
  // pipeline_template tombstone on demand (finalizes what the retention sweep
  // would otherwise do later). `targetId` is the purged id.
  'pipeline.purge',
  'pipeline_template.create',
  'pipeline_template.update',
  'pipeline_template.delete',
  'pipeline_template.restore',
  'pipeline_template.purge',
  'pipeline.execution.start',
  'pipeline.execution.cancel',
  // CodePipeline ARN-registry config (api/pipeline registry route) — registering /
  // deregistering the external CodePipeline that backs a pipeline (deploy-affecting).
  'pipeline.registry.register',
  'pipeline.registry.deregister',
  // Quota administration (api/quota) — a superadmin resetting an org's usage
  // counter or editing its tier limits. `affectedOrgId` is the org changed;
  // `details` carries the quotaType + old/new value.
  'quota.reset',
  'quota.limit.update',
  // A superadmin deleting an org's entire quota document.
  'quota.delete',
  // Compliance administration (api/compliance) — the enforcement-posture surface.
  // Approving/revoking an exemption, toggling/authoring/deleting a rule,
  // authoring/deleting a policy, managing scan schedules, applying a template,
  // or cancelling a running scan. `targetId` is the rule/policy/exemption/scan id.
  'compliance.exemption.approve',
  'compliance.exemption.revoke',
  'compliance.rule.toggle',
  'compliance.rule.create',
  'compliance.rule.update',
  'compliance.rule.delete',
  'compliance.rule.restore',
  // Manual on-demand hard-delete (PURGE) of a soft-deleted rule/policy tombstone —
  // the caller-initiated counterpart to the retention sweep's auto-purge. Destroys
  // the tombstone permanently, so it carries the durable, tamper-evident trail.
  'compliance.rule.purge',
  'compliance.policy.create',
  'compliance.policy.update',
  'compliance.policy.delete',
  'compliance.policy.restore',
  'compliance.policy.purge',
  'compliance.scan-schedule.create',
  'compliance.scan-schedule.update',
  'compliance.scan-schedule.delete',
  'compliance.template.apply',
  // Launching an org-wide re-evaluation (the counterpart to `.cancel`) — it
  // persists a scan and can block entities that passed before.
  'compliance.scan.create',
  'compliance.scan.cancel',
  // Per-org compliance notification settings: recipients + the outbound webhook
  // URL/secret. Bearer-equivalent config that redirects violation notices, so a
  // change carries the durable trail (never the secret itself).
  'compliance.notification-preference.update',
  // Image-registry destructive ops (api/image-registry) — garbage-collection
  // sweeps and explicit image/tag deletes (previously only a log line).
  'registry.gc',
  'registry.image.delete',
  // Cross-repo tag/image copy (api/image-registry POST /api/images/copy). A
  // cross-tenant copy moves data across customer boundaries, so it needs the
  // durable, tamper-evident trail — not just the Loki operator line.
  'registry.image.copy',
  // Messaging (api/message) — admin BROADCAST announcements + destructive
  // deletes. 1:1 user messages are intentionally NOT audited (noise + they would
  // pull private content into the trail). `details` carry metadata only
  // (subject/type/scope), NEVER message body content.
  'message.announcement.create',
  'message.delete',
  'message.restore',
  // Manual on-demand PURGE (permanent hard-delete) of an already-soft-deleted
  // message tombstone — the destructive finalizer the retention sweep would
  // otherwise perform at the purge deadline. `details` carry metadata only.
  'message.purge',
  // Billing (api/billing) — subscription + entitlement mutations, mirrored to the
  // central audit trail (these also write to the service-local billing_events
  // collection). `details` carry plan/tier/addon ids only — never card/payment
  // secrets or an AWS account id.
  // Subscription lifecycle a CUSTOMER drives (the admin counterpart is
  // `billing.tier.override`): self-serve create (direct or Marketplace claim),
  // plan/interval change, cancel-at-period-end, undo-cancel, cascade delete.
  'billing.subscription.create',
  'billing.subscription.update',
  'billing.subscription.reactivate',
  'billing.subscription.cancel',
  'billing.subscription.delete',
  'billing.tier.override',
  // Operator-only reseed of the invoice ledger from the payment provider's
  // history (POST /billing/admin/backfill) — mutates finance data fleet-wide.
  'billing.addon.add',
  'billing.addon.remove',
  // System-initiated removal of a tier-included add-on on a plan upgrade (the
  // account's new tier now bundles the feature) — distinct from a user-initiated
  // `remove` so finance can tell an auto-prune from a customer action.
  'billing.addon.prune',
  // Discounts (docs/billing-discounts.md) — mint/issue/apply/remove/revoke of a
  // price coupon or usage credit. `details` carry the discount id + kind/value
  // only, never the opaque token or signing key.
  'billing.discount.generate',
  'billing.discount.issue',
  'billing.discount.apply',
  'billing.discount.remove',
  'billing.discount.revoke',
  // Promotions (docs/billing-discounts.md#promotions) — rule-driven auto-grant
  // campaigns. `details` carry the promotion id + cents/event only.
  'billing.promotion.create',
  'billing.promotion.update',
  'billing.promotion.revoke',
  'billing.promotion.grant',
  'billing.promotion.activate',
  // Usage-credit realization — a customer/compliance-visible record of credit
  // movement: `consumed` (Marketplace metered drawdown), `exhausted` (balance hit
  // zero), and a combo ending. `details` carry cents/ids only, no payment secrets.
  'billing.credit.consumed',
  'billing.credit.exhausted',
  'billing.combo.expired',
  // Reporting (api/reporting) — the three reporting mutations whose effect
  // outlives a request log: the per-org correlation-window config write, a
  // post-deploy outcome marker (it moves the org's DORA CFR/MTTR), and the
  // inbound billing→reporting retention-entitlement sync (a retention cut is a
  // data-destroying change applied by the next sweep). `details` carry the
  // settings/outcome values only.
  'reporting.settings.update',
  'reporting.deployment.outcome',
  'reporting.retention.sync',
  // Denied authorization attempt — emitted best-effort by the shared
  // `requirePermission` / `requireSystemAdmin` gate when a state-changing
  // (non-GET) request is rejected, so probing/escalation attempts are visible
  // rather than invisible. `details` carries the required permission + path;
  // `outcome` is 'failure'.
  'authz.denied',
  // "Ask" assistant activity — visibility into what the assistant did on a user's
  // behalf. `ask.query` is a read-only how-to turn; `ask.agent.turn` is a tool-calling
  // turn. `details` carry SAFE METADATA ONLY (tools used, proposal kinds, query
  // length, outcome), never the raw query text.
  'ask.query',
  'ask.agent.turn',
] as const;

export type RemoteAuditAction = typeof REMOTE_AUDIT_ACTIONS[number];

/** Whether `value` is an action a remote service may emit (the ingest allow-list). */
export function isRemoteAuditAction(value: string): value is RemoteAuditAction {
  return (REMOTE_AUDIT_ACTIONS as readonly string[]).includes(value);
}

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
    host: config.host ?? process.env.PLATFORM_SERVICE_HOST ?? 'platform',
    port: config.port ?? parseInt(process.env.PLATFORM_SERVICE_PORT ?? '3000', 10),
    timeout: config.timeout ?? 3000,
  };
  const client = createSafeClient(serviceConfig);
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
      // matching this client's name — and it used to sit above the `try`, so
      // `deliver` rejected instead of resolving `false` as documented. `record`
      // fires it with a bare `.then` and no `.catch`, so the rejection went
      // unhandled, `runServer`'s crash handler exited, and the pod crash-looped
      // on its first audited write or `authz.denied` event. Now a key problem is
      // just an undeliverable event: spooled, or dropped and metered.
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
    drainTimer = setInterval(() => { void drain(); }, config.drainIntervalMs ?? 30_000);
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
        // Belt and braces. `deliver` no longer rejects, but anything that throws
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
 * A service-scoped audit client: a durable-spool-backed {@link RemoteAuditClient}
 * with the service name pre-bound for emission. Replaces the per-service
 * boilerplate of `createRemoteAuditClient({ spool: createEnvRedisAuditSpool() ?? undefined })`
 * plus a hand-rolled `emit<Service>Audit` wrapper that repeats the service name.
 */
export interface ServiceAuditClient {
  /** Emit an audit event with the service name bound. Fire-and-forget. */
  emit(event: RemoteAuditEvent): void;
  /** The underlying remote client — for `wireAuthzDenialAuditor` + `close()`. */
  readonly client: RemoteAuditClient;
}

/**
 * Build a service's audit client: a RemoteAuditClient wired to the durable Redis
 * spool (from ambient env; null → no spool) with `serviceName` bound. Construct
 * ONCE per process — memoize behind a lazy `getAuditClient()` in the service's
 * `services/audit.ts`. Pass `config.spool` to override the env-derived spool
 * (e.g. reuse a service's existing ioredis connection).
 */
export function createServiceAuditClient(serviceName: string, config: RemoteAuditClientConfig = {}): ServiceAuditClient {
  const spool = config.spool ?? createEnvRedisAuditSpool() ?? undefined;
  const client = createRemoteAuditClient({ ...config, spool });
  return {
    emit: (event) => client.record(event, serviceName),
    client,
  };
}

/**
 * Lazily-constructed remote-audit accessor for a service. Every service's
 * `services/audit.ts` used to hand-roll the same module singleton (a `let audit`
 * + `svc()` that builds a {@link ServiceAuditClient} on first use, then a
 * `getAuditClient()` returning `.client` and an `emit(event)` forwarding to
 * `.emit`). This packages that pattern in ONE place so each service's audit
 * wiring is a one-liner and can't drift.
 *
 * Lazy on purpose: the underlying client wires an env-Redis audit spool, so
 * building it at import time would force that connection wherever the module is
 * merely imported (e.g. tests). `getAuditClient` is passed to
 * `wireAuthzDenialAuditor`; `emit` backs the per-service `emitXAudit` helpers.
 * Both stay FIRE-AND-FORGET (record never throws / is not awaited).
 */
export function createRemoteAuditAccessor(serviceName: string): {
  getAuditClient: () => RemoteAuditClient;
  emit: (event: RemoteAuditEvent) => void;
} {
  let audit: ServiceAuditClient | null = null;
  const svc = (): ServiceAuditClient => {
    if (!audit) audit = createServiceAuditClient(serviceName);
    return audit;
  };
  return {
    getAuditClient: () => svc().client,
    emit: (event) => svc().emit(event),
  };
}
