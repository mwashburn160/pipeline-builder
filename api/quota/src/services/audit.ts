// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the quota service. Route handlers push attributed `quota.*`
 * events into platform's `POST /audit/events` ingest so the superadmin
 * quota-administration mutations — resetting an org's usage counters and editing
 * its tier/limit overrides — stay traceable after request logs lapse; it also
 * backs the boot-registered `authz.denied` auditor. Emission is FIRE-AND-FORGET
 * (`record` never throws / is not awaited); handlers MUST emit only AFTER the
 * mutation succeeds. See `createRemoteAuditAccessor`.
 *
 * Both shapes come from the ONE api-core factory: `getAuditClient` (the
 * spool-backed client `wireServiceBoot` registers the `authz.denied` sink on)
 * and `emitQuotaAudit` (the terse emitter route handlers call, with the
 * `'quota'` service principal already baked in). Best-effort — never blocks or
 * throws; emit only AFTER the mutation succeeds, and keep `details` free of
 * secrets/tokens and AWS account ids.
 */
export const { getAuditClient, emit: emitQuotaAudit } = createRemoteAuditAccessor('quota');
