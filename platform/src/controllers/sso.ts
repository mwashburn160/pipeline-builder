// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org SSO login surface.
 *
 *   GET  /auth/sso/:orgId/authorize  → { url, state }  (initiate — redirect to IdP)
 *   POST /auth/sso/start             → { url, state }  (same, resolved from an email)
 *   POST /auth/sso/:orgId/callback   → tokens          (exchange code + validate id_token)
 *   POST /auth/sso/discover          → { sso, required } (does SSO serve this email's domain? is it required?)
 *
 * `authorize` serves BOTH protocols: it resolves the org's `protocol` and hands
 * a SAML org to `controllers/saml.ts`, returning the same `{ url, state }`
 * either way. The `callback` below is the OIDC leg only — SAML's assertion
 * arrives by IdP form POST at its own ACS route.
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
import { createLogger, getParam, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { isBootstrapSuperAdminEmail } from '../helpers/bootstrap-admin.js';
import { withController } from '../helpers/controller-helper.js';
import { bindLoginToBrowser, isBoundToThisBrowser } from '../helpers/login-binding.js';
import { MFA_POLICY_ERROR_MAP } from '../helpers/mfa-policy.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';
import { completeInteractiveSignIn, ssoAuth } from '../helpers/sign-in.js';
import { assertSsoIdentityTrusted, findSsoCoverageForEmail, getEnforcedIdpProtocol, getEnforcedLoginConfig } from '../helpers/sso-enforcement.js';
import { incCounter } from '../observability/metrics.js';
import { JIT_SEAT_LIMIT } from '../services/idp-mapping-errors.js';
import { authService } from '../services/index.js';
import {
  OIDC_ERROR_MAP,
  buildAuthorizeUrl,
  exchangeAndValidate,
} from '../services/oidc-service.js';
import { beginSamlLogin } from '../services/saml-login-state.js';
import { SAML_ERROR_MAP } from '../services/saml-service.js';
import { assertJitSeatAvailable, provisionJitMembership } from '../services/sso-jit-service.js';
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
const pendingSsoStates = createPendingStateStore<{ orgId: string; nonce: string; codeVerifier?: string; binding: string }>({
  prefix: 'sso:state:',
  ttlMs: config.oauth.stateTtlMs,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: MAX_PENDING_STATES,
});

// Route handlers

/**
 * Begin a login against `orgId`'s enforced IdP and return the redirect the
 * browser needs — `{ url, state }` on either protocol.
 *
 * One entry point, two protocols. The client redirects to `url` either way
 * and never has to know which one its org federates over; where the browser
 * comes BACK to differs (the OIDC callback page vs the SAML ACS) and is decided
 * by what we register with the IdP, not by the client. Discovery runs here so an
 * unreachable IdP fails now, before the browser leaves.
 */
async function beginSsoLogin(orgId: string, binding: string): Promise<{ url: string; state: string }> {
  if (await getEnforcedIdpProtocol(orgId) === 'saml') return beginSamlLogin(orgId, binding);

  const cfg = await getEnforcedLoginConfig(orgId);

  const state = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const { url, codeVerifier } = await buildAuthorizeUrl(cfg, state, nonce);

  await pendingSsoStates.put(state, { orgId, nonce, binding, ...(codeVerifier && { codeVerifier }) });

  return { url, state };
}

/**
 * GET /auth/sso/:orgId/authorize — initiate the flow for a KNOWN org. The org
 * handle reaches the client through the `SSO_REQUIRED` login rejection (or a
 * step-up, where the session already names the org), never through `discover`.
 */
export const getSsoAuthUrl = withController('Get SSO URL', async (req, res) => {
  // Bound to THIS browser (a Lax nonce cookie) — see helpers/login-binding.ts.
  sendSuccess(res, 200, await beginSsoLogin(getParam(req.params, 'orgId')!, bindLoginToBrowser(res)));
}, { ...OIDC_ERROR_MAP, ...SAML_ERROR_MAP });

/**
 * POST /auth/sso/start — initiate the flow for an EMAIL, for a login page that
 * has only what the person typed.
 *
 * This exists so the sign-in form can offer SSO without ever being told which
 * org backs the domain: the coverage lookup happens here, and the response is
 * the same `{ url, state }` the by-org route returns. `discover` therefore stays
 * a bare yes/no pair (C2, the enumeration-oracle fix) — the org handle is never
 * handed to an anonymous caller, only baked into a redirect the person asked
 * for by clicking.
 *
 * Works for every domain an enabled + entitled IdP SERVES (whether or not the
 * org also REQUIRES SSO). A domain no IdP serves is refused: it is the password
 * path's job to sign those people in, and answering with anything else here
 * would make this a second, quieter discovery oracle.
 */
export const startSsoLogin = withController('Start SSO', async (req, res) => {
  const body = validateBody(ssoDiscoverSchema, req.body, res);
  if (!body) return;

  const coverage = await findSsoCoverageForEmail(body.email);
  if (!coverage) {
    sendError(res, 404, 'Single sign-on is not available for this email address.', 'SSO_NOT_AVAILABLE');
    return;
  }

  sendSuccess(res, 200, await beginSsoLogin(coverage.orgId, bindLoginToBrowser(res)));
}, { ...OIDC_ERROR_MAP, ...SAML_ERROR_MAP });

/** Label a failed provisioning attempt for the audit row + metric. Only the seat
 *  cap is an expected refusal; anything else is an infrastructure failure and is
 *  counted separately so a Mongo outage can't masquerade as a full account. */
function jitRefusalReason(err: unknown): string {
  return (err instanceof Error && err.message === JIT_SEAT_LIMIT) ? 'seat_limit' : 'error';
}

/**
 * Record a refused just-in-time provision and re-throw so the typed error
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
    // LOGIN CSRF: honoured only in the browser that started this flow.
    if (!isBoundToThisBrowser(req, pending.binding)) throw new Error('OIDC_INVALID_STATE');
    const cfg = await getEnforcedLoginConfig(orgId);
    provider = cfg.provider;
    // The PKCE verifier comes from the (now consumed) state — never from the
    // request — so a replayed or forged callback has none to present.
    identity = await exchangeAndValidate(cfg, body.code, pending.nonce, { codeVerifier: pending.codeVerifier });
    // The org's IdP vouching for an email proves nothing unless the org owns
    // that domain — checked before the identity can reach or create any account.
    await assertSsoIdentityTrusted(orgId, identity, { protocol: 'oidc', provider: cfg.provider });
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

  // JIT: seats are checked BEFORE the identity becomes an account, so a
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
  // Single sign-on opens an INTERACTIVE session (`amr: ['sso']`); its assurance
  // is the org's statement about its own IdP (see `ssoAuth`).
  await completeInteractiveSignIn(req, res, user, {
    orgId,
    auth: await ssoAuth(orgId),
    affectedOrgId: orgId,
    auditDetails: { method: 'sso' },
    clearBinding: true,
  });
  logger.info('[SSO] login successful', { orgId, userId: user._id, provider });
}, { ...OIDC_ERROR_MAP, ...MFA_POLICY_ERROR_MAP });

/**
 * POST /auth/sso/discover — public (UNAUTHENTICATED) helper for the login page.
 * Given an email, report ONLY whether an enabled + entitled org IdP SERVES that
 * domain (`sso`) and whether the org REQUIRES it (`required`) — two booleans.
 *
 * `required` is about the DOMAIN's policy, not the person: the owner break-glass
 * exemption is never reflected here (that would tell an anonymous caller which
 * addresses own the org). The login page therefore leads with SSO when
 * `required` is set and keeps a quiet "sign in with a password instead" path for
 * the owners the backend will still admit.
 *
 * It deliberately does NOT leak the internal `orgId` or IdP `provider`: this
 * endpoint is anonymous, so returning those turned it into an enumeration oracle
 * (any caller could probe which domains are SSO-enforced AND harvest internal
 * org identifiers). The sign-in form does not need them either — it hides the
 * password field on a `true` and starts the flow through `POST /auth/sso/start`,
 * which resolves the org server-side. Where the org IS already known (a password
 * attempt refused with `SSO_REQUIRED` + `{ orgId, provider }`, or a step-up), the
 * by-org initiate route is used instead.
 *
 * The answer is about the DOMAIN, never the address: an address with no account
 * gets exactly the same answer as one with an account on it.
 */
export const discoverSso = withController('Discover SSO', async (req, res) => {
  const body = validateBody(ssoDiscoverSchema, req.body, res);
  if (!body) return;

  // Same bootstrap-admin carve-out the password login makes (controllers/auth.ts):
  // SSO refuses superadmins outright, so telling the login page to hide the
  // password field for this address would close BOTH sign-in paths and leave the
  // install with no way in. Reflects a decision about the CALLER'S OWN address;
  // it reveals nothing they did not already type.
  const coverage = isBootstrapSuperAdminEmail(body.email)
    ? null
    : await findSsoCoverageForEmail(body.email);
  sendSuccess(res, 200, { sso: !!coverage, required: !!coverage?.required });
});
