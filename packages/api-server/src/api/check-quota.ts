// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { armDeferredQuotaCheck, callQuotaExemption, createLogger, emitCounter, enforcedQuotaLimit, envInt, getQuotaServiceAuthHeader, isQuotaExemptRoute, meteredQuotaTypeFor, sendQuotaExceeded, errorMessage, tagRouteGate } from '@pipeline-builder/api-core';
import type { QuotaCheckResult, QuotaType, QuotaService } from '@pipeline-builder/api-core';
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { getContext } from './get-context.js';
import { hasCompletedIdempotentResponse } from './idempotency-middleware.js';

const logger = createLogger('check-quota');

// PER-POD CHECK CACHE.
//
// The gate used to ask the quota service on EVERY metered request — a GET, a
// JWT verify and a hierarchy resolve over there, per request here. A reading is
// now reused per (org, quota type):
//  - an ALLOWED reading for `QUOTA_CHECK_CACHE_TTL_MS` (default 5000; 0 turns
//    the cache off), and only while this pod has passed fewer requests on it
//    than the reading had headroom for (`enforcedQuotaLimit − used`), so one
//    pod cannot run far past a nearly-full counter on a stale "yes";
//  - a DENIED reading until the period resets, capped at
//    `QUOTA_CHECK_DENIED_CACHE_MS` (default 60000) so an upgrade, a bundle
//    purchase or an operator reset is honoured within a minute;
//  - a fail-open sentinel is NEVER cached — recovery is seen on the next request.
// Staleness is bounded and accepted: the counter itself never exceeds the cap
// (the metered increment admits only what fits and records the rest as
// overshoot), so a stale "yes" costs at most a few unbilled-over-cap requests
// per pod per TTL, never an unbounded run. Concurrent misses for one key share
// a single in-flight read.

/** TTL (ms) of a cached ALLOWED check. `0` disables the cache. */
export const QUOTA_CHECK_CACHE_TTL_MS = envInt('QUOTA_CHECK_CACHE_TTL_MS', 5000, { min: 0 });

/** Longest (ms) a DENIED check is reused before re-asking (it never outlives `resetAt`). */
export const QUOTA_CHECK_DENIED_CACHE_MS = envInt('QUOTA_CHECK_DENIED_CACHE_MS', 60000, { min: 0 });

/** Bound on cached (org, type) readings per pod. */
const CHECK_CACHE_MAX_ENTRIES = 10_000;

interface CachedCheck {
  status: QuotaCheckResult;
  expiresAt: number;
  /** Requests this pod let through on this reading. */
  passes: number;
}

const checkCache = new Map<string, CachedCheck>();
const inFlightChecks = new Map<string, Promise<QuotaCheckResult>>();

/** Drop every cached check (tests; also a safe operational reset). */
export function clearQuotaCheckCache(): void {
  checkCache.clear();
  inFlightChecks.clear();
}

/** A usable cached reading for `key`, counting this request against its headroom. */
function cachedCheck(key: string, quotaType: QuotaType): QuotaCheckResult | null {
  const hit = checkCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    checkCache.delete(key);
    return null;
  }
  if (!hit.status.allowed) return hit.status;
  if (hit.status.limit !== -1) {
    const headroom = enforcedQuotaLimit(quotaType, hit.status.limit) - hit.status.used;
    if (hit.passes >= headroom) {
      checkCache.delete(key);
      return null;
    }
  }
  hit.passes += 1;
  return hit.status;
}

function rememberCheck(key: string, status: QuotaCheckResult): void {
  if (!status || status.failOpen) return;
  const now = Date.now();
  let expiresAt: number;
  if (status.allowed) {
    if (QUOTA_CHECK_CACHE_TTL_MS === 0) return;
    expiresAt = now + QUOTA_CHECK_CACHE_TTL_MS;
  } else {
    if (QUOTA_CHECK_DENIED_CACHE_MS === 0) return;
    const resetAt = Date.parse(status.resetAt);
    expiresAt = Math.min(now + QUOTA_CHECK_DENIED_CACHE_MS, Number.isFinite(resetAt) ? resetAt : now);
    if (expiresAt <= now) return;
  }
  if (checkCache.size >= CHECK_CACHE_MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the oldest reading.
    const oldest = checkCache.keys().next();
    if (!oldest.done) checkCache.delete(oldest.value);
  }
  // The request that fetched the reading is its first pass.
  checkCache.set(key, { status, expiresAt, passes: status.allowed ? 1 : 0 });
}

/**
 * One quota read for (org, type), shared by every concurrent miss on this pod.
 * A request that waited on someone else's read then goes back through the
 * cache, so it is counted against the reading's headroom like any other pass
 * (`joined` stops it from waiting a second time).
 */
async function readCheck(quotaService: QuotaService, orgId: string, quotaType: QuotaType, joined = false): Promise<QuotaCheckResult> {
  const key = `${orgId}\u0000${quotaType}`;
  const cached = cachedCheck(key, quotaType);
  if (cached) return cached;
  const pending = inFlightChecks.get(key);
  if (pending) {
    if (joined) return pending;
    const status = await pending;
    // A fail-open (or uncacheable) reading has nothing to account against.
    return checkCache.has(key) ? readCheck(quotaService, orgId, quotaType, true) : status;
  }
  // Authenticate as THIS service, not by forwarding the user's token: the user
  // token 403s at the quota read route for custom roles without `quotas:read`,
  // and (being non-service) counts against the quota service's per-IP limiter
  // keyed on THIS pod's IP — both of which silently fail the gate open under load.
  const read = quotaService.check(orgId, quotaType, getQuotaServiceAuthHeader(orgId))
    .then((status) => {
      rememberCheck(key, status);
      return status;
    })
    .finally(() => inFlightChecks.delete(key));
  inFlightChecks.set(key, read);
  return read;
}

/**
 * Create middleware that checks a specific quota type before proceeding.
 *
 * On quota exceeded, returns a 429 response with quota details (quotaType,
 * limit, used, resetAt, upgradeUrl — see api-core `sendQuotaExceeded`).
 * On quota service failure, fails open (allows the request).
 *
 * `apiCalls` is split per request by principal: an org service account or a
 * personal access key is checked against `automationCalls` instead
 * ({@link meteredQuotaTypeFor}), the
 * same type `meterQuotaOnSuccess` increments — so mount both with `'apiCalls'`.
 *
 * Skipped (passes through) exactly where the meter skips, so the gate never
 * refuses a call the meter would not bill (`callQuotaExemption`):
 * - a SERVICE PRINCIPAL (peer-service traffic is never metered, so a tenant at
 *   its limit must not break the internal calls its own earlier actions caused);
 * - for `apiCalls`: an IMPERSONATION session (vendor staff diagnosing an
 *   exhausted org must not be locked out by it) and an ON-BEHALF hop (a user
 *   token forwarded by ask/pipeline with a signed marker — the originating
 *   request was already gated and metered);
 * - an `apiCalls` request on the fleet-wide `QUOTA_EXEMPT_ROUTES` (console
 *   polling — an exhausted org must still render the banner saying so);
 * - an idempotent RETRY whose original already completed (the replay is served
 *   from the idempotency cache, does no work and is never metered; refusing it
 *   would 429 a client for asking what its own earlier request returned).
 *
 * Readings are cached per pod (see the cache notes above), and the read itself
 * has a short budget (api-core `QUOTA_CHECK_TIMEOUT_MS`, no retry) — a slow
 * quota service fails open quickly instead of stalling every request.
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

    const exemption = callQuotaExemption(req);
    if (exemption === 'service' || (exemption && baseQuotaType === 'apiCalls')) return next();
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

    // A retry of a completed idempotent mutation is answered from the replay
    // cache without running the handler — nothing to gate (one store read, only
    // for requests that carry an Idempotency-Key).
    if (await hasCompletedIdempotentResponse(req)) return next();

    let quotaStatus: QuotaCheckResult;
    try {
      quotaStatus = await readCheck(quotaService, orgId, quotaType);
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
