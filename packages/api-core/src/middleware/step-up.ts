// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireStepUp` — a shared step-up (recent-password-reverify) gate for the
 * stateless api services, mirroring the platform middleware of the same name.
 *
 * Flow: the UI hits `POST /api/auth/step-up` (platform) to re-verify the user;
 * platform mints a short-lived (60s) `step-up` JWT with the SAME ES256 signing
 * key it mints access tokens with, so these services verify it through the same
 * JWKS. The UI
 * replays it as the `X-Step-Up-Token` header on the destructive/sensitive call;
 * this middleware verifies it, binds it to the caller (`sub` match), and
 * consumes its `jti` once (Redis-backed cross-instance when configured, else a
 * bounded process-local set) so a replay inside the TTL is rejected.
 *
 * WHY here: restore endpoints on the api services (pipeline/plugin/...) are
 * step-up-gated, but step-up previously lived only in `platform`. This ports the
 * verify + single-use jti into api-core so any service can require it.
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyUserJwt, isServiceAccountPrincipal, isServicePrincipal } from './auth.js';
import { tagRouteGate } from './route-table.js';
import { createEnvRedisClient, createRedisReadyGate, type ReadyAwareRedis } from '../services/env-redis.js';
import { getHeaderString } from '../utils/headers.js';
import { createLogger } from '../utils/logger.js';
import { sendError } from '../utils/response.js';

const logger = createLogger('step-up');
const HEADER = 'x-step-up-token';

/** Payload of a platform-issued step-up token (see platform issueStepUpToken). */
export interface StepUpTokenPayload {
  type: 'step-up';
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

/**
 * Verify a step-up token: a valid ES256 signature from one of platform's
 * published signing keys, issuer and audience when configured, AND the
 * `type: 'step-up'` + `jti` claims — a plain access token is signed by the same
 * key and carries the same `sub`, so without asserting the step-up shape it
 * would bypass the gate. Throws on any failure (an unfetchable key set included:
 * an unverifiable token is not a step-up). Does NOT bind to a caller —
 * `requireStepUp` does the `sub` match and single-use consume.
 *
 * Delegates to `requireAuth`'s own primitive (`verifyUserJwt`) rather than
 * re-implementing it. The hand-rolled copy this replaced dropped TWO of its
 * guards: it never pinned issuer/audience, and its previous-secret retry had no
 * expiry/not-before carve-out, so an EXPIRED token surfaced as a signature error.
 */
export async function verifyStepUpToken(token: string): Promise<StepUpTokenPayload> {
  const payload = await verifyUserJwt<StepUpTokenPayload>(token);

  if (payload.type !== 'step-up' || !payload.jti || !payload.sub) {
    throw new Error('INVALID_STEP_UP_TOKEN');
  }
  return payload;
}

// -- Single-use jti store -----------------------------------------------------
// Redis SET NX EX when Redis is configured (cross-instance single-use); else a
// bounded process-local map with TTL sweep (per-process). A step-up token is
// 60s-lived. When Redis IS configured it's the authoritative store: a Redis
// error FAILS CLOSED (throws → STEP_UP_INVALID, user re-verifies) rather than
// degrading to the per-instance mem guard, which would accept a cross-instance
// replay during the outage. The mem guard is used ONLY when Redis is absent.

type JtiRedis = ReadyAwareRedis & { set: (...args: unknown[]) => Promise<unknown> };
let _redis: JtiRedis | null | undefined;
let _redisReady: (() => Promise<void>) | undefined;
/**
 * The jti client, built lazily. The env client has no offline queue, so a SET on
 * a connection that isn't up yet is rejected — which used to fail the FIRST
 * step-up on every pod. Wait (bounded, never rejecting) for readiness before
 * handing it out; a genuinely down Redis still fails closed on the SET below.
 */
async function redis(): Promise<JtiRedis | null> {
  if (_redis === undefined) {
    _redis = createEnvRedisClient<JtiRedis>('step-up-jti');
    _redisReady = _redis ? createRedisReadyGate(_redis) : undefined;
  }
  if (_redisReady) await _redisReady();
  return _redis;
}

const memJti = new Map<string, number>(); // jti -> expiry epoch ms
const memSweep = setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of memJti) if (exp <= now) memJti.delete(jti);
}, 30_000);
memSweep.unref?.();

/**
 * Hard ceiling on the process-local jti set.
 *
 * The 30s sweep alone does NOT bound it: entries only leave once their token's
 * TTL has passed, so a burst of step-up traffic (or a flood of distinct forged
 * jtis on a Redis-less deployment) grows the map faster than the sweep drains
 * it. This is a replay guard, so shedding the OLDEST entries is the safe
 * direction: the worst case is that a long-expired jti could be replayed, and
 * expiry is enforced independently by the token's own `exp`.
 */
const MEM_JTI_MAX = 10_000;

/** Drop the soonest-to-expire entries until the map is under the ceiling. */
function evictOldestJti(): void {
  if (memJti.size < MEM_JTI_MAX) return;
  const byExpiry = [...memJti.entries()].sort((a, b) => a[1] - b[1]);
  const excess = memJti.size - MEM_JTI_MAX + 1;
  for (let i = 0; i < excess; i += 1) memJti.delete(byExpiry[i][0]);
}

/**
 * Consume a step-up `jti` exactly once. Returns true if this call claimed it
 * (first use), false if it was already consumed (replay). `expEpochSeconds` is
 * the token's `exp`, so the marker auto-expires with the token.
 */
export async function consumeStepUpJti(jti: string, expEpochSeconds: number): Promise<boolean> {
  const ttlSeconds = Math.max(1, expEpochSeconds - Math.floor(Date.now() / 1000));
  const client = await redis();
  if (client) {
    // Redis configured ⇒ authoritative cross-instance store. SET NX EX → 'OK'
    // when newly set, null when already consumed. A thrown Redis error is NOT
    // caught here: it propagates so `requireStepUp` fails closed (STEP_UP_INVALID)
    // instead of silently degrading to the per-instance mem guard.
    const res = await client.set(`stepup:jti:${jti}`, '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }
  // No Redis ⇒ single-instance deployment; the process-local map IS the store.
  if (memJti.has(jti)) return false;
  evictOldestJti();
  memJti.set(jti, Date.now() + ttlSeconds * 1000);
  return true;
}

/**
 * Express middleware: require a valid, caller-bound, single-use step-up token in
 * the `X-Step-Up-Token` header. Must run AFTER `requireAuth` (needs `req.user`).
 */
export async function requireStepUp(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Verified internal service principals are EXEMPT: step-up is a re-verify-the-
  // HUMAN gate (they replay a password-reverify token), which a service token
  // structurally cannot produce. Services already bypass `requirePermission` on
  // the same trust basis (a signed service JWT), and internal callers of a
  // step-up-gated route — e.g. the platform org-cascade's `DELETE /quotas/:orgId`
  // or the billing→quota entitlement sync — would otherwise be hard-blocked.
  // Safe: a service token can only be minted with a SERVICE's own ES256 key
  // (#14), which no external client holds, so this can't be spoofed to skip
  // step-up.
  if (isServicePrincipal(req)) {
    next();
    return;
  }

  // An ORG SERVICE ACCOUNT is the opposite case: it is subject to every gate a
  // member is, and there is no person behind it to re-verify — so it can NEVER
  // pass step-up. Refuse explicitly (rather than letting it fall through to the
  // `sub`-bound token check, which would fail with a confusing STEP_UP_MISMATCH)
  // so "a machine credential never satisfies an assurance requirement" is a
  // property of this gate, not a side effect of how step-up tokens are minted.
  if (isServiceAccountPrincipal(req)) {
    sendError(res, 403, 'A service account cannot perform this action — it requires a person to re-verify', 'STEP_UP_NOT_AVAILABLE');
    return;
  }

  const callerSub = (req as Request & { user?: { sub?: string } }).user?.sub;
  if (!callerSub) {
    sendError(res, 401, 'Authentication required', 'UNAUTHORIZED');
    return;
  }

  const token = getHeaderString(req.headers[HEADER]);
  if (!token) {
    sendError(res, 401, 'Step-up verification required', 'STEP_UP_REQUIRED');
    return;
  }

  let payload: StepUpTokenPayload;
  try {
    payload = await verifyStepUpToken(token);
  } catch {
    sendError(res, 401, 'Step-up token invalid or expired', 'STEP_UP_INVALID');
    return;
  }

  if (payload.sub !== callerSub) {
    sendError(res, 401, 'Step-up token does not match session', 'STEP_UP_MISMATCH');
    return;
  }

  try {
    if (!(await consumeStepUpJti(payload.jti, payload.exp))) {
      sendError(res, 401, 'Step-up token already used or expired', 'STEP_UP_REPLAY');
      return;
    }
  } catch (err) {
    logger.error('Step-up jti consume errored', { error: String(err) });
    sendError(res, 401, 'Step-up verification failed', 'STEP_UP_INVALID');
    return;
  }

  next();
}
tagRouteGate(requireStepUp, { kind: 'stepUp' });
