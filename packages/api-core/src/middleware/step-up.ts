// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireStepUp` — a shared step-up (recent-password-reverify) gate for the
 * stateless api services, mirroring the platform middleware of the same name.
 *
 * Flow: the UI hits `POST /api/auth/step-up` (platform) to re-verify the user's
 * password; platform mints a short-lived (60s) `step-up` JWT signed with the
 * SAME `JWT_SECRET` these services already verify access tokens with. The UI
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
import jwt from 'jsonwebtoken';
import { createEnvRedisClient } from '../services/env-redis.js';
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

function jwtAlgorithm(): jwt.Algorithm {
  return (process.env.JWT_ALGORITHM || 'HS256') as jwt.Algorithm;
}

/**
 * Verify a step-up token: valid signature (primary `JWT_SECRET`, or
 * `JWT_SECRET_PREVIOUS` during a rotation), allow-listed algorithm, AND the
 * `type: 'step-up'` + `jti` claims — a plain access token shares the secret and
 * `sub`, so without asserting the step-up shape it would bypass the gate.
 * Throws on any failure. Does NOT bind to a caller — `requireStepUp` does the
 * `sub` match and single-use consume.
 */
export function verifyStepUpToken(token: string): StepUpTokenPayload {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is required');
  const opts: jwt.VerifyOptions = { algorithms: [jwtAlgorithm()] };

  let payload: StepUpTokenPayload;
  try {
    payload = jwt.verify(token, secret, opts) as StepUpTokenPayload;
  } catch (primaryErr) {
    const previous = process.env.JWT_SECRET_PREVIOUS;
    if (!previous) throw primaryErr;
    payload = jwt.verify(token, previous, opts) as StepUpTokenPayload;
  }

  if (payload.type !== 'step-up' || !payload.jti || !payload.sub) {
    throw new Error('INVALID_STEP_UP_TOKEN');
  }
  return payload;
}

// -- Single-use jti store -----------------------------------------------------
// Redis SET NX EX when Redis is configured (cross-instance single-use); else a
// bounded process-local map with TTL sweep (best-effort per-process). A step-up
// token is 60s-lived, so the fallback window is tiny.

let _redis: { set: (...args: unknown[]) => Promise<unknown> } | null | undefined;
function redis(): { set: (...args: unknown[]) => Promise<unknown> } | null {
  if (_redis === undefined) {
    _redis = createEnvRedisClient<{ set: (...args: unknown[]) => Promise<unknown> }>('step-up-jti');
  }
  return _redis;
}

const memJti = new Map<string, number>(); // jti -> expiry epoch ms
const memSweep = setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of memJti) if (exp <= now) memJti.delete(jti);
}, 30_000);
memSweep.unref?.();

/**
 * Consume a step-up `jti` exactly once. Returns true if this call claimed it
 * (first use), false if it was already consumed (replay). `expEpochSeconds` is
 * the token's `exp`, so the marker auto-expires with the token.
 */
export async function consumeStepUpJti(jti: string, expEpochSeconds: number): Promise<boolean> {
  const ttlSeconds = Math.max(1, expEpochSeconds - Math.floor(Date.now() / 1000));
  const client = redis();
  if (client) {
    try {
      // SET key value NX EX ttl → 'OK' when newly set, null when it already exists.
      const res = await client.set(`stepup:jti:${jti}`, '1', 'EX', ttlSeconds, 'NX');
      return res === 'OK';
    } catch (err) {
      // Redis blip: fall through to the local guard (fail-safe = reject replays
      // we CAN see; a cross-instance replay during an outage is a tolerated edge).
      logger.warn('Step-up jti Redis consume failed; using local guard', { error: String(err) });
    }
  }
  if (memJti.has(jti)) return false;
  memJti.set(jti, Date.now() + ttlSeconds * 1000);
  return true;
}

/**
 * Express middleware: require a valid, caller-bound, single-use step-up token in
 * the `X-Step-Up-Token` header. Must run AFTER `requireAuth` (needs `req.user`).
 */
export async function requireStepUp(req: Request, res: Response, next: NextFunction): Promise<void> {
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
    payload = verifyStepUpToken(token);
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
