// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';

/**
 * Remote-audit wiring for the message service.
 *
 * A lazily-constructed `RemoteAuditClient` that pushes attributed events into
 * platform's `POST /audit/events` ingest (service-to-service JWT). The message
 * service emits no remote audit directly; `getAuditClient` exists so the shared
 * `requirePermission` / `requireSystemAdmin` gate's `authz.denied` denials reach
 * the platform audit trail like the other services'. Emission is fire-and-forget
 * (`record` never throws / is not awaited). See `createRemoteAuditAccessor`.
 */
export const { getAuditClient } = createRemoteAuditAccessor('message');
