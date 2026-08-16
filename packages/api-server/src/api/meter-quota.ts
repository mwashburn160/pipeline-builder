// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { incrementQuota, isServicePrincipal, createLogger } from '@pipeline-builder/api-core';
import type { QuotaType, QuotaService } from '@pipeline-builder/api-core';
import type { Request, Response, NextFunction } from 'express';

const logger = createLogger('meter-quota');

/**
 * Middleware that METERS (increments) a quota counter once per SUCCESSFUL
 * request, on response `finish`.
 *
 * The complement to {@link checkQuota}: `checkQuota` only GATES (reads current
 * usage and 429s when over) — it never increments, so a service that mounts it
 * but never calls `incrementQuota` checks against a counter that its own traffic
 * never moves (the metering gap this fixes for the compliance service). Mount
 * this ALONGSIDE the auth/org chain to close the loop with one line instead of
 * threading `quotaService` + a manual `incrementQuotaFromCtx` through every
 * route factory and handler.
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
 * Do NOT combine this with a handler that already calls `incrementQuotaFromCtx`
 * for the same quota type on the same route — that double-counts.
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
        // Prefer the VERIFIED auth org over the spoofable header identity.
        const orgId = req.user?.organizationId;
        if (!orgId) return;
        // Internal service-to-service calls must not consume a tenant's quota.
        if (isServicePrincipal(req)) return;
        incrementQuota(
          quotaService,
          orgId,
          quotaType,
          req.headers.authorization || '',
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
