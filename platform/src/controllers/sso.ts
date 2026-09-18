// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org SSO (OIDC) login surface.
 *
 *   GET  /auth/sso/:orgId/authorize  → { url, state }  (initiate — redirect to IdP)
 *   POST /auth/sso/:orgId/callback   → tokens          (exchange code + validate id_token)
 *   POST /auth/sso/discover          → { sso }          (is this email forced through SSO?)
 *
 * Mirrors the OAuth controller (controllers/oauth.ts): a one-time CSRF `state`
 * bound to the org that minted it, a cross-pod (env Redis) pending-state store,
 * the verified identity fed into the SAME `findOrCreateOAuthUser` +
 * `issueTokens` session issuance the password/OAuth logins use.
 *
 * Enforcement (enabled + `sso`-entitled) is resolved in helpers/sso-enforcement;
 * a disabled/unentitled org yields the typed OIDC_DISABLED / OIDC_NOT_ENTITLED
 * error so the routes are a safe no-op until an admin turns SSO on.
 */

import crypto from 'crypto';
import { createLogger, getParam, sendSuccess } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { clientInfoOf } from '../helpers/client-info.js';
import { withController } from '../helpers/controller-helper.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';
import { deliverSessionTokens } from '../helpers/session-cookie.js';
import { assertSsoIdentityTrusted, findSsoEnforcementForEmail, getEnforcedLoginConfig } from '../helpers/sso-enforcement.js';
import { incCounter } from '../observability/metrics.js';
import { JIT_SEAT_LIMIT } from '../services/idp-mapping-errors.js';
import { authService } from '../services/index.js';
import {
  OIDC_ERROR_MAP,
  buildAuthorizeUrl,
  exchangeAndValidate,
} from '../services/oidc-service.js';
import { assertJitSeatAvailable, provisionJitMembership } from '../services/sso-jit-service.js';
import { issueTokens, signInAuth } from '../utils/token.js';
import { oauthCallbackSchema, ssoDiscoverSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('sso-controller');

// Pending SSO state (CSRF + nonce binding)

/** Cap on the in-memory pending-state fallback (same default + override knob as
 *  the OAuth surface). Each entry is ~120 bytes. */
const MAX_PENDING_STATES = config.oauth.maxPendingStates;

/** Cross-pod pending-state store (env Redis; process-local Map fallback):
 *  state → { orgId it was minted for, the nonce echoed in the id_token, and the
 *  PKCE `code_verifier` whose S256 challenge went out with the redirect }.
 *  Backing this with Redis is what lets the SSO initiate + callback land on
 *  different replicas without the callback losing the state.
 *
 *  The verifier lives HERE and nowhere else: it never reaches the browser, and
 *  consuming the state destroys it, so a code can be redeemed exactly once, by
 *  the server that started the flow. */
const pendingSsoStates = createPendingStateStore<{ orgId: string; nonce: string; codeVerifier?: string }>({
  prefix: 'sso:state:',
  ttlMs: config.oauth.stateTtlMs,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: MAX_PENDING_STATES,
});

// Route handlers

/**
 * GET /auth/sso/:orgId/authorize — initiate the OIDC authorization-code flow.
 * Resolves + validates the org's enforced IdP config (enabled + entitled),
 * mints a one-time state + nonce, and returns the IdP authorize URL for the
 * browser to redirect to. Discovery runs here so an unreachable IdP fails now.
 */
export const getSsoAuthUrl = withController('Get SSO URL', async (req, res) => {
  const orgId = getParam(req.params, 'orgId')!;
  const cfg = await getEnforcedLoginConfig(orgId);

  const state = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const { url, codeVerifier } = await buildAuthorizeUrl(cfg, state, nonce);

  await pendingSsoStates.put(state, { orgId, nonce, ...(codeVerifier && { codeVerifier }) });

  sendSuccess(res, 200, { url, state });
}, OIDC_ERROR_MAP);

/** Label a failed provisioning attempt for the audit row + metric. Only the seat
 *  cap is an expected refusal; anything else is an infrastructure failure and is
 *  counted separately so a Mongo outage can't masquerade as a full account. */
function jitRefusalReason(err: unknown): string {
  return (err instanceof Error && err.message === JIT_SEAT_LIMIT) ? 'seat_limit' : 'error';
}

/**
 * Record a refused just-in-time provision (3a) and re-throw so the typed error
 * reaches `OIDC_ERROR_MAP`. A seat refusal is a real operational event — the org
 * has to free a seat or raise the limit before that person can sign in — so it
 * leaves an audit row and a metric, not just a 403.
 */
function refuseJit(req: Parameters<typeof audit>[0], orgId: string, email: string, reason: string): void {
  audit(req, 'sso.jit.refused', {
    targetType: 'user',
    outcome: 'failure',
    affectedOrgId: orgId,
    details: { reason, email, method: 'sso' },
  });
  incCounter('platform_sso_jit_refused_total', { reason });
  incCounter('platform_logins_failed_total');
}

/**
 * POST /auth/sso/:orgId/callback — exchange the authorization code, validate the
 * id_token against the IdP's JWKS, map the verified identity to a platform user,
 * provision their membership + mapped Roles, and issue a platform session. The
 * session prefers the SSO org as active org (issueTokens falls back to the
 * user's own membership if they aren't a member).
 */
export const handleSsoCallback = withController('SSO callback', async (req, res) => {
  const orgId = getParam(req.params, 'orgId')!;

  const body = validateBody(oauthCallbackSchema, req.body, res);
  if (!body) return;

  // Consume the state on any lookup (valid or mismatched) to prevent replay /
  // probing — same one-time semantics as the OAuth flow.
  const pending = await pendingSsoStates.consume(body.state);

  let identity;
  let provider: string;
  try {
    if (!pending || pending.orgId !== orgId) throw new Error('OIDC_INVALID_STATE');
    const cfg = await getEnforcedLoginConfig(orgId);
    provider = cfg.provider;
    // The PKCE verifier comes from the (now consumed) state — never from the
    // request — so a replayed or forged callback has none to present.
    identity = await exchangeAndValidate(cfg, body.code, pending.nonce, { codeVerifier: pending.codeVerifier });
    // The org's IdP vouching for an email proves nothing unless the org owns
    // that domain — checked before the identity can reach or create any account.
    await assertSsoIdentityTrusted(orgId, identity);
  } catch (err) {
    audit(req, 'user.login.failed', {
      targetType: 'user',
      outcome: 'failure',
      affectedOrgId: orgId,
      details: { method: 'sso', orgId },
    });
    incCounter('platform_logins_failed_total');
    throw err;
  }

  // JIT (3a): seats are checked BEFORE the identity becomes an account, so a
  // sign-in that the seat cap will refuse doesn't leave a user record (and its
  // personal org) behind. The authoritative check runs again inside the
  // provisioning transaction below.
  try {
    await assertJitSeatAvailable(orgId, identity.email);
  } catch (err) {
    refuseJit(req, orgId, identity.email, jitRefusalReason(err));
    throw err;
  }

  // Reuse the SAME identity→user mapping the OAuth login uses (link-by-verified-
  // email; auto-create with a personal org for a brand-new identity). Keying on
  // the config's provider stores the SSO linkage under `oauth.<provider>`; the
  // issuer binds the subject to THIS IdP.
  const user = await authService.findOrCreateOAuthUser(provider, {
    id: identity.subject,
    email: identity.email,
    name: identity.name,
  }, {
    markOnboarding: false, // SSO users sign in to an enforced org, not a self-named personal one
    sso: { issuer: identity.issuer },
  });

  // JIT membership + group→Role sync, BEFORE the session is minted: the token
  // then carries the org, role and permissions this sign-in just established.
  // `provisionJitMembership` refreshes `user.tokenVersion` in place when it bumps
  // it, so the token below is valid from its first request.
  let jit;
  try {
    jit = await provisionJitMembership({ orgId, user, groups: identity.groups });
  } catch (err) {
    refuseJit(req, orgId, identity.email, jitRefusalReason(err));
    throw err;
  }
  if (jit.membershipCreated) {
    audit(req, 'sso.jit.provision', {
      targetType: 'user',
      targetId: user._id.toString(),
      affectedOrgId: orgId,
      details: { provider, matchedGroups: jit.matchedGroups, roles: jit.rolesAdded },
    });
  }
  if (!jit.membershipCreated && (jit.rolesAdded.length > 0 || jit.rolesRemoved.length > 0)) {
    audit(req, 'sso.jit.role.change', {
      targetType: 'user',
      targetId: user._id.toString(),
      affectedOrgId: orgId,
      details: { provider, matchedGroups: jit.matchedGroups, added: jit.rolesAdded, removed: jit.rolesRemoved },
    });
  }

  // Prefer the SSO org as the active org; issueTokens' resolveMembership falls
  // back to the user's own membership when they aren't (yet) a member of it.
  // Single sign-on opens an INTERACTIVE session (`amr: ['sso']`).
  const tokens = await issueTokens(user, orgId, {
    kind: 'interactive',
    auth: signInAuth('sso'),
    client: clientInfoOf(req),
  });

  audit(req, 'user.login', { targetType: 'user', targetId: user._id.toString(), affectedOrgId: orgId, details: { method: 'sso' } });
  incCounter('platform_logins_total');
  logger.info('[SSO] login successful', { orgId, userId: user._id, provider });

  // Same transport split as password/OAuth login: cookie for the browser.
  sendSuccess(res, 200, deliverSessionTokens(req, res, tokens));
}, OIDC_ERROR_MAP);

/**
 * POST /auth/sso/discover — public (UNAUTHENTICATED) helper for the login page.
 * Given an email, report ONLY whether an enabled + entitled org IdP FORCES that
 * user through SSO — a bare `{ sso: boolean }`.
 *
 * It deliberately does NOT leak the internal `orgId` or IdP `provider`: this
 * endpoint is anonymous, so returning those turned it into an enumeration oracle
 * (any caller could probe which domains are SSO-enforced AND harvest internal
 * org identifiers). The org handle the initiate flow needs is delivered ONLY
 * through the authenticated-attempt path: a covered account's login is rejected
 * with `SSO_REQUIRED` + `{ orgId, provider }` (controllers/auth.ts +
 * controllers/oauth.ts), which is where the UI picks up the org to initiate
 * against. No current caller consumes discover's org fields.
 */
export const discoverSso = withController('Discover SSO', async (req, res) => {
  const body = validateBody(ssoDiscoverSchema, req.body, res);
  if (!body) return;

  const enforcement = await findSsoEnforcementForEmail(body.email);
  sendSuccess(res, 200, { sso: !!enforcement });
});
