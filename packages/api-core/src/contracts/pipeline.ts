// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY pipeline.
 *
 *  - org purge: platform's cascade outbox tears a deleted org's pipelines,
 *    templates, registry entries and per-pipeline security state out of the
 *    pipeline service's own tables.
 */

import { CASCADE_LEG_AUTH, CascadeOrgParams, OrgPurgeResponse } from './cascade.js';
import { defineInternalEndpoint } from './define.js';

export const PIPELINE_INTERNAL = {
  /** Idempotent: 200 `{ orgId, tables }`; 500 when any table failed (the leg retries). */
  purgeOrg: defineInternalEndpoint({
    id: 'pipeline.purgeOrg',
    service: 'pipeline',
    method: 'POST',
    path: '/pipelines/internal/orgs/:orgId/purge',
    callers: ['platform'],
    auth: CASCADE_LEG_AUTH,
    params: CascadeOrgParams,
    response: OrgPurgeResponse,
  }),
} as const;
