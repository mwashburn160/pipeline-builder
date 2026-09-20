// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a session's refresh token lives, per caller.
 *
 * TWO transports, chosen by ONE explicit signal — the `X-Pb-Client` header:
 *
 *  - `X-Pb-Client: web` (the browser app, and only it) — the refresh token is
 *    returned as an `HttpOnly; Secure; SameSite=Strict` cookie scoped to the
 *    refresh path, and is NEVER present in the response body. No script in the
 *    page can read it, so an XSS can no longer walk off with a 30-day
 *    credential; the access token it could still steal lives in memory for 15
 *    minutes.
 *  - any other value (the CLI, CI, scripts) — the refresh token is returned in
 *    the body exactly as before and presented back in the request body. A
 *    non-browser caller has no cookie jar to protect.
 *
 * The signal is the header rather than "did a cookie arrive", because the
 * decision has to be made on responses that PRECEDE the first cookie (login,
 * the OAuth/SSO callbacks). One header answers both directions.
 *
 * CSRF: a cookie is ambient authority — the browser attaches it to any
 * same-site request, including one a foreign page provokes. `requireClientType`
 * (middleware/auth.ts) refuses `/auth/refresh` and `/auth/logout` without the
 * header, which a cross-site form or image simply cannot set, and which on a
 * cross-origin `fetch` forces a preflight that CORS refuses.
 */

import type { Request, Response } from 'express';
import type { IssuedTokens } from '../utils/token.js';

/** Cookie carrying the browser's refresh token. */
const REFRESH_COOKIE_NAME = 'pb_refresh';

/**
 * Cookie policy, read straight from the environment rather than through
 * `config/index.ts`.
 *
 * This module is imported by the auth MIDDLEWARE, which every route chain
 * loads; routing that through the config module would pull platform's whole
 * boot-time secret validation into modules (and test suites) that have no
 * business booting it. The three variables below are documented in
 * docs/environment-variables.md alongside the config-owned ones.
 */
const COOKIE_POLICY = {
  /**
   * Path the cookie is scoped to, as the BROWSER sees it. nginx strips the
   * `/api` prefix before proxying, so this is the public path
   * (`/api/auth/refresh`), not the Express route (`/auth/refresh`).
   */
  path: process.env.AUTH_REFRESH_COOKIE_PATH || '/api/auth/refresh',
  /**
   * `Secure`. Every shipped target terminates TLS in front of the gateway
   * (docker/minikube on :8443, ec2/eks at the load balancer) and browsers treat
   * `http://localhost` as a secure context, so this stays on by default.
   * `AUTH_COOKIE_SECURE=false` is for a plain-http deployment on a
   * non-localhost hostname, where the browser would drop the cookie and no
   * session could ever refresh.
   */
  secure: process.env.AUTH_COOKIE_SECURE !== 'false',
  /** Paired with the refresh token's own TTL — same variable, same default. */
  maxAgeMs: parseInt(process.env.REFRESH_TOKEN_EXPIRES_IN || '2592000', 10) * 1000,
};

/** Header naming the kind of client making the request (lowercased by Node). */
export const CLIENT_TYPE_HEADER = 'x-pb-client';

/** The one client type that gets the cookie transport. */
const BROWSER_CLIENT_TYPE = 'web';

/** Just the headers/cookie surface these helpers read. */
type RequestLike = Pick<Request, 'headers'>;

/** The declared client type, lowercased, or undefined when the header is absent. */
export function clientType(req: RequestLike): string | undefined {
  const raw = req.headers?.[CLIENT_TYPE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return trimmed || undefined;
}

/** True when the caller declared itself the browser app. */
export function isBrowserClient(req: RequestLike): boolean {
  return clientType(req) === BROWSER_CLIENT_TYPE;
}

/**
 * The refresh token the browser sent, from the cookie header.
 *
 * Parsed here rather than with cookie-parser: this is the only cookie the
 * platform reads, and Node's raw header needs no dependency to split.
 */
export function readRefreshCookie(req: RequestLike): string | undefined {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      // A malformed percent-escape can't be a token we issued.
      return undefined;
    }
  }
  return undefined;
}

/** Attributes shared by the set and the clear — a cookie is only replaced/removed when they match. */
function cookieAttributes() {
  return {
    httpOnly: true,
    secure: COOKIE_POLICY.secure,
    sameSite: 'strict' as const,
    path: COOKIE_POLICY.path,
  };
}

/** Store (or rotate) the browser's refresh token. */
function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...cookieAttributes(),
    maxAge: COOKIE_POLICY.maxAgeMs,
  });
}

/** Remove the browser's refresh token. Harmless for a caller that never had one. */
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, cookieAttributes());
}

/** A token pair as the CALLER receives it — the browser gets no `refreshToken`. */
export interface DeliveredTokens {
  accessToken: string;
  expiresIn: number;
  /** Non-browser callers only; the browser's rides in the cookie instead. */
  refreshToken?: string;
}

/**
 * Split an issued pair across the transport its caller uses: cookie for the
 * browser, body for everyone else. Returns the body payload; callers spread it
 * into their own response shape.
 */
export function deliverSessionTokens(req: RequestLike, res: Response, tokens: IssuedTokens): DeliveredTokens {
  if (!isBrowserClient(req)) return tokens;
  setRefreshCookie(res, tokens.refreshToken);
  return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
}
