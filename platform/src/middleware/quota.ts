// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createQuotaService, getServiceAuthHeader, reserveQuota, decrementQuota } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaCheckResult } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';

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
 */
export async function reserveFeatureQuota(
  orgId: string,
  quotaType: QuotaType,
): Promise<{ exceeded: boolean; quota: { type: QuotaType; limit: number; used: number; remaining: number; resetAt?: string } }> {
  const auth = getServiceAuthHeader({ serviceName: 'platform', orgId, role: 'member' });
  return reserveQuota(quotaService, orgId, quotaType, auth);
}

/** Roll back a previously reserved feature-quota slot. Fire-and-forget. */
export function releaseFeatureQuota(
  orgId: string,
  quotaType: QuotaType,
  logWarn: (msg: string, data?: unknown) => void,
): void {
  const auth = getServiceAuthHeader({ serviceName: 'platform', orgId, role: 'member' });
  decrementQuota(quotaService, orgId, quotaType, auth, logWarn);
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
