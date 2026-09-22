// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC enforcement engine for per-org SSO.
 *
 * This is the runtime the `OrgIdpConfig` scaffolding was always waiting for
 * (models/org-idp-config.ts): it reads the org's `discoveryUrl` / `clientId` /
 * decrypted `clientSecret` and drives a real OpenID-Connect authorization-code
 * flow — discovery + JWKS-validated `id_token` — so a customer's own IdP
 * authenticates their users.
 *
 * Scope: the DISCOVERY-based OIDC path (`generic-oidc`, plus `google` whose
 * discovery doc is well-known). `github` is intentionally rejected here — it is
 * NOT an OpenID provider (no `id_token` / discovery), so per-org GitHub SSO
 * would ride the userinfo-based `controllers/oauth.ts` path, which is out of
 * this module's scope (see OIDC_ERROR_MAP.OIDC_PROVIDER_UNSUPPORTED).
 *
 * No new crypto dependency: RS/ES signature validation uses Node's native
 * `crypto.createPublicKey({ format: 'jwk' })` to turn a JWKS key into a public
 * key that `jsonwebtoken.verify` checks. `alg: none` and any HMAC alg are
 * rejected before verification so a tampered/unsigned token can never pass.
 *
 * Discovery + JWKS documents are cached in-memory with a short TTL, mirroring
 * the in-memory OAuth-state map in `controllers/oauth.ts`. Multi-pod caveat is
 * identical to that existing surface (each pod keeps its own cache); a stolen
 * cache entry is not a concern because these documents are public.
 */

import crypto from 'crypto';
import { createLogger, safeFetch, type SafeFetchResponse, errorMessage } from '@pipeline-builder/api-core';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { extractGroupClaim } from '../helpers/idp-claims.js';
import { PKCE_METHOD_S256, createCodeVerifier, pkceAuthorizeParams } from '../helpers/pkce.js';
import { GOOGLE_DISCOVERY_URL, isCustomGoogleDiscoveryUrl, isReservedDiscoveryUrl, isReservedIssuer } from '../helpers/reserved-issuers.js';

const logger = createLogger('oidc-service');

/** Discovery/JWKS cache TTL (see config.oauth.oidcDocCacheTtlMs). */
const DOC_CACHE_TTL_MS = config.oauth.oidcDocCacheTtlMs;

/** Signature algorithms we accept on an `id_token`. Asymmetric only — an HMAC
 *  alg (`HS*`) would let anyone holding the (public) client-id-shaped secret
 *  forge a token, and `none` is unsigned. Restricting the allow-list is the
 *  primary defense against the classic JWT alg-confusion attack. */
const ALLOWED_ID_TOKEN_ALGS = new Set([
  'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512',
]);

/**
 * Typed OIDC error → HTTP status map. Wired into `withController` by the SSO
 * controller so a failed federation surfaces a correct, non-leaky status.
 */
export const OIDC_ERROR_MAP = {
  OIDC_NOT_CONFIGURED: { status: 404, message: 'No SSO identity provider is configured for this organization' },
  OIDC_DISABLED: { status: 403, message: 'SSO is not enabled for this organization' },
  OIDC_NOT_ENTITLED: { status: 403, message: 'This organization is not entitled to SSO' },
  OIDC_PROVIDER_UNSUPPORTED: { status: 400, message: 'This identity provider does not support OIDC single sign-on' },
  // The org federates over SAML (#4), so the OIDC legs of the flow don't apply
  // to it. Distinct from PROVIDER_UNSUPPORTED: nothing is misconfigured, the
  // caller simply asked for the wrong protocol.
  OIDC_PROTOCOL_MISMATCH: { status: 400, message: 'This organization signs in with SAML, not OIDC' },
  OIDC_DISCOVERY_FAILED: { status: 502, message: 'Could not load the identity provider configuration' },
  OIDC_INVALID_STATE: { status: 403, message: 'Invalid or expired SSO state' },
  OIDC_TOKEN_EXCHANGE_FAILED: { status: 502, message: 'Failed to exchange the authorization code' },
  OIDC_INVALID_ID_TOKEN: { status: 401, message: 'The identity provider returned an invalid token' },
  OIDC_NO_EMAIL: { status: 400, message: 'The identity provider did not return a verified email address' },
  OIDC_EMAIL_DOMAIN_NOT_ALLOWED: { status: 403, message: 'Your email domain is not permitted to sign in to this organization' },
  OIDC_EMAIL_DOMAIN_NOT_VERIFIED: { status: 403, message: 'This organization has not verified ownership of your email domain, so it cannot sign you in with single sign-on' },
  // Just-in-time provisioning (3a). Key must match `JIT_SEAT_LIMIT` in
  // services/sso-jit-errors.ts — the sign-in is REFUSED (rather than silently
  // signing the user in without a membership) so the seat cap means the same
  // thing here as it does on the invitation path.
  JIT_SEAT_LIMIT: { status: 403, message: 'Your organization has no seats left, so single sign-on could not add you to it. Ask an administrator to free a seat or raise the seat limit.' },
  // Key must match `SSO_SUPERADMIN_REFUSED` in auth-service.ts (literal for the same reason as below).
  SSO_SUPERADMIN_REFUSED: { status: 403, message: 'Platform administrators cannot sign in through an organization\'s single sign-on' },
  // Key must match `ACCOUNT_EMAIL_UNVERIFIED` in auth-service.ts (kept a literal
  // here to avoid importing the large auth-service module into this core service).
  ACCOUNT_EMAIL_UNVERIFIED: { status: 409, message: 'An account already exists for this email but is not verified. Verify (or reset the password on) that account first, then sign in.' },
} as const;

// Discovery + JWKS

interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  /** RFC 8414: the PKCE challenge methods this issuer accepts. Optional — many
   *  conformant issuers support PKCE without advertising it. */
  code_challenge_methods_supported?: string[];
}

interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface CachedDoc<T> { value: T; fetchedAt: number }

const discoveryCache = new Map<string, CachedDoc<DiscoveryDoc>>();
const jwksCache = new Map<string, CachedDoc<Jwk[]>>();

/** TEST-ONLY: clear the in-memory discovery/JWKS caches. */
export function __resetOidcCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

/**
 * Normalize a stored `discoveryUrl` to the canonical well-known endpoint. The
 * scaffolding stored the FULL well-known URL, but item-45 also allows the bare
 * issuer — accept both so a config entered either way resolves.
 */
function wellKnownUrl(discoveryUrl: string): string {
  const trimmed = discoveryUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/.well-known/openid-configuration')) return trimmed;
  return `${trimmed}/.well-known/openid-configuration`;
}

async function fetchDiscovery(discoveryUrl: string): Promise<DiscoveryDoc> {
  const url = wellKnownUrl(discoveryUrl);
  const cached = discoveryCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < DOC_CACHE_TTL_MS) return cached.value;

  let res: SafeFetchResponse;
  try {
    // SSRF: `discoveryUrl` is admin-supplied, so an org-admin/superadmin could
    // otherwise point it at 169.254.169.254 or an internal service. safeFetch
    // rejects non-https / private / loopback / link-local hosts, PINS the vetted
    // address into the socket (no re-resolve window) and refuses redirects.
    res = await safeFetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    logger.warn('OIDC discovery fetch failed', { url, error: errorMessage(err) });
    throw new Error('OIDC_DISCOVERY_FAILED');
  }
  if (!res.ok || res.redirected) throw new Error('OIDC_DISCOVERY_FAILED');
  const doc = res.json() as Partial<DiscoveryDoc>;
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('OIDC_DISCOVERY_FAILED');
  }
  const value = doc as DiscoveryDoc;
  discoveryCache.set(url, { value, fetchedAt: Date.now() });
  return value;
}

async function fetchJwks(jwksUri: string, force = false): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUri);
  if (!force && cached && Date.now() - cached.fetchedAt < DOC_CACHE_TTL_MS) return cached.value;

  let res: SafeFetchResponse;
  try {
    // The jwks_uri comes from the (admin-supplied) discovery document, so it is
    // equally untrusted — same pinned, redirect-refusing fetch.
    res = await safeFetch(jwksUri, { headers: { Accept: 'application/json' } });
  } catch (err) {
    logger.warn('OIDC JWKS fetch failed', { jwksUri, error: errorMessage(err) });
    throw new Error('OIDC_DISCOVERY_FAILED');
  }
  if (!res.ok || res.redirected) throw new Error('OIDC_DISCOVERY_FAILED');
  const body = res.json() as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(jwksUri, { value: keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * Resolve the JWKS signing key for a token's `kid` into a PEM public key.
 * A `kid` miss triggers ONE forced JWKS refetch (covers routine key rotation)
 * before giving up.
 */
async function resolveSigningKey(jwksUri: string, kid: string | undefined): Promise<string> {
  const pick = (keys: Jwk[]): Jwk | undefined =>
    kid ? keys.find(k => k.kid === kid) : (keys.length === 1 ? keys[0] : undefined);

  let jwk = pick(await fetchJwks(jwksUri));
  if (!jwk) jwk = pick(await fetchJwks(jwksUri, true));
  if (!jwk) throw new Error('OIDC_INVALID_ID_TOKEN');

  try {
    // Node imports a JWK directly (Node >= 16) — no third-party JWKS lib needed.
    // `JsonWebKey` isn't a global here (no DOM lib); reference the type through
    // Node's exported JsonWebKeyInput so the JWK import typechecks without it.
    const keyObject = crypto.createPublicKey({ key: jwk as crypto.JsonWebKeyInput['key'], format: 'jwk' });
    return keyObject.export({ format: 'pem', type: 'spki' }).toString();
  } catch (err) {
    logger.warn('OIDC JWK → public key conversion failed', { kid, error: errorMessage(err) });
    throw new Error('OIDC_INVALID_ID_TOKEN');
  }
}

// Claim shape

/** The provider-VERIFIED identity extracted from a validated `id_token`. */
export interface OidcIdentity {
  /** IdP subject identifier (stable per-user within the IdP — NOT across IdPs). */
  subject: string;
  /** The validated `iss`. A subject is only unique together with its issuer, and
   *  an org admin fully controls the subjects a generic-OIDC/Cognito IdP mints. */
  issuer: string;
  email: string;
  name?: string;
  /** `auth_time` (epoch seconds) when the IdP reported it — when the user last
   *  actually authenticated. Step-up re-auth uses it to prove a fresh sign-in. */
  authTime?: number;
  /** Group memberships asserted by the IdP, read from the org's configured
   *  `groupsClaim` (3a). Empty when the claim is absent, malformed, or the
   *  provider carries no groups (Google). Drives JIT Role mapping ONLY — it is
   *  never trusted as a permission by itself. */
  groups: string[];
}

interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  nonce?: string;
  auth_time?: number;
}

// Public surface

/** Everything the login flow needs, resolved from an enabled OrgIdpConfig. */
export interface OidcLoginConfig {
  orgId: string;
  provider: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  /** AWS Cognito region — used to DERIVE discovery for `provider: 'cognito'`. */
  region?: string;
  /** AWS Cognito user-pool id — used to DERIVE discovery for `provider: 'cognito'`. */
  userPoolId?: string;
  /** id_token claim carrying group memberships (3a). Unset = `groups`. */
  groupsClaim?: string;
  allowedEmailDomains: string[];
}

/** Per-org callback URL: `${callbackBaseUrl}/auth/sso/:orgId/callback`. The
 *  IdP redirects the browser here; the frontend posts the code back. */
export function ssoCallbackUrl(orgId: string): string {
  return `${config.oauth.callbackBaseUrl}/auth/sso/${orgId}/callback`;
}

/**
 * Resolve the effective discovery URL for a config:
 *   - `cognito`      → DERIVED from region + userPoolId (no hand-entered URL)
 *   - `generic-oidc` → the admin-supplied `discoveryUrl` (schema-required)
 *   - `google`       → ALWAYS the hard-coded Google discovery document. A
 *                      custom discoveryUrl is refused: Google identities skip
 *                      domain verification, so the document they are verified
 *                      against must never be admin-chosen.
 *   - `github`       → NOT an OpenID provider → OIDC_PROVIDER_UNSUPPORTED
 *
 * A generic OIDC discovery URL on a reserved (Google) host is refused too.
 */
function discoveryUrlFor(cfg: OidcLoginConfig): string {
  if (cfg.provider === 'cognito') {
    if (!cfg.region || !cfg.userPoolId) throw new Error('OIDC_PROVIDER_UNSUPPORTED');
    // AWS Cognito's standard OIDC discovery document. The user-pool id is not an
    // AWS account id, so deriving/storing this leaks no account identifier.
    return `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}/.well-known/openid-configuration`;
  }
  if (cfg.provider === 'google') {
    if (isCustomGoogleDiscoveryUrl(cfg.discoveryUrl)) throw new Error('OIDC_PROVIDER_UNSUPPORTED');
    return GOOGLE_DISCOVERY_URL;
  }
  if (cfg.discoveryUrl) {
    if (isReservedDiscoveryUrl(cfg.discoveryUrl)) throw new Error('OIDC_PROVIDER_UNSUPPORTED');
    return cfg.discoveryUrl;
  }
  // generic-oidc always carries a discoveryUrl (schema-enforced); reaching here
  // means github (no id_token) or a malformed named-provider config.
  throw new Error('OIDC_PROVIDER_UNSUPPORTED');
}

/**
 * Whether a step-up re-auth through this IdP MUST come back with `auth_time`.
 * `max_age` obliges a conformant OIDC provider to return it (OIDC Core §3.1.2.1),
 * so generic OIDC and Cognito fail closed without it. Google ignores
 * `max_age`/`prompt=login` and omits `auth_time`; its recency is enforced only
 * when the claim is present (documented limitation, docs/authentication.md).
 */
export function ssoReauthRequiresAuthTime(provider: string): boolean {
  return provider !== 'google';
}

/** Authorize params that force a fresh sign-in for step-up re-auth. Google
 *  rejects `prompt=login` (it only knows none/consent/select_account). */
function ssoReauthParams(provider: string): Record<string, string> {
  return provider === 'google'
    ? { prompt: 'select_account', max_age: '0' }
    : { prompt: 'login', max_age: '0' };
}

/**
 * Whether to protect this flow with PKCE (RFC 7636).
 *
 * The rule, in the order a reader will ask about it:
 *   - the issuer advertises `code_challenge_methods_supported` including `S256`
 *     → yes;
 *   - it advertises the field WITHOUT `S256` (i.e. `plain` only) → **no**. We
 *     never negotiate down to `plain`, which offers no protection at all;
 *   - it omits the field → **yes anyway**. Advertising is optional (RFC 8414),
 *     plenty of PKCE-capable issuers stay silent, and an unknown authorization
 *     parameter is ignored per OAuth 2.0 §3.1, so sending it is harmless where
 *     it isn't understood.
 *
 * Evaluated from the SAME cached discovery document on both legs, so initiate
 * and exchange agree; an issuer that changes its advertisement mid-flow fails
 * the exchange closed and the user simply signs in again.
 */
function usePkce(discovery: DiscoveryDoc): boolean {
  const methods = discovery.code_challenge_methods_supported;
  if (!Array.isArray(methods) || methods.length === 0) return true;
  return methods.includes(PKCE_METHOD_S256);
}

/** An authorization request: where to send the browser, and the PKCE verifier
 *  the caller must store with the pending state and hand back at exchange. */
export interface OidcAuthorizeRequest {
  url: string;
  /** Absent only for an issuer that advertises PKCE without `S256`. */
  codeVerifier?: string;
}

/**
 * Build the IdP authorization-code redirect URL for an org's IdP, along with the
 * `state` + `nonce` the caller must remember to bind the callback, and the PKCE
 * `code_verifier` it must store alongside them. Discovery is resolved (and
 * cached) here so an unreachable IdP fails at initiate time.
 *
 * The verifier NEVER leaves the server: only its S256 challenge goes into the
 * redirect. Store it with the single-use pending state so it dies with it.
 */
export async function buildAuthorizeUrl(
  cfg: OidcLoginConfig,
  state: string,
  nonce: string,
  opts: { reauth?: boolean } = {},
): Promise<OidcAuthorizeRequest> {
  const discovery = await fetchDiscovery(discoveryUrlFor(cfg));
  const codeVerifier = usePkce(discovery) ? createCodeVerifier() : undefined;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: ssoCallbackUrl(cfg.orgId),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    ...(codeVerifier ? pkceAuthorizeParams(codeVerifier) : {}),
    ...(opts.reauth ? ssoReauthParams(cfg.provider) : {}),
  });
  return { url: `${discovery.authorization_endpoint}?${params}`, ...(codeVerifier && { codeVerifier }) };
}

/**
 * Exchange an authorization `code` for tokens and return the provider-VERIFIED
 * identity from a JWKS-validated `id_token`. This is the ONLY trustworthy
 * source of an SSO identity — the caller must never trust a client-supplied
 * profile. Throws typed errors from {@link OIDC_ERROR_MAP}.
 *
 * @param expectedNonce the nonce minted at initiate, bound to the state.
 * @param opts.codeVerifier the PKCE verifier stored with that state. REQUIRED
 *   whenever this issuer takes PKCE — a flow that started with a challenge can
 *   never be redeemed without its verifier, and a state minted before PKCE
 *   shipped (or one carrying somebody else's verifier) fails here rather than
 *   quietly exchanging unprotected.
 */
export async function exchangeAndValidate(
  cfg: OidcLoginConfig,
  code: string,
  expectedNonce: string,
  opts: { codeVerifier?: string } = {},
): Promise<OidcIdentity> {
  const discovery = await fetchDiscovery(discoveryUrlFor(cfg));
  // An admin-run discovery document can claim any issuer; only the `google`
  // provider (hard-coded discovery) may present Google's.
  if (cfg.provider !== 'google' && isReservedIssuer(discovery.issuer)) throw new Error('OIDC_PROVIDER_UNSUPPORTED');

  // No silent downgrade: if the challenge went out, the verifier must come back.
  const pkce = usePkce(discovery);
  if (pkce && !opts.codeVerifier) throw new Error('OIDC_INVALID_STATE');

  // 1. Authorization-code → token exchange (confidential client, secret in body).
  //    token_endpoint comes from the admin-supplied discovery doc, so it goes
  //    through the pinned, redirect-refusing safeFetch — a secret-bearing POST
  //    must never reach an internal/metadata host, nor follow a 3xx to one.
  let tokenRes: SafeFetchResponse;
  try {
    tokenRes = await safeFetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: ssoCallbackUrl(cfg.orgId),
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        // The IdP re-derives the challenge from this and compares: a code
        // redeemed with the wrong (or a replayed) verifier is refused there,
        // surfacing here as OIDC_TOKEN_EXCHANGE_FAILED.
        ...(pkce && opts.codeVerifier ? { code_verifier: opts.codeVerifier } : {}),
      }).toString(),
    });
  } catch (err) {
    logger.warn('OIDC token exchange request failed', { orgId: cfg.orgId, error: errorMessage(err) });
    throw new Error('OIDC_TOKEN_EXCHANGE_FAILED');
  }
  let tokenBody: { id_token?: string } = {};
  try { tokenBody = tokenRes.json(); } catch { /* non-JSON body → treated as a failed exchange below */ }
  if (!tokenRes.ok || tokenRes.redirected || !tokenBody.id_token) throw new Error('OIDC_TOKEN_EXCHANGE_FAILED');

  // 2. Validate the id_token: alg allow-list → JWKS signature → iss/aud/exp → nonce.
  const decoded = jwt.decode(tokenBody.id_token, { complete: true });
  if (!decoded || typeof decoded === 'string') throw new Error('OIDC_INVALID_ID_TOKEN');
  const alg = decoded.header.alg;
  if (!ALLOWED_ID_TOKEN_ALGS.has(alg)) throw new Error('OIDC_INVALID_ID_TOKEN');

  const pem = await resolveSigningKey(discovery.jwks_uri, decoded.header.kid);

  let claims: IdTokenClaims;
  try {
    claims = jwt.verify(tokenBody.id_token, pem, {
      algorithms: [alg as jwt.Algorithm],
      issuer: discovery.issuer,
      audience: cfg.clientId,
    }) as IdTokenClaims;
  } catch (err) {
    logger.warn('OIDC id_token verification failed', { orgId: cfg.orgId, error: errorMessage(err) });
    throw new Error('OIDC_INVALID_ID_TOKEN');
  }

  // 3. Bind the token to THIS login attempt — a replayed token from another
  //    flow carries a different nonce.
  if (!claims.nonce || claims.nonce !== expectedNonce) throw new Error('OIDC_INVALID_ID_TOKEN');

  // 4. Only a verified email may map to / link a local account (mirrors the
  //    OAuth path's verified-email requirement — an unverified address is an
  //    account-takeover surface).
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  if (!claims.email || !emailVerified) throw new Error('OIDC_NO_EMAIL');
  if (!claims.sub) throw new Error('OIDC_INVALID_ID_TOKEN');

  const email = claims.email.toLowerCase();

  // 5. Enforce the org's `allowedEmailDomains` (when configured). The IdP may
  //    authenticate identities OUTSIDE the org's domains — a broad `google`
  //    config, or a shared corporate Okta/Cognito pool — so the pinned domain
  //    list is the control that keeps a foreign (e.g. `@gmail.com` or
  //    `@evil-contractor.com`) identity from federating into this org. Empty
  //    list = no restriction (the documented default). Without this the field
  //    the model advertises as an access control would be inert.
  if (cfg.allowedEmailDomains.length > 0) {
    const domain = email.split('@').pop() ?? '';
    const allowed = cfg.allowedEmailDomains.map(d => d.toLowerCase().trim().replace(/^@/, ''));
    if (!domain || !allowed.includes(domain)) throw new Error('OIDC_EMAIL_DOMAIN_NOT_ALLOWED');
  }

  // 6. Groups for JIT Role mapping (3a). Read from the org's configured claim
  //    name off the SAME verified claim set — never from the userinfo endpoint or
  //    anything else the client could influence. A missing/odd-shaped claim
  //    yields no groups, which maps to no Roles (never to a default grant).
  const groups = extractGroupClaim(claims as unknown as Record<string, unknown>, cfg.groupsClaim);

  return {
    subject: claims.sub,
    issuer: discovery.issuer,
    email,
    name: claims.name,
    groups,
    ...(typeof claims.auth_time === 'number' && { authTime: claims.auth_time }),
  };
}
