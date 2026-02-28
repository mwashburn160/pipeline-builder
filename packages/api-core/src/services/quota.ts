/**
 * @module services/quota
 * @description Client for interacting with the consolidated quota-service.
 *
 * All read and write operations go to a single service endpoint.
 */

import { createSafeClient } from './http-client';
import { QuotaType, QuotaCheckResult, ServiceConfig } from '../types/common';
import { createLogger } from '../utils/logger';

const logger = createLogger('quota');

/**
 * Quota service client interface.
 */
export interface QuotaService {
  /** Check if quota is available (fail-open on error). */
  check(orgId: string, quotaType: QuotaType, authHeader: string): Promise<QuotaCheckResult>;
  /** Increment quota usage. Returns a promise so callers can optionally handle errors. */
  increment(orgId: string, quotaType: QuotaType, authHeader: string, amount?: number): Promise<void>;
  /** Update quota limits. Returns true on success. */
  updateLimits(orgId: string, limits: Partial<Record<QuotaType, number>>, authHeader: string): Promise<boolean>;
  /** Reset quota usage. Returns true on success. */
  reset(orgId: string, quotaType?: QuotaType, authHeader?: string): Promise<boolean>;
}

/**
 * Configuration for quota service client.
 */
export interface QuotaServiceConfig {
  /** Quota service host (default: env QUOTA_SERVICE_HOST or 'quota') */
  host?: string;
  /** Quota service port (default: env QUOTA_SERVICE_PORT or 3000) */
  port?: number;
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
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
 * @param config - Optional service configuration
 * @returns Quota service client
 *
 * @example
 * ```typescript
 * const quotaService = createQuotaService();
 *
 * // Check quota before processing
 * const quota = await quotaService.check(orgId, 'apiCalls', authHeader);
 * if (!quota.allowed) {
 *   return res.status(429).json({ error: 'Quota exceeded' });
 * }
 *
 * // Increment quota after success
 * quotaService.increment(orgId, 'apiCalls', authHeader).catch(err => logger.warn('Quota increment failed', { error: err }));
 * ```
 */
/**
 * Fire-and-forget quota increment with standardized error logging.
 *
 * Wraps `quotaService.increment()` with a `.catch()` that logs a warning.
 * Eliminates the identical one-liner repeated across every read route.
 *
 * @param quotaService - Quota service client
 * @param orgId - Organization ID
 * @param quotaType - Quota type to increment
 * @param authHeader - Authorization header value
 * @param logWarn - Logging function for warnings (e.g., `(msg, meta) => ctx.log('WARN', msg, meta)` or `logger.warn`)
 *
 * @example
 * ```typescript
 * incrementQuota(quotaService, orgId, 'apiCalls', req.headers.authorization || '', (msg, meta) => ctx.log('WARN', msg, meta));
 * ```
 */
export function incrementQuota(
  quotaService: QuotaService,
  orgId: string,
  quotaType: QuotaType,
  authHeader: string,
  logWarn: (message: string, data?: unknown) => void,
): void {
  quotaService.increment(orgId, quotaType, authHeader).catch((err: unknown) =>
    logWarn('Quota increment failed', { error: err instanceof Error ? err.message : String(err) }),
  );
}

export function createQuotaService(config: QuotaServiceConfig = {}): QuotaService {
  const serviceConfig: ServiceConfig = {
    host: config.host ?? process.env.QUOTA_SERVICE_HOST ?? 'quota',
    port: config.port ?? parseInt(process.env.QUOTA_SERVICE_PORT ?? '3000', 10),
    timeout: config.timeout ?? 5000,
  };

  const client = createSafeClient(serviceConfig);

  return {
    async check(orgId: string, quotaType: QuotaType, authHeader: string): Promise<QuotaCheckResult> {
      const path = `/quotas/${encodeURIComponent(orgId)}/${encodeURIComponent(quotaType)}`;

      const response = await client.get<{
        success: boolean;
        data?: { quotaType: string; status: QuotaCheckResult };
        message?: string;
      }>(path, { headers: buildHeaders(orgId, authHeader) });

      if (!response) {
        logger.warn('Quota service unavailable, allowing request (fail-open)', { orgId, quotaType });
        return createFailOpenResult();
      }

      if (response.statusCode !== 200 || !response.body.success || !response.body.data?.status) {
        logger.warn('Quota check failed, allowing request (fail-open)', {
          orgId, quotaType, statusCode: response.statusCode, message: response.body.message,
        });
        return createFailOpenResult();
      }

      return response.body.data.status;
    },

    async increment(orgId: string, quotaType: QuotaType, authHeader: string, amount: number = 1): Promise<void> {
      const path = `/quotas/${encodeURIComponent(orgId)}/increment`;

      const response = await client
        .post(path, { quotaType, amount }, { headers: buildHeaders(orgId, authHeader) });

      if (!response || response.statusCode !== 200) {
        logger.warn('Failed to increment quota', {
          orgId, quotaType, amount, statusCode: response?.statusCode,
        });
      } else {
        logger.debug('Quota incremented', { orgId, quotaType, amount });
      }
    },

    async updateLimits(
      orgId: string,
      limits: Partial<Record<QuotaType, number>>,
      authHeader: string,
    ): Promise<boolean> {
      const path = `/quotas/${encodeURIComponent(orgId)}`;

      const response = await client.put(path, limits, { headers: buildHeaders(orgId, authHeader) });

      if (!response || response.statusCode !== 200) {
        logger.warn('Failed to update quota limits', {
          orgId, limits, statusCode: response?.statusCode,
        });
        return false;
      }

      logger.info('Quota limits updated', { orgId, limits });
      return true;
    },

    async reset(orgId: string, quotaType?: QuotaType, authHeader?: string): Promise<boolean> {
      const path = `/quotas/${encodeURIComponent(orgId)}/reset`;

      const body = quotaType ? { quotaType } : {};
      const response = await client.post(path, body, { headers: buildHeaders(orgId, authHeader ?? '') });

      if (!response || response.statusCode !== 200) {
        logger.warn('Failed to reset quota', {
          orgId, quotaType, statusCode: response?.statusCode,
        });
        return false;
      }

      logger.info('Quota reset', { orgId, quotaType: quotaType ?? 'all' });
      return true;
    },
  };
}
