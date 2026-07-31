// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, fetchParentOrgId, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

const logger = createLogger('org-hierarchy-client');

// Platform owns the org → team hierarchy (Mongo); compliance reads a team's
// direct parent from it. The live validation + entity-event paths get the
// parent straight off the JWT (`parentOrganizationId`), but scheduled scans run
// detached from any request, so the executor resolves it over HTTP instead —
// no parent column on the scan record, no migration.

/**
 * Resolve an org's direct parent id via platform's internal
 * `GET /organization/:id/parent`. Returns `undefined` ONLY for a genuine root
 * org (a 200 whose parent is null). A lookup FAILURE (transport error, or a
 * non-2xx via `throwOnHttpError`) is RE-THROWN — it must NOT be silently
 * degraded to "own rules only": a team org whose parent lookup failed would then
 * skip the parent's `propagateToChildren` blocking rules and stamp a false-pass
 * green scan. The scan executor's try/catch turns the throw into a `failed`
 * scan (honest gating), which is the correct fail-CLOSED posture for a
 * compliance-enforcement service — mirroring `fetchEntities`/`fetchExemptions`.
 *
 * The HTTP mechanics (URL, signed service-token auth, timeout+retry) live in
 * the shared api-core helper.
 */
export async function resolveParentOrgId(orgId: string): Promise<string | undefined> {
  try {
    const { services } = Config.get('server');
    return await fetchParentOrgId(orgId, {
      service: { host: services.platformHost, port: services.platformPort },
      serviceName: 'compliance',
      authOrgId: SYSTEM_ORG_ID,
      throwOnHttpError: true,
    });
  } catch (err) {
    logger.error('Failed to resolve parent org for scan; failing scan (inherited rules must not be skipped)', {
      orgId,
      error: errorMessage(err),
    });
    throw err;
  }
}
