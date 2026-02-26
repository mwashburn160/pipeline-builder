/**
 * @module middleware/quota
 * @description Quota service utilities for organization quota management.
 * Provides helpers for checking and updating quotas via the quota microservice.
 *
 * Note: Route-level quota enforcement has been moved to the API microservices.
 * This module now provides utility functions for the organization controller.
 */

import { createLogger, createSafeClient } from '@mwashburn160/api-core';
import type { QuotaType, QuotaCheckResult } from '@mwashburn160/api-core';
import { config } from '../config';

export type { QuotaType, QuotaCheckResult };

const logger = createLogger('platform-api');

/**
 * Quota status with parsed date.
 */
export interface QuotaStatus {
  limit: number;
  used: number;
  remaining: number;
  resetAt: Date;
  allowed: boolean;
  unlimited: boolean;
}

// =============================================================================
// Quota Service Client
// =============================================================================

/** Create an HTTP client configured for the quota microservice. */
function getQuotaClient() {
  return createSafeClient({
    host: config.quota.serviceHost,
    port: config.quota.servicePort,
    timeout: config.quota.serviceTimeout,
  });
}

/**
 * Check quota status by calling the quota microservice.
 *
 * @param orgId - Organization ID
 * @param quotaType - Type of quota to check
 * @param authHeader - Authorization header to forward
 * @returns Promise resolving to quota status
 */
export async function checkQuotaService(
  orgId: string,
  quotaType: QuotaType,
  authHeader: string,
): Promise<QuotaCheckResult> {
  const client = getQuotaClient();
  const result = await client.get<{ success: boolean; status: QuotaCheckResult }>(
    `/quotas/${encodeURIComponent(orgId)}/${encodeURIComponent(quotaType)}`,
    { headers: { 'Authorization': authHeader, 'x-org-id': orgId } },
  );

  if (result?.body?.success && result.body.status) {
    return result.body.status;
  }

  logger.warn('[QUOTA] Service returned error or unavailable', { orgId, quotaType });
  return createFailOpenResult();
}

/**
 * Update quota limits by calling the quota microservice.
 *
 * @param orgId - Organization ID
 * @param quotaLimits - New quota limits
 * @param authHeader - Authorization header to forward
 * @returns Promise resolving to success boolean
 */
export async function updateQuotaLimits(
  orgId: string,
  quotaLimits: Partial<Record<QuotaType, number>>,
  authHeader: string,
): Promise<boolean> {
  const client = getQuotaClient();
  const result = await client.put(
    `/quotas/${encodeURIComponent(orgId)}`,
    { quotaLimits },
    { headers: { 'Authorization': authHeader, 'x-org-id': orgId } },
  );

  if (result && (result.statusCode === 200 || result.statusCode === 201)) {
    logger.debug('[QUOTA] Limits updated successfully', { orgId });
    return true;
  }

  logger.warn('[QUOTA] Failed to update limits', { orgId, status: result?.statusCode });
  return false;
}

/**
 * Get quota status for an organization.
 *
 * @param organizationId - Organization ID
 * @param quotaType - Type of quota to check
 * @param authHeader - Authorization header to forward
 * @returns Promise resolving to quota status or null if unavailable
 */
export async function getOrganizationQuotaStatus(
  organizationId: string,
  quotaType: QuotaType,
  authHeader: string = '',
): Promise<QuotaStatus | null> {
  try {
    const status = await checkQuotaService(organizationId, quotaType, authHeader);
    return {
      limit: status.limit,
      used: status.used,
      remaining: status.remaining,
      resetAt: new Date(status.resetAt),
      allowed: status.allowed,
      unlimited: status.unlimited,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a fail-open quota result (allows the request).
 */
function createFailOpenResult(): QuotaCheckResult {
  return {
    allowed: true,
    limit: -1,
    used: 0,
    remaining: -1,
    resetAt: new Date().toISOString(),
    unlimited: true,
  };
}
