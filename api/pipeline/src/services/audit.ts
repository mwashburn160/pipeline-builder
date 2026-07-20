// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditClient } from '@pipeline-builder/api-core';
import type { RemoteAuditClient, RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the pipeline service.
 *
 * Mirrors api/plugin's build worker: the pipeline route handlers push
 * attributed `pipeline.*` events into platform's `POST /audit/events` ingest
 * (authenticated via a service-to-service JWT) so that pipeline create /
 * update / delete and CodePipeline execution start / cancel — the most
 * security-relevant mutations the service performs — are traceable after the
 * request logs lapse.
 *
 * Emission is FIRE-AND-FORGET: `RemoteAuditClient.record` never throws and is
 * not awaited, so a flaky audit downstream can never fail or delay the
 * originating mutation. Handlers MUST emit only AFTER the mutation succeeds.
 */
let auditClient: RemoteAuditClient | null = null;

/** Lazily-constructed module singleton, matching api/plugin's accessor. */
export function getAuditClient(): RemoteAuditClient {
  if (!auditClient) auditClient = createRemoteAuditClient();
  return auditClient;
}

/**
 * Emit an attributed pipeline audit event. Thin wrapper that bakes in the
 * `'pipeline'` service principal so call sites stay terse. Best-effort — never
 * blocks or throws. Keep `details` free of secrets/tokens and AWS account ids.
 */
export function emitPipelineAudit(event: RemoteAuditEvent): void {
  getAuditClient().record(event, 'pipeline');
}
