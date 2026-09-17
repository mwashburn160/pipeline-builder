// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';
import type { RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the compliance service. Route handlers push attributed
 * `compliance.*` events (rule/policy authoring, exemption approval, subscription
 * toggles, scan cancellation, …) into platform's `POST /audit/events` ingest,
 * and boot registers the shared `authz.denied` sink over the same client.
 * Emission is FIRE-AND-FORGET (`record` never throws / is not awaited); handlers
 * MUST emit only AFTER the mutation succeeds. See `createRemoteAuditAccessor`.
 */
const accessor = createRemoteAuditAccessor('compliance');

/** The spool-backed remote client — passed to `wireServiceSecurity` at boot. */
export const getAuditClient = accessor.getAuditClient;

/**
 * Emit an attributed compliance audit event. Thin wrapper baking in the
 * `'compliance'` service principal so call sites stay terse. Best-effort —
 * never blocks or throws. Keep `details` free of secrets/tokens and AWS
 * account ids.
 */
export function emitComplianceAudit(event: RemoteAuditEvent): void {
  accessor.emit(event);
}
