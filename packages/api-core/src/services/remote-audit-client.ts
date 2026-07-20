// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { createSafeClient, type RequestOptions } from './http-client.js';
import { getServiceAuthHeader } from '../middleware/auth.js';
import type { ServiceConfig } from '../types/common.js';
import { createLogger } from '../utils/logger.js';

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
 * Subset of platform's AuditAction enum that non-platform services emit.
 * Kept in sync manually with platform/src/models/audit-event.ts; mismatched
 * actions are rejected by the platform ingest endpoint (400) so a drift is
 * visible in logs rather than silently dropped.
 */
export type RemoteAuditAction =
  | 'plugin.build.completed'
  | 'plugin.build.failed'
  | 'plugin.build.timeout'
  // Plugin lifecycle mutations (api/plugin route handlers) — the destructive /
  // publishing surface that builds already audit's counterpart: registry delete,
  // source upload, and deploy-to-cluster. `targetId` is the plugin id.
  | 'plugin.delete'
  | 'plugin.upload'
  | 'plugin.deploy'
  // Pipeline mutations — emitted by api/pipeline's route handlers
  // (create/update/delete + CodePipeline execution trigger/cancel) and
  // posted to platform's `POST /audit/events` ingest.
  | 'pipeline.create'
  | 'pipeline.update'
  | 'pipeline.delete'
  | 'pipeline.execution.start'
  | 'pipeline.execution.cancel'
  // Quota administration (api/quota) — a superadmin resetting an org's usage
  // counter or editing its tier limits. `affectedOrgId` is the org changed;
  // `details` carries the quotaType + old/new value.
  | 'quota.reset'
  | 'quota.limit.update'
  // Compliance rule administration (api/compliance) — approving an exemption
  // request, toggling a rule active/inactive, or cancelling a running scan.
  // `targetId` is the rule/exemption/scan id.
  | 'compliance.exemption.approve'
  | 'compliance.rule.toggle'
  | 'compliance.scan.cancel'
  // Image-registry destructive ops (api/image-registry) — garbage-collection
  // sweeps and explicit image/tag deletes (previously only a log line).
  | 'registry.gc'
  | 'registry.image.delete'
  // Denied authorization attempt — emitted best-effort by the shared
  // `requirePermission` / `requireSystemAdmin` gate when a state-changing
  // (non-GET) request is rejected, so probing/escalation attempts are visible
  // rather than invisible. `details` carries the required permission + path;
  // `outcome` is 'failure'.
  | 'authz.denied';

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
   * downstream.
   */
  record(event: RemoteAuditEvent, serviceName: string): void;
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

  return {
    record(event, serviceName) {
      const authHeader = getServiceAuthHeader({ serviceName, orgId: event.orgId, role: 'member' });
      // Strip the `Bearer ` prefix for InternalHttpClient  it sets the
      // Authorization header itself; the value here is raw.
      // A stable per-emission Idempotency-Key makes this non-idempotent POST
      // retry-safe in the http-client (so transient 5xx/timeout/429 are retried
      // rather than dropped) and lets the platform ingest dedup a re-delivered
      // event instead of writing a duplicate audit row. Generated once here so
      // every retry of THIS emission reuses the same key.
      const headers: Record<string, string> = {
        'Authorization': authHeader,
        'Idempotency-Key': randomUUID(),
      };
      // Path is /audit/events  the platform mounts the audit router under
      // /audit, and the internal ingest endpoint lives at /events under that.
      client.post('/audit/events', event, { headers, ...AUDIT_REQUEST_OPTIONS })
        .then((response) => {
          if (!response || response.statusCode !== 200) {
            logger.warn('Remote audit ingest non-ok', {
              action: event.action, statusCode: response?.statusCode,
            });
          }
        })
        .catch((err: unknown) => {
          logger.warn('Remote audit ingest threw', {
            action: event.action,
            error: err instanceof Error ? err.message: String(err),
          });
        });
    },
  };
}
