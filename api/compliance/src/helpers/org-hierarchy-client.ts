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
 * `GET /organization/:id/parent`. Returns `undefined` for a root org OR when the
 * lookup fails — a resolve failure must NOT block the scan; it degrades to
 * "evaluate the org's own rules only" (exactly the pre-parent-propagation
 * behavior), and the miss is logged so operators can see it.
 *
 * The HTTP mechanics (URL, signed service-token auth, timeout+retry) live in
 * the shared api-core helper; this function keeps compliance's fallback policy.
 */
export async function resolveParentOrgId(orgId: string): Promise<string | undefined> {
  try {
    const { services } = Config.get('server');
    return await fetchParentOrgId(orgId, {
      service: { host: services.platformHost, port: services.platformPort },
      serviceName: 'compliance',
      authOrgId: SYSTEM_ORG_ID,
    });
  } catch (err) {
    logger.warn('Failed to resolve parent org for scan; evaluating own rules only', {
      orgId,
      error: errorMessage(err),
    });
    return undefined;
  }
}
