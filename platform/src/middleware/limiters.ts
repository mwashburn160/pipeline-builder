// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every rate-limit BUCKET platform serves, and the requests each one exempts.
 *
 * Kept next to `createLimiter` and the key generators (`rate-limit-keys.ts`)
 * rather than inline in `index.ts`, so the whole rate-limiting policy — which
 * request lands in which bucket, and why some land in none — reads in one
 * place; `index.ts` only wires them into the app.
 */

import { verifyServicePrincipal } from '@pipeline-builder/api-core';
import type { Request, RequestHandler } from 'express';

import { extractClientIp, rateLimitKey, scimOrgKey, verifiedIsSuperAdmin, tierLimitedMax, isSignOut } from './rate-limit-keys.js';
import { createLimiter } from './rate-limiter.js';
import { config } from '../config/index.js';
import { SCIM_RATE_LIMIT_MAX, SCIM_RATE_LIMIT_WINDOW_MS } from '../constants/scim.js';
import { ALERT_WEBHOOK_PATH, SCIM_PATH } from '../routes/mount.js';

/**
 * The Alertmanager relay webhook. Machine-to-machine, and unauthenticated at
 * middleware time (it checks a per-instance bearer inside the handler), so
 * without this exemption it lands in the ANONYMOUS bucket of the user-sized
 * limiters and an alert storm gets 429'd — which Alertmanager treats as a
 * failed notification, silently delaying alerts. It gets `alertWebhookLimiter`
 * instead, sized for burst fan-out. (The path itself is declared next to the
 * mount that uses it — `routes/mount.ts`.)
 */
function isAlertWebhook(req: Request): boolean {
  return req.method === 'POST' && req.path === ALERT_WEBHOOK_PATH;
}

/**
 * The device-authorization poll. RFC 8628 has the waiting client poll every few
 * seconds until the person approves in a browser — ~120 requests over one
 * sign-in, against a general bucket of 100 per 15 minutes for an anonymous
 * caller. It has its own per-device-code and per-IP limiters on the router
 * (`routes/device-auth.ts`), which is where the abuse ceiling belongs; counting
 * it here would 429 every legitimate CLI login halfway through.
 */
function isDevicePoll(req: Request): boolean {
  return req.method === 'POST' && req.path === '/auth/device/token';
}

/**
 * The SCIM surface. An identity provider's initial import is a burst of
 * hundreds of requests, all from one org — against a general bucket sized for a
 * person's interactive use. It has its own per-org bucket (`scimLimiter`), so a
 * directory sync can neither be throttled by, nor starve, the org's people.
 */
function isScim(req: Request): boolean {
  return req.path.startsWith(SCIM_PATH);
}

/** Generous, dedicated bucket for the alert relay — see `isAlertWebhook`. */
export const alertWebhookLimiter: RequestHandler = createLimiter({
  name: 'alert-webhook',
  windowMs: config.rateLimit.alertWebhook.windowMs,
  max: config.rateLimit.alertWebhook.max,
  keyGenerator: extractClientIp,
  message: 'Alert webhook rate limit exceeded.',
});

/** General rate limiter — per-tier max, keyed by org (or IP for anon callers).
 *  Applied to EVERY route; the four below are per-surface buckets. */
export const generalLimiter: RequestHandler = createLimiter({
  name: 'general',
  windowMs: config.rateLimit.windowMs,
  max: tierLimitedMax,
  keyGenerator: rateLimitKey,
  // Sysadmins are internal operators who legitimately make burst calls
  // (audit replays, fleet-wide scans). Bypass the limiter rather than size it
  // for the worst case. The alert relay has its own generous bucket; it must
  // not share the anonymous user budget. The sysadmin check VERIFIES the token:
  // the bypass removes throttling entirely, so a forged `isSuperAdmin:true`
  // must not grant it. `requireAuth` still authorizes the request later.
  skip: (req: Request) => isAlertWebhook(req) || isDevicePoll(req) || isScim(req) || verifiedIsSuperAdmin(req),
  message: 'Too many requests. Please try again later.',
});

/** Strict rate limiter for auth endpoints (login, register, OAuth) — IP-based since the user is not yet authenticated. */
export const authLimiter: RequestHandler = createLimiter({
  name: 'auth',
  windowMs: config.rateLimit.auth.windowMs,
  max: config.rateLimit.auth.max,
  keyGenerator: extractClientIp,
  // A verified internal service (image-registry relaying `docker login`) sends
  // every user's attempt from one pod IP; counting those in one IP bucket would
  // let one user's failures lock everyone out. That service limits per client
  // and username itself (image-registry token-rate-limiter).
  skip: (req: Request) => verifyServicePrincipal(req) || isSignOut(req),
  message: 'Too many authentication attempts. Please try again later.',
});

/**
 * Per-org rate limiter for observability endpoints. Tighter than the general
 * limiter because every request fans out to Prometheus, and a noisy tenant can
 * degrade that upstream for everyone else (dashboards across all orgs go blank).
 * Keys by the verified token's org when present, falls back to IP.
 */
export const observabilityLimiter: RequestHandler = createLimiter({
  name: 'observability',
  windowMs: config.rateLimit.observability.windowMs,
  max: config.rateLimit.observability.max,
  keyGenerator: rateLimitKey,
  // The alert relay is mounted under /observability but is not a tenant
  // dashboard query — it has its own bucket (see `isAlertWebhook`).
  skip: isAlertWebhook,
  message: 'Observability rate limit exceeded for your organization. Please slow down or batch your queries.',
});

/**
 * Per-ORG limiter for SCIM. Keyed by the VERIFIED token's org — never the
 * service account — because the plan's requirement is a per-ORG ceiling: a tenant
 * that issues five SCIM keys still gets one directory-sync budget. Falls back to
 * the credential hash / client IP for a request whose token doesn't verify (which
 * `requireScimScope` then refuses anyway).
 */
export const scimLimiter: RequestHandler = createLimiter({
  name: 'scim',
  windowMs: SCIM_RATE_LIMIT_WINDOW_MS,
  max: SCIM_RATE_LIMIT_MAX,
  keyGenerator: scimOrgKey,
  message: 'SCIM rate limit exceeded for your organization. Slow the provisioning job down and retry.',
});
