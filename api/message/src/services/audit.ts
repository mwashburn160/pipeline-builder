// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createServiceAuditClient } from '@pipeline-builder/api-core';
import type { RemoteAuditClient, ServiceAuditClient } from '@pipeline-builder/api-core';

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
let audit: ServiceAuditClient | null = null;

/** Lazily-constructed module singleton, matching api/pipeline's accessor. */
function svc(): ServiceAuditClient {
  if (!audit) audit = createServiceAuditClient('message');
  return audit;
}

/** The underlying spool-backed remote client — passed to `wireAuthzDenialAuditor`
 *  and called directly by route files via `getAuditClient().record(...)`. */
export function getAuditClient(): RemoteAuditClient {
  return svc().client;
}
