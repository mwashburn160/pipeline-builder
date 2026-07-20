// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditClient } from '@pipeline-builder/api-core';
import type { RemoteAuditClient, RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the quota service.
 *
 * Mirrors api/pipeline's audit helper: the quota route handlers push attributed
 * `quota.*` events into platform's `POST /audit/events` ingest (authenticated
 * via a service-to-service JWT) so that the security-relevant superadmin
 * quota-administration mutations — resetting an org's usage counters and
 * editing its tier / limit overrides — stay traceable after the request logs
 * lapse. It also backs the `authz.denied` auditor registered at boot.
 *
 * Emission is FIRE-AND-FORGET: `RemoteAuditClient.record` never throws and is
 * not awaited, so a flaky audit downstream can never fail or delay the
 * originating mutation. Handlers MUST emit only AFTER the mutation succeeds.
 */
let auditClient: RemoteAuditClient | null = null;

/** Lazily-constructed module singleton, matching api/pipeline's accessor. */
export function getAuditClient(): RemoteAuditClient {
  if (!auditClient) auditClient = createRemoteAuditClient();
  return auditClient;
}

/**
 * Emit an attributed quota audit event. Thin wrapper that bakes in the
 * `'quota'` service principal so call sites stay terse. Best-effort — never
 * blocks or throws. Keep `details` free of secrets/tokens and AWS account ids
 * (numeric quota limits + quotaType are fine).
 */
export function emitQuotaAudit(event: RemoteAuditEvent): void {
  getAuditClient().record(event, 'quota');
}
