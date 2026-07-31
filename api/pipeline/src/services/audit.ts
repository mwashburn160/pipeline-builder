// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';
import type { RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the pipeline service. Pipeline route handlers push attributed
 * `pipeline.*` events into platform's `POST /audit/events` ingest (service-to-
 * service JWT) so create/update/delete and CodePipeline execution start/cancel
 * — the most security-relevant mutations — are traceable after request logs
 * lapse. Emission is FIRE-AND-FORGET (`record` never throws / is not awaited);
 * handlers MUST emit only AFTER the mutation succeeds. See
 * `createRemoteAuditAccessor`.
 */
const accessor = createRemoteAuditAccessor('pipeline');

/** The spool-backed remote client — passed to `wireAuthzDenialAuditor` and
 *  called directly by route files via `getAuditClient().record(...)`. */
export const getAuditClient = accessor.getAuditClient;

/**
 * Emit an attributed pipeline audit event. Thin wrapper baking in the
 * `'pipeline'` service principal so call sites stay terse. Best-effort — never
 * blocks or throws. Keep `details` free of secrets/tokens and AWS account ids.
 */
export function emitPipelineAudit(event: RemoteAuditEvent): void {
  accessor.emit(event);
}
