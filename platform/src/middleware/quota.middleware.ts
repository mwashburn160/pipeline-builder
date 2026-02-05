/**
 * @module middleware/quota
 * @description Quota service utilities for organization quota management.
 * Provides helpers for checking and updating quotas via the quota microservices.
 *
 * Note: Route-level quota enforcement has been moved to the API microservices.
 * This module now provides utility functions for the organization controller.
 */

import * as http from 'http';
import logger from '../utils/logger';

// =============================================================================
// Configuration (consolidated into single quota service)
// =============================================================================

const QUOTA_SERVICE_HOST = process.env.QUOTA_SERVICE_HOST || 'quota';
const QUOTA_SERVICE_PORT = parseInt(process.env.QUOTA_SERVICE_PORT || '3000', 10);

// =============================================================================
// Types
// =============================================================================

/**
 * Quota type for organization resources.
 */
export type QuotaType = 'plugins' | 'pipelines' | 'apiCalls';

/**
 * Response from quota check API.
 */
export interface QuotaCheckResult {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
  unlimited: boolean;
}

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
// Quota Service Integration
// =============================================================================

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
  return new Promise((resolve) => {
    const options: http.RequestOptions = {
      hostname: QUOTA_SERVICE_HOST,
      port: QUOTA_SERVICE_PORT,
      path: `/quotas/${encodeURIComponent(orgId)}/${encodeURIComponent(quotaType)}`,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'x-org-id': orgId,
      },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.success && response.status) {
            resolve({
              allowed: response.status.allowed,
              limit: response.status.limit,
              used: response.status.used,
              remaining: response.status.remaining,
              resetAt: response.status.resetAt,
              unlimited: response.status.unlimited,
            });
          } else {
            logger.warn('[QUOTA] Service returned error', {
              message: response.message,
              orgId,
              quotaType,
            });
            resolve(createFailOpenResult());
          }
        } catch (parseError) {
          logger.warn('[QUOTA] Failed to parse response', {
            error: parseError instanceof Error ? parseError.message : String(parseError),
            orgId,
            quotaType,
          });
          resolve(createFailOpenResult());
        }
      });
    });

    req.on('error', (error) => {
      logger.warn('[QUOTA] Service unavailable', {
        error: error.message,
        orgId,
        quotaType,
      });
      resolve(createFailOpenResult());
    });

    req.on('timeout', () => {
      req.destroy();
      logger.warn('[QUOTA] Service timeout', { orgId, quotaType });
      resolve(createFailOpenResult());
    });

    req.end();
  });
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
  return new Promise((resolve) => {
    const body = JSON.stringify({ quotaLimits });

    const options: http.RequestOptions = {
      hostname: QUOTA_SERVICE_HOST,
      port: QUOTA_SERVICE_PORT,
      path: `/quotas/${encodeURIComponent(orgId)}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': authHeader,
        'x-org-id': orgId,
      },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          logger.debug('[QUOTA] Limits updated successfully', { orgId });
          resolve(true);
        } else {
          logger.warn('[QUOTA] Failed to update limits', {
            statusCode: res.statusCode,
            response: data,
            orgId,
          });
          resolve(false);
        }
      });
    });

    req.on('error', (error) => {
      logger.warn('[QUOTA] Failed to update limits', {
        error: error.message,
        orgId,
      });
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      logger.warn('[QUOTA] Update timeout', { orgId });
      resolve(false);
    });

    req.write(body);
    req.end();
  });
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
