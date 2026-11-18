// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY ops-center.
 *
 *  - org purge: platform's cascade outbox tears a deleted org's dashboards,
 *    alert rules, alert destinations and destination delivery status out of
 *    the ops-center tables (`ORG_DATA_OWNERSHIP['ops-center']`).
 */

import { CASCADE_LEG_AUTH, CascadeOrgParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';

export const OPS_CENTER_INTERNAL = {
  /** Idempotent: 200 `{ orgId, tables }`; 500 when any table failed (the leg retries). */
  purgeOrg: defineInternalEndpoint({
    id: 'ops-center.purgeOrg',
    service: 'ops-center',
    method: 'POST',
    path: '/ops/internal/orgs/:orgId/purge',
    callers: ['platform'],
    auth: CASCADE_LEG_AUTH,
    params: CascadeOrgParams,
    response: OrgPurgeResponse,
  }),
} as const;
