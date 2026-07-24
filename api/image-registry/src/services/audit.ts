// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createServiceAuditClient } from '@pipeline-builder/api-core';
import type { RemoteAuditClient, RemoteAuditEvent, ServiceAuditClient } from '@pipeline-builder/api-core';

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
let audit: ServiceAuditClient | null = null;

/** Lazily-constructed module singleton, matching api/pipeline's accessor. */
function svc(): ServiceAuditClient {
  if (!audit) audit = createServiceAuditClient('image-registry');
  return audit;
}

/** The underlying spool-backed remote client — passed to `wireAuthzDenialAuditor`
 *  and called directly by route files via `getAuditClient().record(...)`. */
export function getAuditClient(): RemoteAuditClient {
  return svc().client;
}

/**
 * Emit an attributed image-registry audit event. Thin wrapper that bakes in the
 * `'image-registry'` service principal so call sites stay terse. Best-effort —
 * never blocks or throws. Keep `details` free of secrets/tokens and AWS account
 * ids.
 */
export function emitImageRegistryAudit(event: RemoteAuditEvent): void {
  svc().emit(event);
}
