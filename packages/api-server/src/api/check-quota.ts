// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { armDeferredQuotaCheck, createLogger, emitCounter, getQuotaServiceAuthHeader, isQuotaExemptRoute, isServicePrincipal, meteredQuotaTypeFor, sendQuotaExceeded, errorMessage, tagRouteGate } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaService } from '@pipeline-builder/api-core';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { getContext } from './get-context.js';

const logger = createLogger('check-quota');

/**
 * Create middleware that checks a specific quota type before proceeding.
 *
 * On quota exceeded, returns a 429 response with quota details (quotaType,
 * limit, used, resetAt, upgradeUrl — see api-core `sendQuotaExceeded`).
 * On quota service failure, fails open (allows the request).
 *
 * `apiCalls` is split per request by principal: an org service account is
 * checked against `automationCalls` instead ({@link meteredQuotaTypeFor}), the
 * same type `meterQuotaOnSuccess` increments — so mount both with `'apiCalls'`.
 *
 * Skipped (passes through) exactly where the meter skips, so the gate never
 * refuses a call the meter would not bill:
 * - a SERVICE PRINCIPAL (peer-service traffic is never metered, so a tenant at
 *   its limit must not break the internal calls its own earlier actions caused);
 * - an `apiCalls` request on the fleet-wide `QUOTA_EXEMPT_ROUTES` (console
 *   polling — an exhausted org must still render the banner saying so).
 *
 * Mountable at the app-routes level (`app.use(prefix, …auth, checkQuota(...))`):
 * the org comes from the request context when one is attached, else from the
 * verified `req.user.organizationId` — the same fallback the meter uses.
 *
 * @param quotaService - Quota service client
 * @param quotaType - Which quota to check (e.g. 'apiCalls', 'pipelines', 'plugins')
 * @returns Express middleware
 */
export function checkQuota(
  quotaService: QuotaService,
  baseQuotaType: QuotaType,
) {
  return tagRouteGate(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // The check is sent with THIS service's credentials, so it must only run for
    // a VERIFIED caller — otherwise the org would come from the spoofable
    // header-derived identity. Mounted after requireAuth everywhere; an
    // unauthenticated request here is a wiring bug, so skip (fail open) loudly.
    if (!req.user) {
      logger.warn('Quota check skipped: request is not authenticated');
      return next();
    }

    if (isServicePrincipal(req)) return next();
    if (baseQuotaType === 'apiCalls' && isQuotaExemptRoute(req.method, requestPath(req))) return next();

    const quotaType = meteredQuotaTypeFor(req, baseQuotaType);
    let orgId: string | undefined;

    try {
      orgId = getContext(req).identity.orgId;
    } catch {
      // No request context (platform attaches none): the verified auth org — the
      // same fallback `meterQuotaOnSuccess` uses, so both read one counter.
      orgId = req.user.organizationId;
    }

    // No org, nothing to bill (the meter skips it too). Not a 400: run deferred
    // from `requireAuth` this precedes the route's own `requireOrgId`, and a
    // route that needs no org (a person between orgs switching into one) must
    // not be refused by a quota gate.
    if (!orgId) return next();

    let quotaStatus: Awaited<ReturnType<QuotaService['check']>>;
    try {
      // Authenticate as THIS service, not by forwarding the user's token: the
      // user token 403s at the quota read route for custom roles without
      // `quotas:read`, and (being non-service) counts against the quota
      // service's per-IP limiter keyed on THIS pod's IP — both of which
      // silently fail the gate open under load.
      quotaStatus = await quotaService.check(orgId, quotaType, getQuotaServiceAuthHeader(orgId));
    } catch (error) {
      // Fail open — allow the request if quota service is unavailable
      logger.warn('QUOTA_FAIL_OPEN: Quota check exception, allowing request', {
        orgId,
        quotaType,
        error: errorMessage(error),
      });
      // Same counter the api-core quota client emits, so a quota-service outage
      // is ALERTABLE from one series regardless of which layer fell open. Only
      // a log line here meant every org was silently un-billed for the duration.
      emitCounter('quota_fail_open_total', { operation: 'check', reason: 'exception', quotaType });
      return next();
    }

    if (!quotaStatus.allowed) {
      logger.warn(`${quotaType} quota exceeded`, {
        orgId,
        limit: quotaStatus.limit,
        used: quotaStatus.used,
      });

      // Route through the shared helper so the check-gate 429 emits the same
      // Retry-After + X-Quota-* headers and the same body (which quota, the
      // reset date, the upgrade page) as the reserve-path 429.
      sendQuotaExceeded(
        res,
        quotaType,
        { type: quotaType, limit: quotaStatus.limit, used: quotaStatus.used, remaining: quotaStatus.remaining },
        quotaStatus.resetAt,
      );
      return;
    }

    // Outside the try: a synchronous throw downstream must reach Express's error
    // handling, not be mistaken for a quota-service failure and run next() twice.
    next();
  }, { kind: 'quota', mode: 'check', quotaType: baseQuotaType });
}

/** The service-local request path, without the query string. */
export function requestPath(req: Request): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
}

/**
 * The DEFERRED form of {@link checkQuota}: arms the check at mount time and lets
 * `requireAuth` run it once the caller is verified (api-core
 * `armDeferredQuotaCheck`). For a prefix mount ahead of routers that
 * authenticate per route — use {@link apiCallsQuota}, which pairs it with the
 * meter. Tagged as the check gate, so the route table records it.
 */
export function deferredCheckQuota(quotaService: QuotaService, quotaType: QuotaType): RequestHandler {
  const check = checkQuota(quotaService, quotaType) as RequestHandler;
  return tagRouteGate((_req: Request, res: Response, next: NextFunction): void => {
    armDeferredQuotaCheck(res, check);
    next();
  }, { kind: 'quota', mode: 'check', quotaType });
}
