// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org SAML 2.0 login surface — the second protocol behind the SAME
 * sign-in path as OIDC (`controllers/sso.ts`).
 *
 *   GET  /auth/sso/:orgId/authorize       → { url, state }  (shared entry point;
 *                                            controllers/sso.ts dispatches to
 *                                            services/saml-login-state.ts when
 *                                            the org's protocol is SAML)
 *   POST /auth/sso/:orgId/saml/acs        → 302 to the landing page (the IdP's
 *                                            assertion lands here)
 *   POST /auth/sso/:orgId/saml/complete   → tokens (the landing page redeems the
 *                                            one-time handoff)
 *   GET  /auth/sso/:orgId/saml/metadata   → SP metadata XML (for the IdP admin)
 *   GET|POST /auth/sso/:orgId/saml/slo    → Single Logout (controllers/saml-slo.ts)
 *
 * WHY THREE LEGS instead of OIDC's two: SAML delivers its assertion by an
 * IdP-driven form POST to a SERVER endpoint, not by a redirect the frontend can
 * read. So the ACS does all the verification and identity work, parks the
 * RESULT behind a one-time handoff in the shared Redis store, and redirects the
 * browser to the landing page; that page — a same-origin `fetch` carrying the
 * `X-Pb-Client` header — redeems the handoff, which is what lets the session
 * use the same cookie/body transport split every other login uses. No token
 * ever travels through a URL, and the handoff is single-use and org-bound.
 *
 * The checks between the assertion and the session are the OIDC ones, in the
 * same order and from the same modules: the org's DNS-verified authority over
 * the email domain (`assertSsoIdentityTrusted`), issuer-bound account linking
 * and the platform-admin refusal (`findOrCreateOAuthUser`), the seat pre-flight
 * and JIT membership + group→Role sync (`services/sso-jit-service.ts`).
 *
 * Every session a SAML sign-in opens is recorded with the IdP's `NameID` and
 * `SessionIndex` (models/saml-session.ts), which is what Single Logout
 * (controllers/saml-slo.ts) matches on in both directions.
 *
 * A RelayState carrying the dry-run marker is a TEST CONNECTION, not a sign-in:
 * the ACS hands it to helpers/sso-test-flow.ts before any sign-in logic runs.
 */

import crypto from 'crypto';
import { createLogger, getParam } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { audit } from '../helpers/audit.js';
import { withController } from '../helpers/controller-helper.js';
import { isBoundToThisBrowser } from '../helpers/login-binding.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';
import { completeInteractiveSignIn, ssoAuth } from '../helpers/sign-in.js';
import { assertSsoIdentityTrusted, getEnforcedSamlConfig } from '../helpers/sso-enforcement.js';
import { handleSamlTestAssertion, isTestState } from '../helpers/sso-test-flow.js';
import { User } from '../models/index.js';
import { incCounter } from '../observability/metrics.js';
import { SSO_SUPERADMIN_REFUSED } from '../services/auth-errors.js';
import { JIT_SEAT_LIMIT } from '../services/idp-mapping-errors.js';
import { authService } from '../services/index.js';
import { orgIdpService } from '../services/org-idp-service.js';
import { consumeSamlRelayState } from '../services/saml-login-state.js';
import {
  SAML_ERROR_MAP,
  type SamlLoginConfig,
  buildSamlMetadata,
  samlLandingUrl,
  validateSamlResponse,
  type SamlSessionRef,
} from '../services/saml-service.js';
import { recordSamlSession } from '../services/saml-sessions.js';
import { assertJitSeatAvailable, provisionJitMembership } from '../services/sso-jit-service.js';
import { samlAcsSchema, samlCompleteSchema } from '../utils/validation-idp.js';
import { validateBody } from '../utils/validation.js';

const logger = createLogger('saml-controller');

/** The SAML provider key under `User.oauth` — see models/user.ts. A SAML config
 *  has no named provider, and the link is only ever matched together with its
 *  issuer (the IdP entity id), so one key serves every SAML IdP. */
const SAML_PROVIDER_KEY = 'saml';

/**
 * The ACS's verified result, waiting for the browser to collect it.
 *
 * Holds `{ orgId, userId }` plus the IdP's handle on the sign-in (issuer,
 * NameID, SessionIndex — for Single Logout) — never tokens: the session is
 * minted at redemption, from the redeeming request, so it carries that
 * request's client info and its cookie/body transport choice. Short-lived and
 * consume-once.
 */
const pendingSamlHandoffs = createPendingStateStore<{ orgId: string; userId: string; issuer: string; session: SamlSessionRef; binding: string }>({
  prefix: 'saml:handoff:',
  ttlMs: config.oauth.samlHandoffTtlMs,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.oauth.maxPendingStates,
});


// Metadata

/**
 * GET /auth/sso/:orgId/saml/metadata — the SP metadata document an IdP
 * administrator imports to create the application on their side.
 *
 * Deliberately UNCONDITIONAL: it is derived from the org id, this deployment's
 * public URL and SP keys, and the org's two SAML switches (sign AuthnRequests,
 * encrypted assertions) — both of which read as `false` for an org with no
 * config, so an unknown org gets the same document a fresh one does and this is
 * not an existence oracle. It must also work BEFORE the connection does: an
 * admin needs these values to configure the IdP in the first place, so gating it
 * on a working config would be a deadlock.
 */
export const getSamlMetadata = withController('SAML SP metadata', async (req, res) => {
  const orgId = getParam(req.params, 'orgId')!;
  const cfg = await orgIdpService.findByOrg(orgId);
  const xml = await buildSamlMetadata(orgId, {
    signAuthnRequests: cfg?.samlSignAuthnRequests ?? false,
    encryptAssertions: cfg?.samlEncryptAssertions ?? false,
  });
  res.type('application/samlmetadata+xml').status(200).send(xml);
}, SAML_ERROR_MAP);

// Assertion consumer service

/** The stable audit/metric label for a refusal. Every failure gets one, so a
 *  connection that has quietly stopped working is visible as a shape in the
 *  metric rather than only as user complaints. */
function refusalReason(err: unknown): string {
  const code = err instanceof Error ? err.message : '';
  switch (code) {
    case 'SAML_IDP_INITIATED': return 'idp_initiated';
    case 'SAML_REPLAYED_ASSERTION': return 'replay';
    case 'SAML_INVALID_ASSERTION': return 'invalid_assertion';
    case 'SAML_ENCRYPTION_REQUIRED': return 'encryption_required';
    case 'SAML_UNEXPECTED_ENCRYPTION': return 'unexpected_encryption';
    case 'SAML_INVALID_STATE': return 'invalid_state';
    case 'SAML_NO_EMAIL': return 'no_email';
    case 'SAML_EMAIL_DOMAIN_NOT_ALLOWED': return 'email_domain_not_allowed';
    case 'OIDC_EMAIL_DOMAIN_NOT_VERIFIED': return 'domain_not_verified';
    case SSO_SUPERADMIN_REFUSED: return 'platform_admin';
    case JIT_SEAT_LIMIT: return 'seat_limit';
    case 'SAML_NOT_CONFIGURED': return 'not_configured';
    case 'SAML_DISABLED': return 'disabled';
    case 'SAML_NOT_ENTITLED': return 'not_entitled';
    case 'SAML_PROTOCOL_MISMATCH': return 'protocol_mismatch';
    case 'SAML_INCOMPLETE_CONFIG': return 'incomplete_config';
    default: return 'error';
  }
}

/** Error codes the landing page is allowed to be told verbatim. Anything else
 *  collapses to `error` so a probe can't read internal state off the redirect. */
const PUBLIC_REFUSAL_CODES = new Set<string>([
  'SAML_IDP_INITIATED', 'SAML_REPLAYED_ASSERTION', 'SAML_INVALID_ASSERTION', 'SAML_INVALID_STATE',
  'SAML_NO_EMAIL', 'SAML_EMAIL_DOMAIN_NOT_ALLOWED', 'SAML_NOT_CONFIGURED', 'SAML_DISABLED',
  'SAML_NOT_ENTITLED', 'SAML_PROTOCOL_MISMATCH', 'SAML_INCOMPLETE_CONFIG',
  'SAML_ENCRYPTION_REQUIRED', 'SAML_UNEXPECTED_ENCRYPTION',
  'OIDC_EMAIL_DOMAIN_NOT_VERIFIED', SSO_SUPERADMIN_REFUSED, JIT_SEAT_LIMIT,
]);

/**
 * Record a refused assertion and send the browser back to the landing page.
 *
 * The browser is sitting on a form POST from the IdP, so a JSON body would be a
 * dead end — a redirect is the only outcome a person can act on. The refusal is
 * audited and counted first: an IdP-initiated attempt and a replay are both
 * security events that must leave a trail whether or not anyone is watching the
 * screen.
 */
function refuseAssertion(req: Request, res: Response, orgId: string, err: unknown): void {
  const reason = refusalReason(err);
  const code = err instanceof Error ? err.message : 'error';
  audit(req, 'sso.saml.refused', {
    targetType: 'user',
    outcome: 'failure',
    affectedOrgId: orgId,
    details: { reason, protocol: 'saml' },
  });
  audit(req, 'user.login.failed', {
    targetType: 'user',
    outcome: 'failure',
    affectedOrgId: orgId,
    details: { method: 'saml', orgId, reason },
  });
  incCounter('platform_saml_signins_total', { result: reason });
  incCounter('platform_logins_failed_total');
  logger.warn('[SAML] sign-in refused', { orgId, reason });
  const publicCode = PUBLIC_REFUSAL_CODES.has(code) ? code : 'SAML_ERROR';
  res.redirect(302, `${samlLandingUrl(orgId)}?error=${encodeURIComponent(publicCode)}`);
}

/**
 * Turn a verified assertion into a platform account + org membership.
 *
 * Extracted so the ACS reads as the sequence of rules it enforces. Every step
 * here is the OIDC path's step, called from the same module — this is the point
 * of the whole item: one identity pipeline, two protocols feeding it.
 */
async function provisionFromAssertion(
  req: Request,
  orgId: string,
  cfg: SamlLoginConfig,
  samlResponse: string,
  state: string,
  relayState: string | undefined,
): Promise<{ userId: string; issuer: string; session: SamlSessionRef }> {
  const identity = await validateSamlResponse(cfg, samlResponse, relayState, state);

  // The org's IdP vouching for an email proves nothing unless the org has
  // proven it owns that domain.
  await assertSsoIdentityTrusted(orgId, identity, { protocol: 'saml' });

  // Seats are checked BEFORE the identity becomes an account, so a sign-in the
  // seat cap will refuse doesn't leave a user record (and its personal org)
  // behind. The authoritative check runs again inside the provisioning txn.
  await assertJitSeatAvailable(orgId, identity.email);

  // Same identity→user mapping the OIDC and social callbacks use: link by
  // verified email, auto-create for a brand-new identity, refuse platform
  // administrators, and bind the subject to THIS issuer.
  const user = await authService.findOrCreateOAuthUser(SAML_PROVIDER_KEY, {
    id: identity.subject,
    email: identity.email,
    name: identity.name,
  }, {
    markOnboarding: false,
    sso: { issuer: identity.issuer },
  });

  const jit = await provisionJitMembership({ orgId, user, groups: identity.groups });
  if (jit.membershipCreated) {
    audit(req, 'sso.jit.provision', {
      targetType: 'user',
      targetId: user._id.toString(),
      affectedOrgId: orgId,
      details: { provider: SAML_PROVIDER_KEY, protocol: 'saml', matchedGroups: jit.matchedGroups, roles: jit.rolesAdded },
    });
  } else if (jit.rolesAdded.length > 0 || jit.rolesRemoved.length > 0) {
    audit(req, 'sso.jit.role.change', {
      targetType: 'user',
      targetId: user._id.toString(),
      affectedOrgId: orgId,
      details: { provider: SAML_PROVIDER_KEY, protocol: 'saml', matchedGroups: jit.matchedGroups, added: jit.rolesAdded, removed: jit.rolesRemoved },
    });
  }
  return { userId: user._id.toString(), issuer: identity.issuer, session: identity.session };
}

/**
 * POST /auth/sso/:orgId/saml/acs — the Assertion Consumer Service.
 *
 * Unauthenticated by construction (it IS the login path) and reached by an
 * IdP-driven form POST, so every outcome is a redirect rather than a body: on
 * success a one-time handoff the landing page redeems, on failure an error code
 * the landing page explains. Nothing here is decided by anything the browser
 * sent except the assertion itself and the `RelayState` we minted.
 */
export const handleSamlAcs = withController('SAML ACS', async (req, res) => {
  const orgId = getParam(req.params, 'orgId')!;

  const body = validateBody(samlAcsSchema, req.body, res);
  if (!body) return;

  // A TEST CONNECTION's assertion never reaches the sign-in logic below: it is
  // verified in dry-run mode and reported back to the admin who started it.
  if (isTestState(body.RelayState)) {
    await handleSamlTestAssertion(res, orgId, body.SAMLResponse, body.RelayState);
    return;
  }

  let result: { userId: string; issuer: string; session: SamlSessionRef };
  let binding: string;
  try {
    // An assertion with no RelayState is unsolicited — IdP-initiated — and is
    // refused before anything else happens.
    const relay = await consumeSamlRelayState(orgId, body.RelayState);
    binding = relay.binding;
    const cfg = await getEnforcedSamlConfig(orgId);
    result = await provisionFromAssertion(req, orgId, cfg, body.SAMLResponse, relay.state, body.RelayState);
  } catch (err) {
    refuseAssertion(req, res, orgId, err);
    return;
  }

  const handoff = crypto.randomBytes(32).toString('hex');
  await pendingSamlHandoffs.put(handoff, { orgId, ...result, binding });
  res.redirect(302, `${samlLandingUrl(orgId)}?handoff=${handoff}`);
}, SAML_ERROR_MAP);

/**
 * POST /auth/sso/:orgId/saml/complete — redeem the ACS's one-time handoff for a
 * session.
 *
 * The session is minted HERE, not at the ACS, so it records the browser that is
 * actually signing in (client info, and the `X-Pb-Client` cookie/body split) and
 * so no token ever passes through a redirect URL. The handoff is consumed on any
 * lookup, valid or not.
 */
export const completeSamlLogin = withController('SAML complete', async (req, res) => {
  const orgId = getParam(req.params, 'orgId')!;

  const body = validateBody(samlCompleteSchema, req.body, res);
  if (!body) return;

  const pending = await pendingSamlHandoffs.consume(body.handoff);
  if (!pending || pending.orgId !== orgId) throw new Error('SAML_INVALID_STATE');
  // LOGIN CSRF: the handoff is redeemable only by the browser that started the
  // sign-in (the binding cookie set at initiate — helpers/login-binding.ts).
  if (!isBoundToThisBrowser(req, pending.binding)) throw new Error('SAML_INVALID_STATE');

  // `+tokenVersion` / `+isSuperAdmin` are `select: false` on the schema and both
  // feed token issuance; the superadmin refusal already ran at the ACS, and it
  // is re-asserted here so a promotion between the two legs cannot slip through.
  const user = await User.findById(pending.userId).select('+tokenVersion +isSuperAdmin');
  if (!user) throw new Error('SAML_INVALID_STATE');
  if (user.isSuperAdmin === true) throw new Error(SSO_SUPERADMIN_REFUSED);

  // Prefer the SAML org as active org; `issueTokens` falls back to the user's
  // own membership if they aren't a member. SAML opens an INTERACTIVE session
  // stamped `amr: ['sso']`, exactly like OIDC — the protocol is an
  // implementation detail of how the person proved themselves, not a different
  // kind of session — and earns `aal: 2` on the same terms (see `ssoAuth`).
  await completeInteractiveSignIn(req, res, user, {
    orgId,
    auth: await ssoAuth(orgId),
    affectedOrgId: orgId,
    auditDetails: { method: 'saml' },
    clearBinding: true,
    // Remember the IdP's handle on this sign-in against the session slot, so
    // Single Logout can find it from either end.
    afterIssue: (tokens) => recordSamlSession({
      userId: user._id.toString(),
      orgId,
      accessToken: tokens.accessToken,
      issuer: pending.issuer,
      session: pending.session,
    }),
  });
  incCounter('platform_saml_signins_total', { result: 'success' });
  logger.info('[SAML] login successful', { orgId, userId: String(user._id) });
}, { ...SAML_ERROR_MAP, [SSO_SUPERADMIN_REFUSED]: { status: 403, message: 'Platform administrators cannot sign in through an organization\'s single sign-on' } });
