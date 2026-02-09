/**
 * @module api/check-quota
 * @description Middleware that checks quota before allowing the request to proceed.
 *
 * Must be used after `authenticateToken` and `requireOrgId`.
 */

import { ErrorCode, createLogger } from '@mwashburn160/api-core';
import type { QuotaType, QuotaService } from '@mwashburn160/api-core';
import { Request, Response, NextFunction } from 'express';
import { createRequestContext } from './request-types';
import type { SSEManager } from '../http/sse-connection-manager';

const logger = createLogger('check-quota');

/** Human-readable labels for quota exceeded messages. */
const QUOTA_LABELS: Record<QuotaType, string> = {
  apiCalls: 'API call',
  pipelines: 'Pipeline',
  plugins: 'Plugin',
};

/**
 * Create middleware that checks a specific quota type before proceeding.
 *
 * On quota exceeded, returns a 429 response with quota details.
 * On quota service failure, fails open (allows the request).
 *
 * @param quotaService - Quota service client
 * @param sseManager - SSE manager for request context
 * @param quotaType - Which quota to check (e.g. 'apiCalls', 'pipelines', 'plugins')
 * @returns Express middleware
 */
export function checkQuota(
  quotaService: QuotaService,
  sseManager: SSEManager,
  quotaType: QuotaType,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = createRequestContext(req, res, sseManager);
    const orgId = ctx.identity.orgId!;
    const authHeader = req.headers.authorization || '';

    try {
      const quotaStatus = await quotaService.check(orgId, quotaType, authHeader);

      if (!quotaStatus.allowed) {
        logger.warn(`${quotaType} quota exceeded`, {
          orgId,
          limit: quotaStatus.limit,
          used: quotaStatus.used,
        });

        res.status(429).json({
          success: false,
          statusCode: 429,
          message: `${QUOTA_LABELS[quotaType]} quota exceeded. Please contact your administrator to increase your quota.`,
          code: ErrorCode.QUOTA_EXCEEDED,
          quota: {
            type: quotaType,
            limit: quotaStatus.limit,
            used: quotaStatus.used,
            remaining: quotaStatus.remaining,
          },
        });
        return;
      }

      next();
    } catch (error) {
      // Fail open — allow the request if quota service is unavailable
      logger.warn('Quota check failed, allowing request (fail-open)', {
        orgId,
        quotaType,
        error: error instanceof Error ? error.message : String(error),
      });
      next();
    }
  };
}
