import { ErrorCode, createLogger, getIdentity, sendError } from '@mwashburn160/api-core';
import type { QuotaType, QuotaService, HttpRequest } from '@mwashburn160/api-core';
import { Request, Response, NextFunction } from 'express';

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
 * @param quotaType - Which quota to check (e.g. 'apiCalls', 'pipelines', 'plugins')
 * @returns Express middleware
 */
export function checkQuota(
  quotaService: QuotaService,
  quotaType: QuotaType,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identity = req.context?.identity ?? getIdentity(req as HttpRequest);
    const orgId = identity.orgId;
    if (!orgId) {
      sendError(res, 400, 'Organization ID is required for quota check', ErrorCode.VALIDATION_ERROR);
      return;
    }
    const authHeader = req.headers.authorization || '';

    try {
      const quotaStatus = await quotaService.check(orgId, quotaType, authHeader);

      if (!quotaStatus.allowed) {
        logger.warn(`${quotaType} quota exceeded`, {
          orgId,
          limit: quotaStatus.limit,
          used: quotaStatus.used,
        });

        sendError(
          res,
          429,
          `${QUOTA_LABELS[quotaType]} quota exceeded. Please contact your administrator to increase your quota.`,
          ErrorCode.QUOTA_EXCEEDED,
          { quota: { type: quotaType, limit: quotaStatus.limit, used: quotaStatus.used, remaining: quotaStatus.remaining } },
        );
        return;
      }

      next();
    } catch (error) {
      // Fail open — allow the request if quota service is unavailable
      logger.warn('QUOTA_FAIL_OPEN: Quota check exception, allowing request', {
        orgId,
        quotaType,
        error: error instanceof Error ? error.message : String(error),
      });
      next();
    }
  };
}
