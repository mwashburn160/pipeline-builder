// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the pipeline service. Pipeline route handlers push attributed
 * `pipeline.*` events into platform's `POST /audit/events` ingest (service-to-
 * service JWT) so create/update/delete and CodePipeline execution start/cancel
 * — the most security-relevant mutations — are traceable after request logs
 * lapse. Emission is FIRE-AND-FORGET (`record` never throws / is not awaited);
 * handlers MUST emit only AFTER the mutation succeeds. See
 * `createRemoteAuditAccessor`.
 *
 * Both shapes come from the ONE api-core factory: `getAuditClient` (the
 * spool-backed client `wireServiceBoot` registers the `authz.denied` sink on)
 * and `emitPipelineAudit` (the terse emitter route handlers call, with the
 * `'pipeline'` service principal already baked in). Best-effort — never blocks or
 * throws; emit only AFTER the mutation succeeds, and keep `details` free of
 * secrets/tokens and AWS account ids.
 */
export const { getAuditClient, emit: emitPipelineAudit } = createRemoteAuditAccessor('pipeline');
