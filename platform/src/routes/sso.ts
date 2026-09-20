// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org SSO login routes — OIDC and SAML 2.0. Mounted under `/auth/sso`
 * (behind the same `authLimiter` as the rest of `/auth`). These are
 * UNAUTHENTICATED by design — they ARE the login path — so enforcement (enabled
 * + `sso`-entitled) is applied inside the controllers, not by an auth
 * middleware.
 *
 * `/:orgId/authorize` is shared: it dispatches on the org's configured protocol.
 * The protocol-specific legs are the OIDC `/callback` (the browser hands back
 * the authorization code) and the SAML `/saml/*` routes (the IdP POSTs the
 * assertion to the ACS, and the landing page redeems the handoff).
 *
 * Route ORDER matters: the two-segment `/:orgId/saml/...` paths are declared
 * before nothing that could shadow them, and the literals (`/discover`,
 * `/start`) precede `/:orgId/...` so neither ever resolves as an org id.
 */

import { audited } from '@pipeline-builder/api-core';
import { Router } from 'express';
import { handleSamlSlo, startSsoLogout } from '../controllers/saml-slo.js';
import { completeSamlLogin, getSamlMetadata, handleSamlAcs } from '../controllers/saml.js';
import { discoverSso, getSsoAuthUrl, handleSsoCallback, startSsoLogin } from '../controllers/sso.js';
import { requireAuth } from '../middleware/index.js';

const router: Router = Router();

/** POST /auth/sso/discover - Is this email forced through SSO? (login page hint) */
router.post('/discover', discoverSso);

/** POST /auth/sso/start - Begin the flow for an EMAIL (the login page's "Continue
 *  with single sign-on"): resolves the enforcing org server-side and returns the
 *  same { url, state } the by-org route does, without naming the org. */
router.post('/start', startSsoLogin);

/** POST /auth/sso/logout - SP-initiated Single Logout for the CALLER'S OWN
 *  current session: { redirectUrl } to the IdP's SLO endpoint (a signed
 *  LogoutRequest) when that session came from a SAML sign-in and the IdP has an
 *  SLO URL, else { redirectUrl: null }. The app calls it just before /auth/logout. */
router.post('/logout', requireAuth, audited('sso.saml.logout'), startSsoLogout);

/** GET /auth/sso/:orgId/authorize - Get the IdP authorize URL for redirect (OIDC or SAML) */
router.get('/:orgId/authorize', getSsoAuthUrl);

/** POST /auth/sso/:orgId/callback - Exchange code + validate id_token → tokens (OIDC) */
router.post('/:orgId/callback', audited('user.login', 'user.login.failed'), handleSsoCallback);

/** GET /auth/sso/:orgId/saml/metadata - Service-provider metadata for the IdP admin */
router.get('/:orgId/saml/metadata', getSamlMetadata);

/** POST /auth/sso/:orgId/saml/acs - Assertion Consumer Service: the IdP posts the
 *  signed assertion here. Verifies, provisions, and redirects to the landing
 *  page with a one-time handoff (or an error code). */
router.post(
  '/:orgId/saml/acs',
  audited('sso.saml.refused', 'sso.jit.provision', 'sso.jit.role.change', 'user.login.failed'),
  handleSamlAcs,
);

/** POST /auth/sso/:orgId/saml/complete - Redeem the ACS handoff for a session */
router.post('/:orgId/saml/complete', audited('user.login'), completeSamlLogin);

/** GET|POST /auth/sso/:orgId/saml/slo - Single Logout endpoint (HTTP-Redirect and
 *  HTTP-POST bindings): the IdP's signed LogoutRequest (IdP-initiated — revokes
 *  that NameID's sessions in this org) or its LogoutResponse to ours. */
router.get('/:orgId/saml/slo', audited('sso.saml.logout'), handleSamlSlo);
router.post('/:orgId/saml/slo', audited('sso.saml.logout'), handleSamlSlo);

export default router;
