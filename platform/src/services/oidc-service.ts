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
import { assertSafeUrl, createLogger, isRefusedRedirect, SSRF_FETCH_INIT } from '@pipeline-builder/api-core';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

const logger = createLogger('oidc-service');

/** Discovery/JWKS cache TTL. Kept short so IdP key rotation is picked up
 *  quickly; a `kid` miss also forces a live JWKS refetch regardless. */
const DOC_CACHE_TTL_MS = parseInt(process.env.OIDC_DOC_CACHE_TTL_MS || '3600000', 10); // 1h

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
  OIDC_DISCOVERY_FAILED: { status: 502, message: 'Could not load the identity provider configuration' },
  OIDC_INVALID_STATE: { status: 403, message: 'Invalid or expired SSO state' },
  OIDC_TOKEN_EXCHANGE_FAILED: { status: 502, message: 'Failed to exchange the authorization code' },
  OIDC_INVALID_ID_TOKEN: { status: 401, message: 'The identity provider returned an invalid token' },
  OIDC_NO_EMAIL: { status: 400, message: 'The identity provider did not return a verified email address' },
  OIDC_EMAIL_DOMAIN_NOT_ALLOWED: { status: 403, message: 'Your email domain is not permitted to sign in to this organization' },
} as const;

// Discovery + JWKS

interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
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

  let res: Response;
  try {
    // SSRF guard: `discoveryUrl` is admin-supplied, so an org-admin/superadmin
    // could otherwise point it at 169.254.169.254 or an internal service. Reject
    // non-https / private / loopback / link-local hosts, and pin redirects so the
    // fetch can't pivot to an unvalidated host.
    await assertSafeUrl(url);
    res = await fetch(url, { headers: { Accept: 'application/json' }, ...SSRF_FETCH_INIT });
  } catch (err) {
    logger.warn('OIDC discovery fetch failed', { url, error: err instanceof Error ? err.message : String(err) });
    throw new Error('OIDC_DISCOVERY_FAILED');
  }
  if (!res.ok || isRefusedRedirect(res)) throw new Error('OIDC_DISCOVERY_FAILED');
  const doc = await res.json() as Partial<DiscoveryDoc>;
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

  let res: Response;
  try {
    // The jwks_uri comes from the (admin-supplied) discovery document, so it is
    // equally untrusted — SSRF-guard it too.
    await assertSafeUrl(jwksUri);
    res = await fetch(jwksUri, { headers: { Accept: 'application/json' }, ...SSRF_FETCH_INIT });
  } catch (err) {
    logger.warn('OIDC JWKS fetch failed', { jwksUri, error: err instanceof Error ? err.message : String(err) });
    throw new Error('OIDC_DISCOVERY_FAILED');
  }
  if (!res.ok || isRefusedRedirect(res)) throw new Error('OIDC_DISCOVERY_FAILED');
  const body = await res.json() as { keys?: Jwk[] };
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
    logger.warn('OIDC JWK → public key conversion failed', { kid, error: err instanceof Error ? err.message : String(err) });
    throw new Error('OIDC_INVALID_ID_TOKEN');
  }
}

// Claim shape

/** The provider-VERIFIED identity extracted from a validated `id_token`. */
export interface OidcIdentity {
  /** IdP subject identifier (stable per-user within the IdP). */
  subject: string;
  email: string;
  name?: string;
}

interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  nonce?: string;
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
 *   - `google`       → the well-known Google issuer
 *   - `github`       → NOT an OpenID provider → OIDC_PROVIDER_UNSUPPORTED
 */
function discoveryUrlFor(cfg: OidcLoginConfig): string {
  if (cfg.provider === 'cognito') {
    if (!cfg.region || !cfg.userPoolId) throw new Error('OIDC_PROVIDER_UNSUPPORTED');
    // AWS Cognito's standard OIDC discovery document. The user-pool id is not an
    // AWS account id, so deriving/storing this leaks no account identifier.
    return `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}/.well-known/openid-configuration`;
  }
  if (cfg.discoveryUrl) return cfg.discoveryUrl;
  if (cfg.provider === 'google') return 'https://accounts.google.com/.well-known/openid-configuration';
  // generic-oidc always carries a discoveryUrl (schema-enforced); reaching here
  // means github (no id_token) or a malformed named-provider config.
  throw new Error('OIDC_PROVIDER_UNSUPPORTED');
}

/**
 * Build the IdP authorization-code redirect URL for an org's IdP, along with the
 * `state` + `nonce` the caller must remember to bind the callback. Discovery is
 * resolved (and cached) here so an unreachable IdP fails at initiate time.
 */
export async function buildAuthorizeUrl(
  cfg: OidcLoginConfig,
  state: string,
  nonce: string,
): Promise<string> {
  const discovery = await fetchDiscovery(discoveryUrlFor(cfg));
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: ssoCallbackUrl(cfg.orgId),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
  });
  return `${discovery.authorization_endpoint}?${params}`;
}

/**
 * Exchange an authorization `code` for tokens and return the provider-VERIFIED
 * identity from a JWKS-validated `id_token`. This is the ONLY trustworthy
 * source of an SSO identity — the caller must never trust a client-supplied
 * profile. Throws typed errors from {@link OIDC_ERROR_MAP}.
 *
 * @param expectedNonce the nonce minted at initiate, bound to the state.
 */
export async function exchangeAndValidate(
  cfg: OidcLoginConfig,
  code: string,
  expectedNonce: string,
): Promise<OidcIdentity> {
  const discovery = await fetchDiscovery(discoveryUrlFor(cfg));

  // 1. Authorization-code → token exchange (confidential client, secret in body).
  //    token_endpoint comes from the admin-supplied discovery doc, so SSRF-guard
  //    it (blocks pointing the secret-bearing POST at an internal/metadata host)
  //    and pin redirects.
  let tokenRes: Response;
  try {
    await assertSafeUrl(discovery.token_endpoint);
    tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: ssoCallbackUrl(cfg.orgId),
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
      ...SSRF_FETCH_INIT,
    });
  } catch (err) {
    logger.warn('OIDC token exchange request failed', { orgId: cfg.orgId, error: err instanceof Error ? err.message : String(err) });
    throw new Error('OIDC_TOKEN_EXCHANGE_FAILED');
  }
  const tokenBody = await tokenRes.json().catch(() => ({})) as { id_token?: string };
  if (!tokenRes.ok || isRefusedRedirect(tokenRes) || !tokenBody.id_token) throw new Error('OIDC_TOKEN_EXCHANGE_FAILED');

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
    logger.warn('OIDC id_token verification failed', { orgId: cfg.orgId, error: err instanceof Error ? err.message : String(err) });
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

  return {
    subject: claims.sub,
    email,
    name: claims.name,
  };
}
