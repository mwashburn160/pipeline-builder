// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditClient } from '@pipeline-builder/api-core';
import type { RemoteAuditClient } from '@pipeline-builder/api-core';

/**
 * Remote-audit wiring for the message service.
 *
 * Mirrors api/pipeline's `services/audit.ts`: a lazily-constructed
 * `RemoteAuditClient` that pushes attributed events into platform's
 * `POST /audit/events` ingest (authenticated via a service-to-service JWT).
 *
 * The message service previously emitted no remote audit; this client exists so
 * the shared `requirePermission` / `requireSystemAdmin` gate's `authz.denied`
 * denials (#5) reach the platform audit trail like the other services'.
 *
 * Emission is FIRE-AND-FORGET: `RemoteAuditClient.record` never throws and is
 * not awaited, so a flaky audit downstream can never fail or delay a request.
 */
let auditClient: RemoteAuditClient | null = null;

/** Lazily-constructed module singleton, matching api/pipeline's accessor. */
export function getAuditClient(): RemoteAuditClient {
  if (!auditClient) auditClient = createRemoteAuditClient();
  return auditClient;
}
