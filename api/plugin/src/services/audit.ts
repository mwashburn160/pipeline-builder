// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';
import type { RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the plugin service. The build worker pushes `plugin.build.*`
 * events into platform's `POST /audit/events` ingest; the route handlers share
 * this lazily-constructed client to add the destructive/publishing mutations
 * (`plugin.delete`/`plugin.upload`/`plugin.deploy`) plus the boot-registered
 * `authz.denied` sink. Emission is FIRE-AND-FORGET (`record` never throws / is
 * not awaited); handlers MUST emit only AFTER the mutation succeeds. See
 * `createRemoteAuditAccessor`.
 */
const accessor = createRemoteAuditAccessor('plugin');

/** The spool-backed remote client — passed to `wireAuthzDenialAuditor` and
 *  called directly by route files via `getAuditClient().record(...)`. */
export const getAuditClient = accessor.getAuditClient;

/**
 * Emit an attributed plugin audit event. Thin wrapper baking in the `'plugin'`
 * service principal so call sites stay terse. Best-effort — never blocks or
 * throws. Keep `details` free of secrets/tokens and AWS account ids (plugin
 * name/version/tag are fine).
 */
export function emitPluginAudit(event: RemoteAuditEvent): void {
  accessor.emit(event);
}
