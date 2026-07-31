// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';
import type { RemoteAuditEvent } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the image-registry service. The registry's destructive
 * surface — GC sweeps (`registry.gc`), image/tag deletes
 * (`registry.image.delete`) — plus denied-authorization attempts
 * (`authz.denied`) are pushed into platform's `POST /audit/events` ingest so
 * these data-loss/probing events are traceable long after request logs lapse.
 * Emission is FIRE-AND-FORGET (`record` never throws / is not awaited); call
 * sites MUST emit only AFTER the mutation succeeds. See
 * `createRemoteAuditAccessor`.
 */
const accessor = createRemoteAuditAccessor('image-registry');

/** The spool-backed remote client — passed to `wireAuthzDenialAuditor` and
 *  called directly by route files via `getAuditClient().record(...)`. */
export const getAuditClient = accessor.getAuditClient;

/**
 * Emit an attributed image-registry audit event. Thin wrapper baking in the
 * `'image-registry'` service principal so call sites stay terse. Best-effort —
 * never blocks or throws. Keep `details` free of secrets/tokens and AWS account
 * ids.
 */
export function emitImageRegistryAudit(event: RemoteAuditEvent): void {
  accessor.emit(event);
}
