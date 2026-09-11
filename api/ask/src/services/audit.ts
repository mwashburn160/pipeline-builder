// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';

/**
 * Remote-audit wiring for the ask service.
 *
 * A lazily-constructed `RemoteAuditClient` that pushes attributed events into
 * platform's `POST /audit/events` ingest (service-to-service JWT). `getAuditClient`
 * backs the shared `requirePermission` / `requireFeature` gate so its `authz.denied`
 * denials reach the platform audit trail. Emission is fire-and-forget.
 */
export const { getAuditClient } = createRemoteAuditAccessor('ask');
