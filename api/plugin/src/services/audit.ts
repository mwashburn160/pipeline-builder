// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';

/**
 * Audit wiring for the plugin service. The build worker pushes `plugin.build.*`
 * events into platform's `POST /audit/events` ingest; the route handlers share
 * this lazily-constructed client to add the destructive/publishing mutations
 * (`plugin.delete`/`plugin.upload`/`plugin.deploy`) plus the boot-registered
 * `authz.denied` sink. Emission is FIRE-AND-FORGET (`record` never throws / is
 * not awaited); handlers MUST emit only AFTER the mutation succeeds. See
 * `createRemoteAuditAccessor`.
 *
 * Both shapes come from the ONE api-core factory: `getAuditClient` (the
 * spool-backed client `wireServiceBoot` registers the `authz.denied` sink on)
 * and `emitPluginAudit` (the terse emitter route handlers call, with the
 * `'plugin'` service principal already baked in). Best-effort — never blocks or
 * throws; emit only AFTER the mutation succeeds, and keep `details` free of
 * secrets/tokens and AWS account ids.
 */
export const { getAuditClient, emit: emitPluginAudit } = createRemoteAuditAccessor('plugin');
