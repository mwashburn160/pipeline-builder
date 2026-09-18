// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';
import type { RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Remote-audit wiring for the reporting service.
 *
 * A lazily-constructed `RemoteAuditClient` that pushes attributed events into
 * platform's `POST /audit/events` ingest (service-to-service JWT). Consumers are
 * the shared authz-denial-auditor wiring (`authz.denied`) and the three reporting
 * mutations whose effect outlives a request log: the per-org reporting settings
 * write, a post-deploy outcome marker (it moves DORA CFR/MTTR), and the inbound
 * billing→reporting retention-entitlement sync. Emission is fire-and-forget
 * (`record` never throws / is not awaited). See `createRemoteAuditAccessor`.
 */
const accessor = createRemoteAuditAccessor('reporting');

/** The spool-backed remote client — passed to `wireServiceSecurity`. */
export const getAuditClient = accessor.getAuditClient;

/**
 * Emit an attributed reporting audit event. Thin wrapper baking in the
 * `'reporting'` service principal so call sites stay terse. Best-effort — never
 * blocks or throws; emit only AFTER the mutation succeeds. Keep `details` free
 * of secrets/tokens and AWS account ids.
 */
export function emitReportingAudit(event: RemoteAuditEvent): void {
  accessor.emit(event);
}
