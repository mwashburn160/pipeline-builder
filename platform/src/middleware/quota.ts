// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createQuotaService } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaCheckResult } from '@pipeline-builder/api-core';
import { config } from '../config';

export type { QuotaType, QuotaCheckResult };

/** Singleton quota service client configured from platform config. */
const quotaService = createQuotaService({
  host: config.quota.serviceHost,
  port: config.quota.servicePort,
  timeout: config.quota.serviceTimeout,
});

/**
 * Check quota status for an organization (fail-open on error).
 */
export async function checkQuotaService(
  orgId: string,
  quotaType: QuotaType,
  authHeader: string,
): Promise<QuotaCheckResult> {
  return quotaService.check(orgId, quotaType, authHeader);
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
