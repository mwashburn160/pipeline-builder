// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the image-registry service. The registry's destructive
 * surface — GC sweeps (`registry.gc`), image/tag deletes
 * (`registry.image.delete`) — plus denied-authorization attempts
 * (`authz.denied`) are pushed into platform's `POST /audit/events` ingest so
 * these data-loss/probing events are traceable long after request logs lapse.
 * Emission is FIRE-AND-FORGET (`record` never throws / is not awaited); call
 * sites MUST emit only AFTER the mutation succeeds. See
 * `createRemoteAuditAccessor`.
 *
 * Both shapes come from the ONE api-core factory: `getAuditClient` (the
 * spool-backed client `wireServiceBoot` registers the `authz.denied` sink on)
 * and `emitImageRegistryAudit` (the terse emitter route handlers call, with the
 * `'image-registry'` service principal already baked in). Best-effort — never blocks or
 * throws; emit only AFTER the mutation succeeds, and keep `details` free of
 * secrets/tokens and AWS account ids.
 */
export const { getAuditClient, emit: emitImageRegistryAudit } = createRemoteAuditAccessor('image-registry');
