// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createQuotaService, getServiceAuthHeader, reserveQuota, decrementQuota } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaCheckResult } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { resolveOrgLineage } from '../helpers/org-hierarchy.js';

export type { QuotaType };

/** Singleton quota service client configured from platform config. */
const quotaService = createQuotaService({
  host: config.quota.serviceHost,
  port: config.quota.servicePort,
  timeout: config.quota.serviceTimeout,
});

/**
 * Reserve a slot for one of the F-feature-table quotas (dashboards,
 * alertRules, alertDestinations, idpConfigs). Returns the QuotaReserveResult
 * so the caller can branch on `exceeded`. Mints a service-token auth header
 * because these are internal platform → quota calls (the user's JWT is also
 * valid but a service token avoids token-forwarding concerns).
 *
 * Reserves against the resolved ACCOUNT ROOT, never the caller org. Teams are
 * seeded with `-1` local feature limits so "only the root's pooled cap binds"
 * (org-service seeds teams to -1); reserving against the team id would let the
 * quota service's atomic per-doc guard pass unconditionally (its own limit is
 * unlimited) and only the non-atomic shared-cap PRE-check would stand between a
 * team and unbounded dashboards/alertRules/alertDestinations/idpConfigs.
 * Targeting the root turns enforcement into a single atomic compare-and-
 * increment on the root doc (which holds the real tier cap) — the same pooled
 * total `checkTierOvercap` READS. Flat orgs resolve to themselves
 * (`rootOrgId === orgId`), so this is a no-op there.
 */
export async function reserveFeatureQuota(
  orgId: string,
  quotaType: QuotaType,
): Promise<{ exceeded: boolean; quota: { type: QuotaType; limit: number; used: number; remaining: number; resetAt?: string } }> {
  const { rootOrgId } = await resolveOrgLineage(orgId);
  const auth = getServiceAuthHeader({ serviceName: 'platform', orgId: rootOrgId, role: 'member' });
  return reserveQuota(quotaService, rootOrgId, quotaType, auth);
}

/** Roll back a previously reserved feature-quota slot. Fire-and-forget.
 *  Rolls back against the SAME resolved root the reservation targeted
 *  (see {@link reserveFeatureQuota}) — never the team's `-1` counter. */
export function releaseFeatureQuota(
  orgId: string,
  quotaType: QuotaType,
  logWarn: (msg: string, data?: unknown) => void,
): void {
  void resolveOrgLineage(orgId)
    .then(({ rootOrgId }) => {
      const auth = getServiceAuthHeader({ serviceName: 'platform', orgId: rootOrgId, role: 'member' });
      decrementQuota(quotaService, rootOrgId, quotaType, auth, logWarn);
    })
    .catch((err: unknown) => logWarn('Feature-quota release skipped (root resolution failed)', {
      error: err instanceof Error ? err.message : String(err),
    }));
}

/**
 * Update quota limits for an organization.
 */
export async function updateQuotaLimits(
  orgId: string,
  quotaLimits: Partial<Record<QuotaType, number>>,
  authHeader: string,
): Promise<boolean> {
  return quotaService.updateLimits(orgId, quotaLimits, authHeader);
}

/**
 * Get quota status for an organization, returning null if unavailable.
 */
export async function getOrganizationQuotaStatus(
  organizationId: string,
  quotaType: QuotaType,
  authHeader: string = '',
): Promise<QuotaCheckResult | null> {
  try {
    return await quotaService.check(organizationId, quotaType, authHeader);
  } catch {
    return null;
  }
}
