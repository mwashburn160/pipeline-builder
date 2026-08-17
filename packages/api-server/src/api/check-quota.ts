// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, createLogger, sendError, sendQuotaExceeded } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaService } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';
import { getContext } from './get-context.js';

const logger = createLogger('check-quota');

/** Human-readable labels for quota exceeded messages. */
const QUOTA_LABELS: Record<QuotaType, string> = {
  apiCalls: 'API call',
  aiCalls: 'AI call',
  pipelines: 'Pipeline',
  plugins: 'Plugin',
  storageBytes: 'Registry storage',
  dashboards: 'Dashboard',
  alertRules: 'Alert rule',
  alertDestinations: 'Alert destination',
  idpConfigs: 'IdP configuration',
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
    let orgId: string | undefined;
    let authHeader = '';

    try {
      const ctx = getContext(req);
      orgId = ctx.identity.orgId;
      authHeader = req.headers.authorization || '';
    } catch {
      // Context middleware not applied — fail open (log and continue)
      logger.warn('Quota check skipped: request context not initialized');
      return next();
    }

    if (!orgId) {
      sendError(res, 400, 'Organization ID is required for quota check', ErrorCode.VALIDATION_ERROR);
      return;
    }

    try {
      const quotaStatus = await quotaService.check(orgId, quotaType, authHeader);

      if (!quotaStatus.allowed) {
        logger.warn(`${quotaType} quota exceeded`, {
          orgId,
          limit: quotaStatus.limit,
          used: quotaStatus.used,
        });

        // Route through the shared helper so the check-gate 429 emits the same
        // Retry-After + X-Quota-* headers as the reserve-path 429 (the inline
        // 429 this replaced omitted them). Custom message keeps the
        // "contact your administrator" copy.
        sendQuotaExceeded(
          res,
          quotaType,
          { type: quotaType, limit: quotaStatus.limit, used: quotaStatus.used, remaining: quotaStatus.remaining },
          quotaStatus.resetAt,
          `${QUOTA_LABELS[quotaType]} quota exceeded. Please contact your administrator to increase your quota.`,
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
