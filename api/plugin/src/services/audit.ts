// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditClient } from '@pipeline-builder/api-core';
import type { RemoteAuditClient, RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the plugin service.
 *
 * The build worker already pushes attributed `plugin.build.*` events into
 * platform's `POST /audit/events` ingest. This module hoists the singleton
 * client the worker used so the route handlers can share it, and adds the
 * destructive / publishing plugin mutations — `plugin.delete`, `plugin.upload`,
 * `plugin.deploy` — plus the process-wide `authz.denied` sink registered at
 * boot, so the security-relevant surface stays traceable after request logs
 * lapse. Mirrors api/pipeline's `services/audit.ts`.
 *
 * Emission is FIRE-AND-FORGET: `RemoteAuditClient.record` never throws and is
 * not awaited, so a flaky audit downstream can never fail or delay the
 * originating mutation. Handlers MUST emit only AFTER the mutation succeeds.
 */
let auditClient: RemoteAuditClient | null = null;

/** Lazily-constructed module singleton (config/token errors surface on use). */
export function getAuditClient(): RemoteAuditClient {
  if (!auditClient) auditClient = createRemoteAuditClient();
  return auditClient;
}

/**
 * Emit an attributed plugin audit event. Thin wrapper that bakes in the
 * `'plugin'` service principal so call sites stay terse. Best-effort — never
 * blocks or throws. Keep `details` free of secrets/tokens and AWS account ids
 * (plugin name/version/tag are fine).
 */
export function emitPluginAudit(event: RemoteAuditEvent): void {
  getAuditClient().record(event, 'plugin');
}
