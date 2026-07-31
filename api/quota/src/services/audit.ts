// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';
import type { RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the quota service. Route handlers push attributed `quota.*`
 * events into platform's `POST /audit/events` ingest so the superadmin
 * quota-administration mutations — resetting an org's usage counters and editing
 * its tier/limit overrides — stay traceable after request logs lapse; it also
 * backs the boot-registered `authz.denied` auditor. Emission is FIRE-AND-FORGET
 * (`record` never throws / is not awaited); handlers MUST emit only AFTER the
 * mutation succeeds. See `createRemoteAuditAccessor`.
 */
const accessor = createRemoteAuditAccessor('quota');

/** The spool-backed remote client — passed to `wireAuthzDenialAuditor` and
 *  called directly by route files via `getAuditClient().record(...)`. */
export const getAuditClient = accessor.getAuditClient;

/**
 * Emit an attributed quota audit event. Thin wrapper baking in the `'quota'`
 * service principal so call sites stay terse. Best-effort — never blocks or
 * throws. Keep `details` free of secrets/tokens and AWS account ids (numeric
 * quota limits + quotaType are fine).
 */
export function emitQuotaAudit(event: RemoteAuditEvent): void {
  accessor.emit(event);
}
