// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteAuditAccessor } from '@pipeline-builder/api-core';

/**
 * Remote-audit wiring for the billing service.
 *
 * Billing's own domain mutations are logged locally in the Mongo
 * `billing_events` collection; this lazily-constructed `RemoteAuditClient` exists
 * so the shared `requirePermission` / `requireSystemAdmin` gate's `authz.denied`
 * denials reach the platform audit trail like the other services'. Emission is
 * fire-and-forget (`record` never throws / is not awaited). See
 * `createRemoteAuditAccessor`.
 */
export const { getAuditClient } = createRemoteAuditAccessor('billing');
