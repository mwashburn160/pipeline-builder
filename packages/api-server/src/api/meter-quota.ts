// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { incrementQuota, isServicePrincipal, createLogger } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaService } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';
import { getContext } from './get-context.js';

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
 * - `incrementQuota` swallows its own errors (logs a warning);
 * - only 2xx responses are metered (a rejected/errored request costs nothing);
 * - a request with no VERIFIED org (`req.user.organizationId` — set by
 *   requireAuth, never the spoofable header identity) is skipped
 *   (unauthenticated / health / early-terminated);
 * - SERVICE-PRINCIPAL callers are skipped: internal service-to-service traffic
 *   (e.g. a peer calling compliance `validate`) must not burn a tenant's quota —
 *   the originating service already meters the user action that triggered it.
 *
 * Mount it once per route: a second meter for the same quota type on the same
 * request double-counts.
 *
 * @param quotaService - Quota service client
 * @param quotaType - Which quota to meter (e.g. 'apiCalls')
 */
export function meterQuotaOnSuccess(quotaService: QuotaService, quotaType: QuotaType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      try {
        // Only successful responses are billable.
        if (res.statusCode < 200 || res.statusCode >= 300) return;
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
        // incrementQuota authenticates as THIS service (the increment endpoint
        // is service-principal only — a forwarded user token is always 403).
        incrementQuota(
          quotaService,
          orgId,
          quotaType,
          (message, data) => logger.warn(message, data as Record<string, unknown>),
        );
      } catch {
        // Metering must never affect the response; a missing user/context just
        // means an unauthenticated or early-terminated request — skip silently.
      }
    });
    next();
  };
}
