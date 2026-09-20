// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';

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
 *
 * Both shapes come from the ONE api-core factory: `getAuditClient` (the
 * spool-backed client `wireServiceBoot` registers the `authz.denied` sink on)
 * and `emitReportingAudit` (the terse emitter route handlers call, with the
 * `'reporting'` service principal already baked in). Best-effort — never blocks or
 * throws; emit only AFTER the mutation succeeds, and keep `details` free of
 * secrets/tokens and AWS account ids.
 */
export const { getAuditClient, emit: emitReportingAudit } = createRemoteAuditAccessor('reporting');
