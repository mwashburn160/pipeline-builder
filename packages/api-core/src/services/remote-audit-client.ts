// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createSafeClient, RequestOptions } from './http-client';
import { getServiceAuthHeader } from '../middleware/auth';
import { ServiceConfig } from '../types/common';
import { createLogger } from '../utils/logger';

const logger = createLogger('remote-audit');

/** Tight retries  audit ingest is best-effort, never block the caller. */
const AUDIT_REQUEST_OPTIONS: Pick<RequestOptions, 'maxRateLimitRetries' | 'maxRetries'> = {
  maxRateLimitRetries: 0,
  maxRetries: 1,
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
  | 'plugin.build.timeout';

export interface RemoteAuditEvent {
  action: RemoteAuditAction;
  actorId: string;
  actorEmail?: string;
  orgId?: string;
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
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
      const authHeader = getServiceAuthHeader({ serviceName, orgId: event.orgId });
      // Strip the `Bearer ` prefix for InternalHttpClient  it sets the
      // Authorization header itself; the value here is raw.
      const headers: Record<string, string> = { Authorization: authHeader };
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
