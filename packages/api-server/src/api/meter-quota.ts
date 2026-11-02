// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { incrementQuota, isQuotaExemptRoute, isServicePrincipal, createLogger, meteredQuotaTypeFor, quotaAttributionFromRequest, tagRouteGate } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaService } from '@pipeline-builder/api-core';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { deferredCheckQuota, requestPath } from './check-quota.js';
import { getContext } from './get-context.js';
import { isIdempotentReplay } from './idempotency-middleware.js';

const logger = createLogger('meter-quota');

/**
 * Middleware that METERS (increments) a quota counter once per SUCCESSFUL
 * request, on response `finish`.
 *
 * The complement to {@link checkQuota}: `checkQuota` only GATES (reads current
 * usage and 429s when over) — it never increments, so a service that mounts it
 * but never increments checks against a counter its own traffic never moves.
 * This is THE apiCalls metering convention: put it on each metered route (or
 * mount it ahead of a service's whole surface) rather than incrementing by hand
 * in handlers.
 *
 * Fire-and-forget + fail-safe by construction:
 * - runs in a `finish` listener, so it never blocks or fails the response;
 * - `incrementQuota` swallows its own errors (logs a warning, counts
 *   `quota_increment_failures_total`);
 * - only 2xx responses are metered (a rejected/errored request costs nothing);
 * - a response REPLAYED from the idempotency cache is skipped — the original
 *   request already paid, and the replay did no work. This holds whether the
 *   meter is mounted before or after the idempotency middleware: the flag is
 *   read at `finish`, after both have run;
 * - a request with no VERIFIED org (`req.user.organizationId` — set by
 *   requireAuth, never the spoofable header identity) is skipped
 *   (unauthenticated / health / early-terminated);
 * - SERVICE-PRINCIPAL callers are skipped: internal service-to-service traffic
 *   (e.g. a peer calling compliance `validate`) must not burn a tenant's quota —
 *   the originating service already meters the user action that triggered it.
 *   An ORG SERVICE ACCOUNT is not a service principal and IS metered — on
 *   `automationCalls` instead of `apiCalls` ({@link meteredQuotaTypeFor});
 * - an `apiCalls` request on the fleet-wide `QUOTA_EXEMPT_ROUTES` (console
 *   polling) is skipped.
 *
 * Every increment carries usage attribution (principal, key, route pattern,
 * pipeline, request id) for the quota service's usage ledger.
 *
 * Mount it once per route: a second meter for the same quota type on the same
 * request double-counts (the route table records each meter, and the quota
 * coverage check fails a route metered twice).
 *
 * @param quotaService - Quota service client
 * @param quotaType - Which quota to meter (e.g. 'apiCalls' — split per request
 *   into apiCalls / automationCalls by principal)
 */
export function meterQuotaOnSuccess(quotaService: QuotaService, quotaType: QuotaType) {
  return tagRouteGate((req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      try {
        // Only successful responses are billable.
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        // A cached replay did no work; the original already paid.
        if (isIdempotentReplay(res)) return;
        // Resolve the org id from the SAME source `checkQuota` reads —
        // `getContext().identity.orgId`, which is normalized (trimmed + lowercased).
        // Metering off the raw `req.user.organizationId` while the gate checks the
        // normalized id would land increments on a different key than the check
        // reads (a silent bypass if an org id ever carries mixed case). Fall back to
        // the raw auth org only when context middleware isn't mounted.
        //
        // Only a VERIFIED caller is metered. The increment is sent with THIS
        // service's credentials, so metering an org taken from the header-derived
        // identity of an unauthenticated request would let anyone burn a victim
        // org's quota by setting `x-org-id`.
        if (!req.user?.organizationId) return;
        let orgId: string | undefined;
        try { orgId = getContext(req).identity.orgId; } catch { orgId = req.user.organizationId; }
        if (!orgId) return;
        // Internal service-to-service calls must not consume a tenant's quota.
        if (isServicePrincipal(req)) return;
        // Console polling never spends a call.
        if (quotaType === 'apiCalls' && isQuotaExemptRoute(req.method, requestPath(req))) return;
        // incrementQuota authenticates as THIS service (the increment endpoint
        // is service-principal only — a forwarded user token is always 403).
        incrementQuota(
          quotaService,
          orgId,
          meteredQuotaTypeFor(req, quotaType),
          (message, data) => logger.warn(message, data as Record<string, unknown>),
          quotaAttributionFromRequest(req),
        );
      } catch {
        // Metering must never affect the response; a missing user/context just
        // means an unauthenticated or early-terminated request — skip silently.
      }
    });
    next();
  }, { kind: 'quota', mode: 'meter', quotaType });
}

/**
 * THE apiCalls convention for a service's user surface: meter once per 2xx AND
 * gate after authentication, mounted ONCE at the app-routes level ahead of the
 * routers it covers — `app.use('/things', ...apiCallsQuota(quotaService))`.
 *
 * The check is DEFERRED to `requireAuth` ({@link deferredCheckQuota}), so the
 * mount can precede routers that authenticate per route. Both halves skip
 * service principals, unauthenticated requests and the console-polling
 * `QUOTA_EXEMPT_ROUTES`; a service account spends `automationCalls`. A route
 * under such a prefix must NOT also mount its own `meterQuotaOnSuccess` for
 * apiCalls (that bills twice — the quota coverage check fails it).
 */
export function apiCallsQuota(quotaService: QuotaService): RequestHandler[] {
  return [
    meterQuotaOnSuccess(quotaService, 'apiCalls') as RequestHandler,
    deferredCheckQuota(quotaService, 'apiCalls'),
  ];
}
