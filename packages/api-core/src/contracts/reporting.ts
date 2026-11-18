// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY reporting.
 *
 *  - org purge: platform's cascade outbox tears a deleted org's stakeholder
 *    reports, share links, DORA/incident data, ingested events and analytics
 *    rollups out of the reporting tables.
 */

import { CASCADE_LEG_AUTH, CascadeOrgParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';

export const REPORTING_INTERNAL = {
  /** Idempotent: 200 `{ orgId, tables }`; 500 when any table failed (the leg retries). */
  purgeOrg: defineInternalEndpoint({
    id: 'reporting.purgeOrg',
    service: 'reporting',
    method: 'POST',
    path: '/reports/internal/orgs/:orgId/purge',
    callers: ['platform'],
    auth: CASCADE_LEG_AUTH,
    params: CascadeOrgParams,
    response: OrgPurgeResponse,
  }),
} as const;
