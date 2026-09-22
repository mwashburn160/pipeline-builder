// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser binding for redirect-based sign-ins (social OAuth, per-org OIDC SSO,
 * SAML) — the defence against LOGIN CSRF.
 *
 * The one-time `state` proves the callback answers a flow THIS SERVER started,
 * but not that it answers one THIS BROWSER started: an attacker can begin a
 * sign-in to their OWN account, stop at the provider's redirect, and plant the
 * resulting `code` + `state` in a victim's browser, which then completes the
 * attacker's sign-in and works inside the attacker's account (uploading
 * credentials, pipelines, secrets there). So the flow is also bound to the
 * browser that started it:
 *
 *   - when the flow URL is minted, a random nonce goes to the browser as an
 *     HttpOnly, SameSite=Lax cookie ({@link bindLoginToBrowser}) and only its
 *     SHA-256 is stored with the pending state;
 *   - the callback / SAML completion is honoured only when the presenting
 *     browser carries the matching cookie ({@link isBoundToThisBrowser}).
 *
 * `Lax` (not `Strict`): the callback page is reached by a top-level redirect
 * FROM the provider, and the completion request it makes must still carry the
 * cookie. SAML's ACS is a cross-site POST that carries no Lax cookie, so the
 * binding travels from the state to the ACS's handoff and is checked when the
 * landing page redeems it.
 */

import crypto from 'crypto';
import { safeEqual } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { envLite } from '../config/env-lite.js';

const COOKIE_NAME = 'pb_login_binding';

/** Long enough to cover a person at their IdP (SAML handoff included). */
const MAX_AGE_MS = 15 * 60_000;

/** The PUBLIC path the cookie is scoped to: the callback, SAML completion and
 *  OAuth invitation-accept endpoints all live under `/api` as the browser sees it. */
const COOKIE_PATH = process.env.AUTH_LOGIN_BINDING_COOKIE_PATH || '/api';

function cookieAttributes() {
  return {
    httpOnly: true,
    secure: envLite.authCookieSecure,
    sameSite: 'lax' as const,
    path: COOKIE_PATH,
  };
}

function digest(nonce: string): string {
  return crypto.createHash('sha256').update(nonce).digest('hex');
}

/**
 * Mint the binding for a flow about to start: set the nonce cookie on `res` and
 * return the hash to store with the flow's pending state.
 */
export function bindLoginToBrowser(res: Response): string {
  const nonce = crypto.randomBytes(32).toString('base64url');
  res.cookie(COOKIE_NAME, nonce, { ...cookieAttributes(), maxAge: MAX_AGE_MS });
  return digest(nonce);
}

/** The binding cookie's value on this request, or undefined. */
function readBinding(req: Pick<Request, 'headers'>): string | undefined {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value || undefined;
  }
  return undefined;
}

/**
 * Whether the presenting browser is the one the flow was bound to. Fails closed:
 * a flow stored without a binding, or a request without the cookie, is refused.
 */
export function isBoundToThisBrowser(req: Pick<Request, 'headers'>, expectedHash: string | undefined): boolean {
  const nonce = readBinding(req);
  if (!expectedHash || !nonce) return false;
  return safeEqual(digest(nonce), expectedHash);
}

/** Drop the binding once a flow has completed (or failed terminally). */
export function clearLoginBinding(res: Response): void {
  res.clearCookie(COOKIE_NAME, cookieAttributes());
}
