// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step-up by re-authenticating with the user's own sign-in provider — the
 * step-up path for accounts without a password (Google/GitHub/… sign-up, org
 * SSO). Issues the SAME step-up token as the password path (`method: 'reauth'`),
 * so every `requireStepUp` gate is unchanged.
 *
 *   POST /api/auth/step-up/reauth            body: { type: 'oauth', provider }
 *                                                 | { type: 'sso', orgId }
 *        → { url, state }   (open `url` in a popup)
 *   POST /api/auth/step-up/reauth/callback   body: { code, state }
 *        → { ok, stepUpToken, expiresAt, method: 'reauth' }
 *
 * The provider redirects to the ordinary sign-in callback page
 * (`/auth/callback/:provider` or `/auth/sso/:orgId/callback`); the page spots the
 * `reauth.` state prefix, hands code + state back to the window that opened it,
 * and that window (still holding the user's session) calls the callback here.
 *
 * Verification mirrors sign-in exactly — the social code exchange + verified
 * userinfo, or the SSO id_token (JWKS signature, issuer, audience, nonce, the
 * org's domain authority) — and then additionally requires:
 *   - the state was minted for THIS signed-in user (single-use, short TTL, in the
 *     shared Redis pending-state store);
 *   - the provider signed in the SAME identity already linked to the account
 *     (provider subject, and issuer for SSO) — never just the same email;
 *   - the sign-in happened during this flow: `auth_time` (when the provider
 *     returns it) must not predate the initiate call beyond clock skew. SSO
 *     IdPs other than Google must return it (`max_age=0` obliges them).
 *     GitHub/Facebook/Google can't prove recency; see docs/authentication.md.
 *
 * Same rate limiter as the password path; failures audit as
 * `user.login.failed` (`targetType: 'step-up'`), success as `user.step-up`.
 * Read-only impersonation blocks both POSTs like any other write.
 */

import crypto from 'crypto';
import { createLogger, sendSuccess, errorMessage } from '@pipeline-builder/api-core';
import { z } from 'zod';
import { OAUTH_ERROR_MAP, buildOAuthReauthUrl, verifyOAuthReauthCode } from './oauth.js';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { findReauthOption, loadFactorUser, resolveAuthFactors } from '../helpers/auth-factors.js';
import { withController } from '../helpers/controller-helper.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';
import { assertSsoIdentityTrusted, getEnforcedLoginConfig } from '../helpers/sso-enforcement.js';
import { incCounter } from '../observability/metrics.js';
import {
  STEP_UP_REAUTH_IDENTITY_MISMATCH,
  STEP_UP_REAUTH_INVALID_STATE,
  STEP_UP_REAUTH_NOT_RECENT,
  STEP_UP_REAUTH_UNAVAILABLE,
} from '../services/auth-errors.js';
import {
  OIDC_ERROR_MAP,
  buildAuthorizeUrl,
  exchangeAndValidate,
  ssoReauthRequiresAuthTime,
} from '../services/oidc-service.js';
import { issueStepUpToken } from '../utils/token.js';
import { oauthCallbackSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('step-up-reauth');

/** Prefix on every re-auth `state`, so the shared sign-in callback pages can
 *  tell a re-auth redirect from a sign-in without any client-side storage. */
export const REAUTH_STATE_PREFIX = 'reauth.';

/** A re-auth must finish promptly: at most 5 minutes (or the OAuth state TTL,
 *  if that's shorter). */
const REAUTH_STATE_TTL_MS = Math.min(config.oauth.stateTtlMs, 5 * 60_000);

/** Clock skew tolerated between us and the provider when checking `auth_time`. */
const AUTH_TIME_SKEW_MS = 60_000;

interface PendingReauth {
  userId: string;
  type: 'oauth' | 'sso';
  provider: string;
  orgId?: string;
  nonce?: string;
  /** PKCE verifier whose S256 challenge went out with the authorization request
   *  (absent only for a provider that doesn't take PKCE). Single-use: it dies
   *  with this entry, so a re-auth code can be redeemed exactly once. */
  codeVerifier?: string;
  /** Epoch ms of the initiate call — `auth_time` must not predate it. */
  initiatedAt: number;
}

const pendingReauth = createPendingStateStore<PendingReauth>({
  prefix: 'stepup:reauth:',
  ttlMs: REAUTH_STATE_TTL_MS,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.oauth.maxPendingStates,
});

export const STEP_UP_REAUTH_ERROR_MAP = {
  ...OAUTH_ERROR_MAP,
  ...OIDC_ERROR_MAP,
  // A SAML org can't drive this ceremony (#4): re-auth reads its result out of
  // the popup the provider redirects back to, and a SAML assertion lands on a
  // server-side ACS instead. `resolveAuthFactors` already stops offering the
  // option; this is what a client that asks anyway is told. A SAML-only account
  // steps up with a passkey, an authenticator app, or a password.
  OIDC_PROTOCOL_MISMATCH: { status: 400, message: 'SAML single sign-on cannot be used to confirm your identity. Use a passkey, an authenticator app, or your password.' },
  [STEP_UP_REAUTH_UNAVAILABLE]: { status: 400, message: 'That sign-in method is not available for confirming your identity' },
  [STEP_UP_REAUTH_INVALID_STATE]: { status: 403, message: 'This confirmation has expired or was already used. Please try again.' },
  [STEP_UP_REAUTH_IDENTITY_MISMATCH]: { status: 403, message: 'You signed in with a different account than the one linked to your profile' },
  [STEP_UP_REAUTH_NOT_RECENT]: { status: 401, message: 'Your identity provider did not confirm a fresh sign-in. Please try again.' },
} as const;

const reauthStartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('oauth'), provider: z.string().min(1).max(40) }),
  z.object({ type: z.literal('sso'), orgId: z.string().min(1).max(64) }),
]);

/** Fail-closed audit + metric for a refused re-auth, then rethrow for the map. */
function recordFailure(req: Parameters<typeof audit>[0], userId: string, err: unknown, provider?: string): never {
  audit(req, 'user.login.failed', {
    targetType: 'step-up',
    targetId: userId,
    outcome: 'failure',
    details: {
      method: 'reauth',
      ...(provider && { provider }),
      reason: err instanceof Error ? err.message : 'unknown',
    },
  });
  incCounter('platform_step_up_total', { method: 'reauth', outcome: 'failure' });
  logger.warn('Step-up re-auth failed', { userId, provider, error: errorMessage(err) });
  throw err;
}

/** POST /api/auth/step-up/reauth — start a provider re-auth for the caller. */
export const startStepUpReauth = withController('Step-up re-auth start', async (req, res) => {
  const userId = req.user!.sub;
  const body = validateBody(reauthStartSchema, req.body, res);
  if (!body) return;

  const user = await loadFactorUser(userId);
  if (!user) throw new Error(STEP_UP_REAUTH_UNAVAILABLE);
  const option = findReauthOption(await resolveAuthFactors(user), body);
  if (!option) throw new Error(STEP_UP_REAUTH_UNAVAILABLE);

  const state = `${REAUTH_STATE_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
  const initiatedAt = Date.now();
  // Both branches mint a PKCE verifier through the SAME helpers sign-in uses and
  // keep it server-side in this entry; only its S256 challenge is in `url`.
  let url: string;
  if (option.type === 'oauth') {
    const authorize = buildOAuthReauthUrl(option.provider, state);
    url = authorize.url;
    await pendingReauth.put(state, {
      userId,
      type: 'oauth',
      provider: option.provider,
      initiatedAt,
      ...(authorize.codeVerifier && { codeVerifier: authorize.codeVerifier }),
    });
  } else {
    const cfg = await getEnforcedLoginConfig(option.orgId);
    const nonce = crypto.randomBytes(16).toString('hex');
    const authorize = await buildAuthorizeUrl(cfg, state, nonce, { reauth: true });
    url = authorize.url;
    await pendingReauth.put(state, {
      userId,
      type: 'sso',
      provider: cfg.provider,
      orgId: option.orgId,
      nonce,
      initiatedAt,
      ...(authorize.codeVerifier && { codeVerifier: authorize.codeVerifier }),
    });
  }

  sendSuccess(res, 200, { url, state, expiresAt: initiatedAt + REAUTH_STATE_TTL_MS });
}, STEP_UP_REAUTH_ERROR_MAP);

/** Refuse an `auth_time` older than the initiate call (beyond clock skew). */
function assertRecent(authTime: number | undefined, pending: PendingReauth, required: boolean): boolean {
  if (authTime === undefined) {
    if (required) throw new Error(STEP_UP_REAUTH_NOT_RECENT);
    return false;
  }
  if (authTime * 1000 < pending.initiatedAt - AUTH_TIME_SKEW_MS) throw new Error(STEP_UP_REAUTH_NOT_RECENT);
  return true;
}

/** POST /api/auth/step-up/reauth/callback — verify the re-auth and issue the token. */
export const completeStepUpReauth = withController('Step-up re-auth callback', async (req, res) => {
  const userId = req.user!.sub;
  const body = validateBody(oauthCallbackSchema, req.body, res);
  if (!body) return;

  // Consume first (single-use even when the rest fails), then bind to the caller.
  const pending = await pendingReauth.consume(body.state);

  let provider = pending?.provider;
  let recencyVerified = false;
  try {
    if (!pending || pending.userId !== userId) throw new Error(STEP_UP_REAUTH_INVALID_STATE);
    const user = await loadFactorUser(userId);
    if (!user) throw new Error(STEP_UP_REAUTH_UNAVAILABLE);

    // The option must still exist (provider not unlinked/disabled, SSO not turned
    // off, email not newly SSO-enforced) — the same rules sign-in applies now.
    const factors = await resolveAuthFactors(user);
    const option = findReauthOption(factors, pending.type === 'oauth'
      ? { type: 'oauth', provider: pending.provider }
      : { type: 'sso', orgId: pending.orgId! });
    if (!option) throw new Error(STEP_UP_REAUTH_UNAVAILABLE);

    if (pending.type === 'oauth') {
      const { userInfo, authTime } = await verifyOAuthReauthCode(pending.provider, body.code, pending.codeVerifier);
      const linked = user.oauth[pending.provider];
      if (!linked?.id || linked.id !== userInfo.id) throw new Error(STEP_UP_REAUTH_IDENTITY_MISMATCH);
      recencyVerified = assertRecent(authTime, pending, false);
    } else {
      const orgId = pending.orgId!;
      const cfg = await getEnforcedLoginConfig(orgId);
      provider = cfg.provider;
      // The org's IdP may have been switched to another provider mid-flight.
      if (cfg.provider !== pending.provider) throw new Error(STEP_UP_REAUTH_IDENTITY_MISMATCH);
      const identity = await exchangeAndValidate(cfg, body.code, pending.nonce!, { codeVerifier: pending.codeVerifier });
      await assertSsoIdentityTrusted(orgId, identity, { protocol: 'oidc', provider: cfg.provider });
      const linked = user.oauth[cfg.provider];
      if (!linked?.id || linked.id !== identity.subject || linked.issuer !== identity.issuer) {
        throw new Error(STEP_UP_REAUTH_IDENTITY_MISMATCH);
      }
      recencyVerified = assertRecent(identity.authTime, pending, ssoReauthRequiresAuthTime(cfg.provider));
    }
  } catch (err) {
    recordFailure(req, userId, err, provider);
  }

  const { token, expiresAt } = await issueStepUpToken(userId, 'reauth');
  audit(req, 'user.step-up', {
    targetType: 'user',
    targetId: userId,
    ...(pending!.orgId && { affectedOrgId: pending!.orgId }),
    details: { method: 'reauth', kind: pending!.type, provider, recencyVerified },
  });
  incCounter('platform_step_up_total', { method: 'reauth', outcome: 'success' });
  sendSuccess(res, 200, { ok: true, stepUpToken: token, expiresAt, method: 'reauth' });
}, STEP_UP_REAUTH_ERROR_MAP);
