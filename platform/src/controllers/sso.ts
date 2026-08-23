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
import { withController } from '../helpers/controller-helper.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';
import { findSsoEnforcementForEmail, getEnforcedLoginConfig } from '../helpers/sso-enforcement.js';
import { incCounter } from '../observability/metrics.js';
import { authService } from '../services/index.js';
import {
  OIDC_ERROR_MAP,
  buildAuthorizeUrl,
  exchangeAndValidate,
} from '../services/oidc-service.js';
import { issueTokens } from '../utils/token.js';
import { oauthCallbackSchema, ssoDiscoverSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('sso-controller');

// Pending SSO state (CSRF + nonce binding)

/** Cap on the in-memory pending-state fallback (same default + override knob as
 *  the OAuth surface). Each entry is ~120 bytes. */
const MAX_PENDING_STATES = parseInt(process.env.OAUTH_MAX_PENDING_STATES || '1000', 10);

/** Cross-pod pending-state store (env Redis; process-local Map fallback):
 *  state → { orgId it was minted for, the nonce echoed in the id_token }.
 *  Backing this with Redis is what lets the SSO initiate + callback land on
 *  different replicas without the callback losing the state. */
const pendingSsoStates = createPendingStateStore<{ orgId: string; nonce: string; createdAt: number }>({
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
  const url = await buildAuthorizeUrl(cfg, state, nonce);

  await pendingSsoStates.put(state, { orgId, nonce, createdAt: Date.now() });

  sendSuccess(res, 200, { url, state });
}, OIDC_ERROR_MAP);

/**
 * POST /auth/sso/:orgId/callback — exchange the authorization code, validate the
 * id_token against the IdP's JWKS, map the verified identity to a platform user,
 * and issue a platform session. The session prefers the SSO org as active org
 * (issueTokens falls back to the user's own membership if they aren't a member).
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
    identity = await exchangeAndValidate(cfg, body.code, pending.nonce);
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

  // Reuse the SAME identity→user mapping the OAuth login uses (link-by-verified-
  // email; auto-create with a personal org for a brand-new identity). Keying on
  // the config's provider stores the SSO linkage under `oauth.<provider>`.
  const user = await authService.findOrCreateOAuthUser(provider, {
    id: identity.subject,
    email: identity.email,
    name: identity.name,
  }, { markOnboarding: false }); // SSO users sign in to an enforced org, not a self-named personal one
  // Prefer the SSO org as the active org; issueTokens' resolveMembership falls
  // back to the user's own membership when they aren't (yet) a member of it.
  const tokens = await issueTokens(user, orgId);

  audit(req, 'user.login', { targetType: 'user', targetId: user._id.toString(), affectedOrgId: orgId, details: { method: 'sso' } });
  incCounter('platform_logins_total');
  logger.info('[SSO] login successful', { orgId, userId: user._id, provider });

  sendSuccess(res, 200, tokens);
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
