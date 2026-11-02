// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Request, Response } from 'express';

import { currentAuditContext, sanitizeCorrelationId } from './audit-context.js';
import { createSafeClient, type RequestOptions } from './http-client.js';
import { getServiceAuthHeader } from '../middleware/service-tokens.js';
import { SYSTEM_ORG_ID } from '../middleware/system-org.js';
import type { JwtPayload, PrincipalType, QuotaType, QuotaCheckResult, ServiceConfig } from '../types/common.js';
import { ErrorCode } from '../types/error-codes.js';
import { DEFAULT_TIER, isValidTier, type QuotaTier } from '../types/quota-tiers.js';
import { envBool } from '../utils/env.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';
import { errorMessage, sendError, sendQuotaExceeded } from '../utils/response.js';
import { serviceEndpoint } from '../utils/service-registry.js';

/**
 * Retry options for quota calls — fail fast (a slow quota service must not stall the request).
 *
 * NEVER retry a 429. The quota service answers an over-limit org with 429
 * QUOTA_EXCEEDED and `Retry-After` = seconds until the period resets; the HTTP
 * client honors that (capped at 60s), so a single rate-limit retry stalled the
 * request well past the handler timeout, which then answered 503 and the real
 * 429 was lost. A 429 is a final answer here.
 */
const QUOTA_REQUEST_OPTIONS: Pick<RequestOptions, 'maxRateLimitRetries' | 'maxRetries'> = {
  maxRateLimitRetries: 0,
  maxRetries: 1,
};

const logger = createLogger('quota');

// RESERVE FAIL MODE — explicit, single policy.
//
// `reserve` gates EXPENSIVE, billable resources (pipelines, plugin builds, AI
// calls, platform feature slots). Every quota type is a per-period FLOW counter
// with no after-the-fact reconciliation: a unit consumed while the reservation
// could not be confirmed is never counted, so fail-open lets an org consume
// unbounded unmetered units for the whole length of an incident — and an
// unconfirmed reserve (timeout, open circuit) may even have landed server-side.
// So `reserve` fails CLOSED whenever the quota service did not CONFIRM the slot:
//   - unreachable / timed out / circuit breaker open (no response),
//   - a reachable-but-errored response (5xx, 4xx, malformed body),
//   - a 429 that is NOT a genuine QUOTA_EXCEEDED (gateway / rate limiter).
// Operators who prefer availability over enforcement opt the WHOLE set into
// fail-open with QUOTA_RESERVE_FAIL_OPEN=true. Both outcomes emit a counter
// (`quota_fail_closed_total` / `quota_fail_open_total`) tagged with the reason.
// `check` (a cheap read gate) stays fail-open; `increment` is fire-and-forget.
const QUOTA_RESERVE_FAIL_OPEN = envBool('QUOTA_RESERVE_FAIL_OPEN', false);

// USAGE ATTRIBUTION — who spent a unit.
//
// The quota service keeps one aggregate counter per (org, type); on its own that
// can say an org is at 100% but never WHICH key, route or pipeline got it there.
// Every increment / reserve / refund therefore carries an attribution block the
// quota service writes into its usage ledger (`GET /quotas/:orgId/usage`). It is
// metadata only — enforcement never reads it — and every field is optional, so a
// caller that knows nothing still meters correctly.

/** Who / what spent (or got back) a quota unit. All fields optional. */
export interface QuotaUsageAttribution {
  principalType?: PrincipalType;
  /** The user id or service-account id behind the call (the token's `sub`). */
  principalId?: string;
  /** The revocable credential: the access key the token derives from, else its `jti`. */
  keyId?: string;
  /** `METHOD /route/:pattern` — the matched route PATTERN, never the raw URL (no ids, no query). */
  route?: string;
  /** The pipeline the call was made for (`:pipelineId` param or `X-Pipeline-Id` header). */
  pipelineId?: string;
  requestId?: string;
}

/** Longest attribution string the client sends (the quota service enforces the same bound). */
const MAX_ATTRIBUTION_LEN = 200;

function bounded(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_ATTRIBUTION_LEN) : undefined;
}

/** The principal half of an attribution block, from a VERIFIED token. */
function principalAttribution(user: JwtPayload | undefined): QuotaUsageAttribution {
  if (!user) return {};
  return {
    principalType: user.principalType,
    principalId: bounded(user.sub),
    keyId: bounded(user.parentKeyId ?? user.jti),
  };
}

/**
 * Attribution for the request being served: the verified principal, the matched
 * route pattern, the pipeline (`:pipelineId` param or a sanitized
 * `X-Pipeline-Id` header) and the request id. Read off `req` directly rather than
 * the ambient audit context because the metering middleware runs in a `finish`
 * listener, where the request's async scope is no longer guaranteed.
 */
export function quotaAttributionFromRequest(req: Request): QuotaUsageAttribution {
  const routePath = req.route?.path;
  const route = typeof routePath === 'string' ? `${req.method} ${(req.baseUrl ?? '') + routePath}` : undefined;
  const header = req.headers['x-pipeline-id'];
  const pipelineId = sanitizeCorrelationId(req.params?.pipelineId) ?? sanitizeCorrelationId(Array.isArray(header) ? header[0] : header);
  const requestIdHeader = req.headers['x-request-id'];
  const requestId = (req as Request & { requestId?: string }).requestId
    ?? sanitizeCorrelationId(Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader);
  return {
    ...principalAttribution(req.user),
    ...(route ? { route: route.slice(0, MAX_ATTRIBUTION_LEN) } : {}),
    ...(pipelineId ? { pipelineId } : {}),
    ...(requestId ? { requestId: bounded(requestId) } : {}),
  };
}

/**
 * Attribution from the ambient audit context, for calls made inside a request
 * scope that did not pass one explicitly (the reserve / refund helpers every
 * service uses). Empty outside any scope.
 */
function attributionFromContext(): QuotaUsageAttribution {
  const ctx = currentAuditContext();
  if (!ctx) return {};
  return {
    ...principalAttribution(ctx.principal?.()),
    ...(ctx.requestId ? { requestId: bounded(ctx.requestId) } : {}),
  };
}

/** The attribution a quota write sends: the explicit block, else the ambient one. */
function resolveAttribution(explicit?: QuotaUsageAttribution): QuotaUsageAttribution | undefined {
  const resolved = explicit ?? attributionFromContext();
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * The quota type a metered request actually spends.
 *
 * `apiCalls` is the PEOPLE's budget. A request made by an org service account
 * (automation: platform-automation, pipeline-register, reporting-ingest,
 * registry-push keys) spends `automationCalls` instead — never both — so a fleet
 * of self-mutating pipelines can't exhaust the console for the humans in the
 * same org. Every other type is returned unchanged: an AI call or a pipeline
 * creation costs the same whoever makes it.
 *
 * `meterQuotaOnSuccess` and `checkQuota` call this themselves, so a service
 * mounts both with `'apiCalls'` and the split happens per request.
 */
export function meteredQuotaTypeFor(req: Pick<Request, 'user'>, quotaType: QuotaType): QuotaType {
  if (quotaType === 'apiCalls' && req.user?.principalType === 'service_account') return 'automationCalls';
  return quotaType;
}

/**
 * Service-principal `Authorization` header for a quota call made on behalf of
 * `orgId` by the CURRENT service (`SERVICE_NAME`, the same identity the health
 * router reports).
 *
 * The quota service's mutation endpoints (`/:orgId/increment`, `/decrement`)
 * reject anything but a signed service principal or a system admin, so
 * forwarding the end user's bearer token there is always a 403. Service tokens
 * are also exempt from the quota service's per-IP rate limiter, so hot-path
 * quota traffic from a busy pod can't exhaust that pod IP's bucket and silently
 * turn enforcement off. Scoped to the target org with the lowest role (member).
 */
export function getQuotaServiceAuthHeader(orgId: string): string {
  return getServiceAuthHeader({ serviceName: process.env.SERVICE_NAME || 'api', orgId, role: 'member' });
}

/**
 * Result of a synchronous quota reservation  the atomic check+increment
 * variant. `exceeded: true` means the operation was rejected at the DB
 * level; the caller should return 429 without running the gated action.
 */
export interface QuotaReserveResult {
  /** True when the slot was NOT reserved — the gated action must not run. */
  exceeded: boolean;
  /**
   * Set (true) by the quota CLIENT when the reservation was denied because the
   * quota service could not CONFIRM it (unreachable / timeout / circuit open /
   * errored) — not because the org is over its limit. Always paired with
   * `exceeded: true`. Answer with {@link sendQuotaReserveDenied}, which maps it to
   * 503 instead of a misleading 429 "quota exceeded".
   */
  unavailable?: boolean;
  quota: {
    type: QuotaType;
    limit: number;
    used: number;
    remaining: number;
    resetAt?: string;
  };
}

/**
 * Quota service client interface.
 */
export interface QuotaService {
  /** Check if quota is available (fail-open on error). */
  check(orgId: string, quotaType: QuotaType, authHeader: string, requestId?: string): Promise<QuotaCheckResult>;
  /**
   * Increment quota usage. Returns a promise so callers can optionally handle
   * errors. `attribution` defaults to the ambient request context.
   */
  increment(orgId: string, quotaType: QuotaType, authHeader: string, amount?: number, attribution?: QuotaUsageAttribution): Promise<void>;
  /**
   * Atomic reserve  the same atomic check+increment as `increment`, but
   * parses the response so callers can see whether the slot was actually
   * reserved. Use this for expensive resources where the post-hoc fire-
   * and-forget pattern allows concurrent over-spend.
   *
   * Fails CLOSED (`exceeded: true`) whenever the slot is not confirmed —
   * unreachable, timeout, open circuit, non-ok, or a non-quota 429 — unless
   * `QUOTA_RESERVE_FAIL_OPEN=true` (see the policy note at the top of this file).
   */
  reserve(orgId: string, quotaType: QuotaType, authHeader: string, amount?: number, attribution?: QuotaUsageAttribution): Promise<QuotaReserveResult>;
  /**
   * Roll back a previously reserved slot. Fire-and-forget — never throws.
   * Pass `resetAtSnapshot` (the `quota.resetAt` observed when the slot was
   * reserved) to make the rollback conditional: if the period rolled over
   * between reserve and rollback, the server skips the decrement so it doesn't
   * steal capacity from the new period.
   */
  decrement(orgId: string, quotaType: QuotaType, authHeader: string, amount?: number, resetAtSnapshot?: string, attribution?: QuotaUsageAttribution): Promise<void>;
  /**
   * Get the org's quota `QuotaTier`. Used by the plugin-build queue partitioning
   * to route a build to the right per-tier queue. Fail-open returns `DEFAULT_TIER`
   * (`developer` when billing is enabled, `unlimited` when it's disabled); a
   * misclassified org still builds on the default queue, just without the
   * tier-scoped scheduling boost.
   */
  getTier(orgId: string, authHeader: string, requestId?: string): Promise<QuotaTier>;
  /**
   * FAIL-CLOSED twin of {@link getTier}: the org's tier as the quota service
   * CONFIRMED it, or `null` when it could not be confirmed (unreachable, non-ok,
   * missing or unrecognized tier). For decisions that must never be taken on a
   * guess — anything that revokes, downgrades or deletes on the strength of a
   * tier (e.g. a verified-publisher grace sweep) must skip the org on `null`,
   * never act on `DEFAULT_TIER`.
   */
  getTierStrict(orgId: string, authHeader: string, requestId?: string): Promise<QuotaTier | null>;
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
 * Apply the explicit reserve fail-mode policy to a reservation the quota service
 * did NOT confirm (see QUOTA_RESERVE_FAIL_OPEN above). Default: deny.
 */
function unconfirmedReserve(
  orgId: string,
  quotaType: QuotaType,
  reason: 'unreachable' | 'transient-429' | 'non-ok',
  statusCode?: number,
): QuotaReserveResult {
  if (QUOTA_RESERVE_FAIL_OPEN) {
    logger.warn('QUOTA_FAIL_OPEN: quota reserve not confirmed, allowing request', { orgId, quotaType, reason, statusCode });
    emitCounter('quota_fail_open_total', { operation: 'reserve', reason, quotaType });
    return { exceeded: false, quota: { type: quotaType, limit: -1, used: 0, remaining: -1 } };
  }
  logger.warn('QUOTA_FAIL_CLOSED: quota reserve not confirmed, denying request', { orgId, quotaType, reason, statusCode });
  emitCounter('quota_fail_closed_total', { operation: 'reserve', reason, quotaType });
  return { exceeded: true, unavailable: true, quota: { type: quotaType, limit: 0, used: 0, remaining: 0 } };
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
    // Tag the sentinel so fail-closed callers can tell an outage apart from a
    // real unlimited (-1) reading. Real quota results never set this.
    failOpen: true,
  };
}

/**
 * Build common request headers with optional request ID for distributed tracing.
 */
function buildHeaders(orgId: string, authHeader?: string, requestId?: string): Record<string, string> {
  const headers: Record<string, string> = { 'x-org-id': orgId };
  if (authHeader) headers.Authorization = authHeader;
  if (requestId) headers['X-Request-Id'] = requestId;
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
 * return res.status(429).json({ error: 'Quota exceeded' });
 * }
 *
 * // Increment quota after success
 * quotaService.increment(orgId, 'apiCalls', authHeader).catch(err => logger.warn('Quota increment failed', { error: err }));
 * ```
 */
export function createQuotaService(config: QuotaServiceConfig = {}): QuotaService {
  const serviceConfig: ServiceConfig = {
    host: config.host ?? serviceEndpoint('quota').host,
    port: config.port ?? serviceEndpoint('quota').port,
    timeout: config.timeout ?? 5000,
  };

  const client = createSafeClient(serviceConfig);

  /** One tier read: the confirmed tier, or why there isn't one. */
  async function readTier(
    orgId: string, authHeader: string, requestId?: string,
  ): Promise<{ tier: QuotaTier; reason?: undefined; statusCode?: number } | { tier: null; reason: 'unreachable' | 'non-ok' | 'invalid-tier'; statusCode?: number }> {
    const response = await client.get<{
      success: boolean;
      data?: { quota?: { tier?: string } };
      message?: string;
    }>(`/quotas/${encodeURIComponent(orgId)}`, { headers: buildHeaders(orgId, authHeader, requestId), ...QUOTA_REQUEST_OPTIONS });
    if (!response) return { tier: null, reason: 'unreachable' };
    if (response.statusCode !== 200 || !response.body?.success) return { tier: null, reason: 'non-ok', statusCode: response.statusCode };
    const tier = response.body.data?.quota?.tier;
    if (!tier || !isValidTier(tier)) return { tier: null, reason: 'invalid-tier', statusCode: response.statusCode };
    return { tier, statusCode: response.statusCode };
  }

  return {
    async check(orgId: string, quotaType: QuotaType, authHeader: string, requestId?: string): Promise<QuotaCheckResult> {
      const path = `/quotas/${encodeURIComponent(orgId)}/${encodeURIComponent(quotaType)}`;

      const response = await client.get<{
        success: boolean;
        data?: { quotaType: string; status: QuotaCheckResult };
        message?: string;
      }>(path, { headers: buildHeaders(orgId, authHeader, requestId), ...QUOTA_REQUEST_OPTIONS });

      if (!response) {
        logger.warn('QUOTA_FAIL_OPEN: Quota service unreachable, allowing request', { orgId, quotaType });
        emitCounter('quota_fail_open_total', { operation: 'check', reason: 'unreachable', quotaType });
        return createFailOpenResult();
      }

      if (response.statusCode !== 200 || !response.body.success || !response.body.data?.status) {
        logger.warn('QUOTA_FAIL_OPEN: Quota check returned non-ok, allowing request', {
          orgId, quotaType, statusCode: response.statusCode, message: response.body.message,
        });
        emitCounter('quota_fail_open_total', { operation: 'check', reason: 'non-ok', quotaType });
        return createFailOpenResult();
      }

      return response.body.data.status;
    },

    async increment(orgId: string, quotaType: QuotaType, authHeader: string, amount: number = 1, attribution?: QuotaUsageAttribution): Promise<void> {
      const path = `/quotas/${encodeURIComponent(orgId)}/increment`;
      const attr = resolveAttribution(attribution);

      const response = await client
        .post(path, { quotaType, amount, ...(attr && { attribution: attr }) }, { headers: buildHeaders(orgId, authHeader, attr?.requestId), ...QUOTA_REQUEST_OPTIONS });

      if (response?.statusCode === 429) {
        // Over the limit: the quota service refused AND recorded the denial in
        // its ledger. Not a failure of metering — the counter is exactly where
        // it should be.
        logger.debug('Quota increment refused (over limit)', { orgId, quotaType, amount });
      } else if (!response || response.statusCode !== 200) {
        logger.warn('Failed to increment quota', {
          orgId, quotaType, amount, statusCode: response?.statusCode,
        });
        // A lost metering increment is a unit the org consumed and never paid
        // for. Counted (labelled by the emitting `service`) so a sustained rate
        // pages instead of silently under-billing — see QuotaIncrementFailures.
        emitCounter('quota_increment_failures_total', { reason: response ? 'non-ok' : 'unreachable', quotaType });
      } else {
        logger.debug('Quota incremented', { orgId, quotaType, amount });
      }
    },

    async reserve(orgId: string, quotaType: QuotaType, authHeader: string, amount: number = 1, attribution?: QuotaUsageAttribution): Promise<QuotaReserveResult> {
      const path = `/quotas/${encodeURIComponent(orgId)}/increment`;
      const attr = resolveAttribution(attribution);

      // 200 carries `data.quota`; 429 (QUOTA_EXCEEDED) carries `details.quota`.
      // Both shapes are normalized into QuotaReserveResult.
      const response = await client.post<{
        success: boolean;
        data?: { quota?: QuotaReserveResult['quota'] };
        details?: { quota?: QuotaReserveResult['quota'] };
        /** `sendError`'s error-code field. */
        code?: string;
      }>(path, { quotaType, amount, ...(attr && { attribution: attr }) }, { headers: buildHeaders(orgId, authHeader, attr?.requestId), ...QUOTA_REQUEST_OPTIONS });

      if (!response) return unconfirmedReserve(orgId, quotaType, 'unreachable');

      if (response.statusCode === 429) {
        const q = response.body.details?.quota;
        // Only a GENUINE quota-exceeded 429 means "over quota". A generic 429 —
        // an intervening gateway or rate limiter — did not confirm anything, so
        // it goes through the same unconfirmed-reservation policy as an outage.
        if (response.body.code === ErrorCode.QUOTA_EXCEEDED || q) {
          return {
            exceeded: true,
            quota: q ?? { type: quotaType, limit: 0, used: 0, remaining: 0 },
          };
        }
        return unconfirmedReserve(orgId, quotaType, 'transient-429', response.statusCode);
      }

      if (response.statusCode !== 200 || !response.body.success) {
        return unconfirmedReserve(orgId, quotaType, 'non-ok', response.statusCode);
      }

      const q = response.body.data?.quota;
      return {
        exceeded: false,
        quota: q ?? { type: quotaType, limit: -1, used: 0, remaining: -1 },
      };
    },

    async decrement(orgId: string, quotaType: QuotaType, authHeader: string, amount: number = 1, resetAtSnapshot?: string, attribution?: QuotaUsageAttribution): Promise<void> {
      const path = `/quotas/${encodeURIComponent(orgId)}/decrement`;
      const attr = resolveAttribution(attribution);
      const response = await client
        .post(path, { quotaType, amount, ...(resetAtSnapshot && { resetAtSnapshot }), ...(attr && { attribution: attr }) }, { headers: buildHeaders(orgId, authHeader, attr?.requestId), ...QUOTA_REQUEST_OPTIONS });

      if (!response || response.statusCode !== 200) {
        // Rollback failure is logged but never propagated  the action's own
        // failure has already been surfaced to the caller; a stuck counter
        // resolves on the next period reset.
        logger.warn('Failed to decrement quota (slot will reset on next period)', {
          orgId, quotaType, amount, statusCode: response?.statusCode,
        });
      } else {
        logger.debug('Quota decremented', { orgId, quotaType, amount });
      }
    },

    async getTier(orgId: string, authHeader: string, requestId?: string): Promise<QuotaTier> {
      const known = constantTierFor(orgId);
      if (known) return known;
      const read = await readTier(orgId, authHeader, requestId);
      if (read.tier) return read.tier;
      logger.warn(`QUOTA_FAIL_OPEN: tier lookup failed, defaulting to ${DEFAULT_TIER} tier`, {
        orgId, statusCode: read.statusCode, reason: read.reason, defaultTier: DEFAULT_TIER,
      });
      emitCounter('quota_fail_open_total', { operation: 'tier', reason: read.reason, quotaType: 'tier' });
      return DEFAULT_TIER;
    },

    async getTierStrict(orgId: string, authHeader: string, requestId?: string): Promise<QuotaTier | null> {
      const known = constantTierFor(orgId);
      if (known) return known;
      const read = await readTier(orgId, authHeader, requestId);
      if (read.tier) return read.tier;
      logger.warn('QUOTA_FAIL_CLOSED: tier could not be confirmed', { orgId, statusCode: read.statusCode, reason: read.reason });
      emitCounter('quota_fail_closed_total', { operation: 'tier', reason: read.reason, quotaType: 'tier' });
      return null;
    },
  };
}

/**
 * The system org's tier is a CONSTANT, not a billing fact, so it is answered
 * without a lookup.
 *
 * The platform's own org is always `unlimited` (platform/src/services/
 * auth-service.ts seeds it that way): nothing meters it and it is never sold.
 * Asking the quota service was therefore a network hop whose only possible
 * outcomes were the answer we already knew, or a failure.
 *
 * The failure is what made this worth fixing. `getTier` fails OPEN to
 * DEFAULT_TIER, which with billing enabled is `developer` — the most
 * constrained tier — and its documented job is build-queue partitioning. A
 * blip in the quota service therefore routed the SYSTEM org's builds onto the
 * developer queue; the Official catalog load is 119 of them. `getTierStrict`
 * fails CLOSED to null, so a sweep that must not guess would skip the
 * platform's own org instead.
 */
function constantTierFor(orgId: string): QuotaTier | null {
  return orgId.toLowerCase() === SYSTEM_ORG_ID ? 'unlimited' : null;
}

/**
 * Fire-and-forget quota METERING increment with standardized error logging.
 *
 * Authenticates as the calling SERVICE ({@link getQuotaServiceAuthHeader}), never
 * with the end user's token: `/quotas/:orgId/increment` is service-principal /
 * system-admin only, so a forwarded user JWT was always rejected (403) and the
 * metered quota (e.g. `apiCalls`, and the `api_pack` bundle raising it) never
 * moved.
 *
 * @param quotaService - Quota service client
 * @param orgId - Organization ID whose counter is incremented
 * @param quotaType - Quota type to increment
 * @param logWarn - Logging function for warnings
 * @param attribution - Who spent the unit (defaults to the ambient request context)
 */
export function incrementQuota( quotaService: QuotaService,
  orgId: string,
  quotaType: QuotaType,
  logWarn: (message: string, data?: unknown) => void,
  attribution?: QuotaUsageAttribution,
): void {
  const auth = getQuotaServiceAuthHeader(orgId);
  // Without an explicit block the client resolves attribution from the ambient
  // request context, so the call keeps its original shape.
  const sent = attribution
    ? quotaService.increment(orgId, quotaType, auth, 1, attribution)
    : quotaService.increment(orgId, quotaType, auth);
  sent.catch((err: unknown) => {
    logWarn('Quota increment failed', { error: errorMessage(err) });
    emitCounter('quota_increment_failures_total', { reason: 'exception', quotaType });
  });
}

/**
 * Atomic reserve helper for the "reserve + commit / rollback" pattern.
 * Use for expensive resources (pipelines, plugins, AI calls) where the
 * fire-and-forget post-hoc `incrementQuota` allows concurrent over-spend.
 *
 * Returns the structured result so the caller can decide whether to run
 * the gated action or 429 the client.
 *
 * @example
 * ```typescript
 * const reservation = await reserveQuota(quotaService, orgId, 'pipelines', authHeader);
 * if (reservation.exceeded) return sendQuotaReserveDenied(res, 'pipelines', reservation);
 * try {
 * await doExpensiveThing();
 * } catch (err) {
 * // Pass the reserved resetAt so a period rollover doesn't get double-charged.
 * decrementQuota(quotaService, orgId, 'pipelines', authHeader, logWarn, 1, reservation.quota.resetAt);
 * throw err;
 * }
 * ```
 */
export function reserveQuota( quotaService: QuotaService,
  orgId: string,
  quotaType: QuotaType,
  authHeader: string,
  amount: number = 1,
  attribution?: QuotaUsageAttribution,
): Promise<QuotaReserveResult> {
  return quotaService.reserve(orgId, quotaType, authHeader, amount, attribution);
}

/** Seconds a client should wait before retrying when quota couldn't be confirmed. */
const QUOTA_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Answer a DENIED reservation (`reservation.exceeded === true`).
 *
 * - `unavailable` (the quota service couldn't confirm the slot) → **503**
 *   `SERVICE_UNAVAILABLE` with a short `Retry-After`: the org is not over its
 *   limit, so a 429 "quota exceeded" would send users to upgrade for an outage.
 * - otherwise → the standard 429 `QUOTA_EXCEEDED` with the X-Quota-* headers.
 */
export function sendQuotaReserveDenied(res: Response, quotaType: QuotaType, reservation: QuotaReserveResult): void {
  if (reservation.unavailable) {
    if (!res.headersSent) res.setHeader('Retry-After', QUOTA_UNAVAILABLE_RETRY_AFTER_SECONDS);
    sendError(
      res,
      503,
      `Unable to confirm ${quotaType} quota right now. Please try again shortly.`,
      ErrorCode.SERVICE_UNAVAILABLE,
    );
    return;
  }
  sendQuotaExceeded(res, quotaType, reservation.quota, reservation.quota.resetAt);
}

/**
 * Fire-and-forget rollback for a previously reserved quota slot.
 * Logs on failure but never throws  the action that needed the rollback
 * has already failed, no point compounding the error.
 */
export function decrementQuota( quotaService: QuotaService,
  orgId: string,
  quotaType: QuotaType,
  authHeader: string,
  logWarn: (message: string, data?: unknown) => void,
  amount: number = 1,
  resetAtSnapshot?: string,
  attribution?: QuotaUsageAttribution,
): void {
  const sent = attribution
    ? quotaService.decrement(orgId, quotaType, authHeader, amount, resetAtSnapshot, attribution)
    : quotaService.decrement(orgId, quotaType, authHeader, amount, resetAtSnapshot);
  sent.catch((err: unknown) =>
    logWarn('Quota rollback failed', { error: errorMessage(err) }),
  );
}
