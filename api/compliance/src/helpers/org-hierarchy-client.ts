// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, errorMessage, getServiceAuthHeader } from '@pipeline-builder/api-core';
import { createServiceClient } from '@pipeline-builder/pipeline-core';

const logger = createLogger('org-hierarchy-client');

// Platform owns the org → team hierarchy (Mongo); compliance reads a team's
// direct parent from it. The live validation + entity-event paths get the
// parent straight off the JWT (`parentOrganizationId`), but scheduled scans run
// detached from any request, so the executor resolves it over HTTP instead —
// no parent column on the scan record, no migration.
const platformClient = createServiceClient('platform');

interface ParentResponse {
  data?: { parentOrgId?: string | null };
}

/**
 * Resolve an org's direct parent id via platform's internal
 * `GET /organization/:id/parent`. Returns `undefined` for a root org OR when the
 * lookup fails — a resolve failure must NOT block the scan; it degrades to
 * "evaluate the org's own rules only" (exactly the pre-parent-propagation
 * behavior), and the miss is logged so operators can see it.
 */
export async function resolveParentOrgId(orgId: string): Promise<string | undefined> {
  try {
    const res = await platformClient.get<ParentResponse>(`/organization/${encodeURIComponent(orgId)}/parent`, {
      headers: { Authorization: getServiceAuthHeader({ serviceName: 'compliance', orgId: 'system', role: 'member' }) },
    });
    const parentOrgId = res.body?.data?.parentOrgId;
    return parentOrgId ?? undefined;
  } catch (err) {
    logger.warn('Failed to resolve parent org for scan; evaluating own rules only', {
      orgId,
      error: errorMessage(err),
    });
    return undefined;
  }
}
