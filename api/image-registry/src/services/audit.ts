// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditClient } from '@pipeline-builder/api-core';
import type { RemoteAuditClient, RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the image-registry service.
 *
 * Mirrors api/pipeline: the registry's destructive surface — application-level
 * GC sweeps (`registry.gc`) and explicit image/tag deletes
 * (`registry.image.delete`) — plus denied-authorization attempts
 * (`authz.denied`) are pushed into platform's `POST /audit/events` ingest
 * (authenticated via a service-to-service JWT) so these data-loss / probing
 * events are traceable long after the request logs lapse. Previously the delete
 * paths only wrote a structured log line (`emitAudit` → winston) that a log-
 * retention window eventually rolled off.
 *
 * Emission is FIRE-AND-FORGET: `RemoteAuditClient.record` never throws and is
 * not awaited, so a flaky audit downstream can never fail or delay the
 * originating mutation. Call sites MUST emit only AFTER the mutation succeeds.
 */
let auditClient: RemoteAuditClient | null = null;

/** Lazily-constructed module singleton, matching api/pipeline's accessor. */
export function getAuditClient(): RemoteAuditClient {
  if (!auditClient) auditClient = createRemoteAuditClient();
  return auditClient;
}

/**
 * Emit an attributed image-registry audit event. Thin wrapper that bakes in the
 * `'image-registry'` service principal so call sites stay terse. Best-effort —
 * never blocks or throws. Keep `details` free of secrets/tokens and AWS account
 * ids.
 */
export function emitImageRegistryAudit(event: RemoteAuditEvent): void {
  getAuditClient().record(event, 'image-registry');
}
