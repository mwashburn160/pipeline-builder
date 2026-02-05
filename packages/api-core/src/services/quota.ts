/**
 * @module services/quota
 * @description Quota service client for checking, incrementing, updating, and resetting quotas.
 *
 * Points at a single consolidated `quota` (see api/quota).
 * All endpoints live under one host/port.
 */

import { createSafeClient } from './http-client';
import { isSuccessStatus } from '../constants/http-status';
import { QuotaType, QuotaCheckResult, ServiceConfig } from '../types/common';
import { createLogger } from '../utils/logger';

const logger = createLogger('quota');

/**
 * Configuration for the unified quota service.
 */
export interface QuotaServiceConfig {
  /** Quota service host (default: env QUOTA_SERVICE_HOST or 'quota') */
  host?: string;
  /** Quota service port (default: env QUOTA_SERVICE_PORT or 3000) */
  port?: number;
  /** Request timeout in ms (default: 5000) */
  timeout?: number;
}

/**
 * Resolve service configuration from options, env vars, or defaults.
 */
function resolveConfig(config: QuotaServiceConfig = {}): ServiceConfig {
  return {
    host: config.host ?? process.env.QUOTA_SERVICE_HOST ?? 'quota',
    port: config.port ?? parseInt(process.env.QUOTA_SERVICE_PORT ?? '3000', 10),
    timeout: config.timeout ?? 5000,
  };
}

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

/**
 * Build common request headers.
 */
function buildHeaders(orgId: string, authHeader?: string): Record<string, string> {
  const headers: Record<string, string> = { 'x-org-id': orgId };
  if (authHeader) headers.Authorization = authHeader;
  return headers;
}

/**
 * Create a quota service client.
 *
 * @param config - Optional service configuration (defaults to env vars)
 * @returns Quota service client
 *
 * @example
 * ```typescript
 * const quotaService = createQuotaService();
 *
 * // Check quota before operation
 * const status = await quotaService.check(orgId, 'apiCalls', authHeader);
 * if (!status.allowed) {
 *   return sendQuotaExceeded(res, 'apiCalls', status);
 * }
 *
 * // Increment after successful operation (fire-and-forget)
 * quotaService.incrementAsync(orgId, 'apiCalls', authHeader);
 * ```
 */
export function createQuotaService(config: QuotaServiceConfig = {}) {
  const serviceConfig = resolveConfig(config);
  const client = createSafeClient(serviceConfig);

  return {
    /**
     * Check quota status for an organization.
     * Fail-open: returns allowed=true if the service is unreachable.
     */
    async check(
      orgId: string,
      quotaType: QuotaType,
      authHeader: string = '',
    ): Promise<QuotaCheckResult> {
      const path = `/quotas/${encodeURIComponent(orgId)}/${encodeURIComponent(quotaType)}`;

      const response = await client.get<{
        success: boolean;
        status?: QuotaCheckResult;
        message?: string;
      }>(path, { headers: buildHeaders(orgId, authHeader) });

      if (!response) {
        logger.warn('Quota service unavailable, allowing request (fail-open)', { orgId, quotaType });
        return createFailOpenResult();
      }

      if (response.body.success && response.body.status) {
        return response.body.status;
      }

      logger.warn('Quota service returned error, allowing request', {
        orgId, quotaType, message: response.body.message,
      });
      return createFailOpenResult();
    },

    /**
     * Increment quota usage (awaitable).
     * Returns true on success, false on failure.
     */
    async increment(
      orgId: string,
      quotaType: QuotaType,
      authHeader: string = '',
      amount: number = 1,
    ): Promise<boolean> {
      const path = `/quotas/${encodeURIComponent(orgId)}/increment`;

      const response = await client.post(
        path,
        { quotaType, amount },
        { headers: buildHeaders(orgId, authHeader) },
      );

      if (!response) {
        logger.warn('Failed to increment quota (service unavailable)', { orgId, quotaType, amount });
        return false;
      }

      if (isSuccessStatus(response.statusCode)) {
        logger.debug('Quota incremented successfully', { orgId, quotaType, amount });
        return true;
      }

      logger.warn('Failed to increment quota', { orgId, quotaType, statusCode: response.statusCode });
      return false;
    },

    /**
     * Fire-and-forget increment — does not await the result.
     * Use when you don't need to know if the increment succeeded.
     */
    incrementAsync(
      orgId: string,
      quotaType: QuotaType,
      authHeader: string = '',
      amount: number = 1,
    ): void {
      const path = `/quotas/${encodeURIComponent(orgId)}/increment`;

      client
        .post(path, { quotaType, amount }, { headers: buildHeaders(orgId, authHeader) })
        .then((response) => {
          if (!response || !isSuccessStatus(response.statusCode)) {
            logger.warn('Failed to increment quota (async)', {
              orgId, quotaType, amount, statusCode: response?.statusCode,
            });
          } else {
            logger.debug('Quota incremented (async)', { orgId, quotaType, amount });
          }
        })
        .catch((error) => {
          logger.warn('Error incrementing quota (async)', {
            orgId, quotaType, error: error instanceof Error ? error.message : String(error),
          });
        });
    },

    /**
     * Update quota limits for an organization.
     * Returns true on success, false on failure.
     */
    async updateLimits(
      orgId: string,
      limits: Partial<Record<QuotaType, number>>,
      authHeader: string = '',
    ): Promise<boolean> {
      const path = `/quotas/${encodeURIComponent(orgId)}`;

      const response = await client.put(
        path,
        limits,
        { headers: buildHeaders(orgId, authHeader) },
      );

      if (!response) {
        logger.warn('Failed to update quota limits (service unavailable)', { orgId });
        return false;
      }

      return isSuccessStatus(response.statusCode);
    },

    /**
     * Reset quota usage for an organization.
     * Returns true on success, false on failure.
     */
    async reset(
      orgId: string,
      quotaType?: QuotaType,
      authHeader: string = '',
    ): Promise<boolean> {
      const path = `/quotas/${encodeURIComponent(orgId)}/reset`;

      const response = await client.post(
        path,
        quotaType ? { quotaType } : {},
        { headers: buildHeaders(orgId, authHeader) },
      );

      if (!response) {
        logger.warn('Failed to reset quota (service unavailable)', { orgId, quotaType });
        return false;
      }

      return isSuccessStatus(response.statusCode);
    },
  };
}

/**
 * Default quota service instance.
 */
export const quotaService = createQuotaService();
