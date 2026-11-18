// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY compliance.
 *
 *  - org purge: platform's cascade outbox tears a deleted org's policies,
 *    rules, scans, exemptions and their history out of the compliance tables.
 */

import { CASCADE_LEG_AUTH, CascadeOrgParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';

export const COMPLIANCE_INTERNAL = {
  /** Idempotent: 200 `{ orgId, tables }`; 500 when any table failed (the leg retries). */
  purgeOrg: defineInternalEndpoint({
    id: 'compliance.purgeOrg',
    service: 'compliance',
    method: 'POST',
    path: '/compliance/internal/orgs/:orgId/purge',
    callers: ['platform'],
    auth: CASCADE_LEG_AUTH,
    params: CascadeOrgParams,
    response: OrgPurgeResponse,
  }),
} as const;
