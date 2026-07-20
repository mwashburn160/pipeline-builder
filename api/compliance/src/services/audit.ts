// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditClient } from '@pipeline-builder/api-core';
import type { RemoteAuditClient, RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the compliance service.
 *
 * Mirrors api/pipeline's audit helper: the compliance route handlers push
 * attributed `compliance.*` events into platform's `POST /audit/events` ingest
 * (authenticated via a service-to-service JWT) so that the security-relevant
 * rule-administration mutations — exemption approval, enforced-rule activation
 * toggling, and scan cancellation — stay traceable after the request logs
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
 * Emit an attributed compliance audit event. Thin wrapper that bakes in the
 * `'compliance'` service principal so call sites stay terse. Best-effort —
 * never blocks or throws. Keep `details` free of secrets/tokens and AWS
 * account ids.
 */
export function emitComplianceAudit(event: RemoteAuditEvent): void {
  getAuditClient().record(event, 'compliance');
}
