// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';

/**
 * Remote-audit wiring for the reporting service.
 *
 * A lazily-constructed `RemoteAuditClient` that pushes attributed events into
 * platform's `POST /audit/events` ingest (service-to-service JWT). Reporting's
 * routes don't emit remote audit directly; `getAuditClient`'s only consumer is
 * the shared authz-denial-auditor wiring (`authz.denied`). Emission is
 * fire-and-forget (`record` never throws / is not awaited). See
 * `createRemoteAuditAccessor`.
 */
export const { getAuditClient } = createRemoteAuditAccessor('reporting');
