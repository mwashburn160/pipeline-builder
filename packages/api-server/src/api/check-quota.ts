// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, createLogger, emitCounter, getQuotaServiceAuthHeader, sendError, sendQuotaExceeded } from '@pipeline-builder/api-core';
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
    // The check is sent with THIS service's credentials, so it must only run for
    // a VERIFIED caller — otherwise the org would come from the spoofable
    // header-derived identity. Mounted after requireAuth everywhere; an
    // unauthenticated request here is a wiring bug, so skip (fail open) loudly.
    if (!req.user) {
      logger.warn('Quota check skipped: request is not authenticated');
      return next();
    }

    let orgId: string | undefined;

    try {
      const ctx = getContext(req);
      orgId = ctx.identity.orgId;
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
      // Authenticate as THIS service, not by forwarding the user's token: the
      // user token 403s at the quota read route for custom roles without
      // `quotas:read`, and (being non-service) counts against the quota
      // service's per-IP limiter keyed on THIS pod's IP — both of which
      // silently fail the gate open under load.
      const quotaStatus = await quotaService.check(orgId, quotaType, getQuotaServiceAuthHeader(orgId));

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
      // Same counter the api-core quota client emits, so a quota-service outage
      // is ALERTABLE from one series regardless of which layer fell open. Only
      // a log line here meant every org was silently un-billed for the duration.
      emitCounter('quota_fail_open_total', { operation: 'check', reason: 'exception', quotaType });
      next();
    }
  };
}
