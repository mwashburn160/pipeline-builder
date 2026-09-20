// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the compliance service. Route handlers push attributed
 * `compliance.*` events (rule/policy authoring, exemption approval, subscription
 * toggles, scan cancellation, …) into platform's `POST /audit/events` ingest,
 * and boot registers the shared `authz.denied` sink over the same client.
 * Emission is FIRE-AND-FORGET (`record` never throws / is not awaited); handlers
 * MUST emit only AFTER the mutation succeeds. See `createRemoteAuditAccessor`.
 *
 * Both shapes come from the ONE api-core factory: `getAuditClient` (the
 * spool-backed client `wireServiceBoot` registers the `authz.denied` sink on)
 * and `emitComplianceAudit` (the terse emitter route handlers call, with the
 * `'compliance'` service principal already baked in). Best-effort — never blocks or
 * throws; emit only AFTER the mutation succeeds, and keep `details` free of
 * secrets/tokens and AWS account ids.
 */
export const { getAuditClient, emit: emitComplianceAudit } = createRemoteAuditAccessor('compliance');
