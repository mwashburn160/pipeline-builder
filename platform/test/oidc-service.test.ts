// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the OIDC enforcement engine (services/oidc-service.ts):
 *   - discovery + JWKS fetch (with caching)
 *   - buildAuthorizeUrl parameters, including the PKCE challenge
 *   - exchangeAndValidate happy path (JWKS-signature-validated id_token)
 *   - tampered id_token / wrong-key / nonce-mismatch / alg-confusion rejection
 *   - PKCE: S256 challenge derivation, the verifier on the exchange, the
 *     no-verifier refusal, and an issuer that advertises no S256
 *
 * Uses REAL `jsonwebtoken` + Node `crypto` (a locally-generated RSA keypair
 * feeds a served JWKS); only the outbound transport (`safeFetch`) and platform
 * config are stubbed, so the signature path is exercised for real rather than
 * mocked.
 */

import crypto from 'crypto';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

// oidc-service now performs its outbound calls through api-core's SSRF-safe
// `safeFetch` (resolve → PIN the vetted IP → refuse redirects) rather than the
// global `fetch`, so that is what the suite stubs.
const mockSafeFetch = jest.fn<(url: string, opts?: Record<string, unknown>) => Promise<unknown>>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  safeFetch: (url: string, opts?: Record<string, unknown>) => mockSafeFetch(url, opts),
}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ oauth: { callbackBaseUrl: 'https://app.test', oidcDocCacheTtlMs: 3_600_000 } }));

const {
  buildAuthorizeUrl,
  ssoReauthRequiresAuthTime,
  exchangeAndValidate,
  ssoCallbackUrl,
  __resetOidcCaches,
} = await import('../src/services/oidc-service.js');

// RSA keypair backing the served JWKS + a SECOND (attacker) keypair whose
// signatures must be rejected.
const good = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const goodJwk = { ...good.publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'RS256', use: 'sig' };
const goodPem = good.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const evilPem = evil.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

const DISCOVERY = {
  issuer: 'https://idp.test',
  authorization_endpoint: 'https://idp.test/authorize',
  token_endpoint: 'https://idp.test/token',
  jwks_uri: 'https://idp.test/jwks',
};

const cfg = {
  orgId: 'org-1',
  provider: 'generic-oidc',
  clientId: 'client-1',
  clientSecret: 'top-secret',
  discoveryUrl: 'https://idp.test/.well-known/openid-configuration',
  allowedEmailDomains: ['acme.com'],
};

/** Stand-in for the verifier the initiate leg would have stored with the state. */
const VERIFIER = 'RGiJ0Zf3s_test_code_verifier_43_chars_long_x';

/** exchangeAndValidate with the PKCE verifier the flow would carry. */
function exchange(c: typeof cfg & { groupsClaim?: string }, code: string, nonce: string) {
  return exchangeAndValidate(c, code, nonce, { codeVerifier: VERIFIER });
}

/** A `SafeFetchResponse` double. Note `json()` is SYNCHRONOUS on that shape
 *  (the body is already buffered under the transport's size cap), unlike the
 *  `Response.json()` promise of a global `fetch`. */
function okJson(body: unknown) {
  return { ok: true, status: 200, redirected: false, headers: {}, body: Buffer.alloc(0), text: () => JSON.stringify(body), json: () => body };
}
/** A non-2xx `SafeFetchResponse` double. */
function errJson(status: number, body: unknown = {}) {
  return { ok: false, status, redirected: false, headers: {}, body: Buffer.alloc(0), text: () => JSON.stringify(body), json: () => body };
}

/** Sign an id_token with the given private key; claims spread over sane defaults. */
function signIdToken(pem: string, claims: Record<string, unknown> = {}, opts: jwt.SignOptions = {}) {
  const payload = {
    iss: 'https://idp.test',
    aud: 'client-1',
    sub: 'idp-user-1',
    email: 'user@acme.com',
    email_verified: true,
    name: 'Test User',
    nonce: 'nonce-1',
    ...claims,
  };
  return jwt.sign(payload, pem, { algorithm: 'RS256', keyid: 'kid-1', expiresIn: '5m', ...opts });
}

/** Route fetch by URL so cache behavior (not call order) drives the stub. */
function stubFetch(idToken?: string, over: { tokenOk?: boolean; jwksKeys?: unknown[] } = {}) {
  const fn = jest.fn(async (url: unknown, _init?: unknown) => {
    const u = String(url);
    if (u.endsWith('/.well-known/openid-configuration')) return okJson(DISCOVERY);
    if (u === DISCOVERY.jwks_uri) return okJson({ keys: over.jwksKeys ?? [goodJwk] });
    if (u === DISCOVERY.token_endpoint) {
      if (over.tokenOk === false) return errJson(400, { error: 'invalid_grant' });
      return okJson({ id_token: idToken, access_token: 'at' });
    }
    return errJson(404);
  });
  mockSafeFetch.mockImplementation(fn);
  return fn;
}

/** `stubFetch` with discovery-document overrides (PKCE advertisement). */
function stubDiscovery(over: Partial<typeof DISCOVERY> & { code_challenge_methods_supported?: string[] }, idToken?: string) {
  const doc = { ...DISCOVERY, ...over };
  const fn = jest.fn(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/.well-known/openid-configuration')) return okJson(doc);
    if (u === DISCOVERY.jwks_uri) return okJson({ keys: [goodJwk] });
    if (u === DISCOVERY.token_endpoint) return okJson({ id_token: idToken, access_token: 'at' });
    return errJson(404);
  });
  mockSafeFetch.mockImplementation(fn);
  return fn;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeFetch.mockReset();
  __resetOidcCaches();
});

describe('ssoCallbackUrl', () => {
  it('derives a per-org callback URL from the callback base', () => {
    expect(ssoCallbackUrl('org-9')).toBe('https://app.test/auth/sso/org-9/callback');
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds an authorize redirect with client_id, redirect_uri, nonce, state', async () => {
    stubFetch();
    const { url } = await buildAuthorizeUrl(cfg, 'state-1', 'nonce-1');
    expect(url.startsWith('https://idp.test/authorize?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('client_id')).toBe('client-1');
    expect(q.get('redirect_uri')).toBe('https://app.test/auth/sso/org-1/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('state')).toBe('state-1');
    expect(q.get('nonce')).toBe('nonce-1');
  });

  it('forces a fresh sign-in for a step-up re-auth (prompt=login + max_age=0)', async () => {
    stubFetch();
    const q = new URL((await buildAuthorizeUrl(cfg, 's1', 'n1', { reauth: true })).url).searchParams;
    expect(q.get('prompt')).toBe('login');
    expect(q.get('max_age')).toBe('0');
  });

  it('uses the account picker for a Google IdP, which rejects prompt=login', async () => {
    stubFetch();
    const q = new URL((await buildAuthorizeUrl({ ...cfg, provider: 'google', discoveryUrl: '' }, 's1', 'n1', { reauth: true })).url).searchParams;
    expect(q.get('prompt')).toBe('select_account');
    expect(ssoReauthRequiresAuthTime('google')).toBe(false);
    expect(ssoReauthRequiresAuthTime('generic-oidc')).toBe(true);
  });

  it('resolves a Google IdP ONLY from the hard-coded Google discovery document', async () => {
    const fn = stubFetch();
    await buildAuthorizeUrl({ ...cfg, provider: 'google', discoveryUrl: '' }, 's1', 'n1');
    expect(String(fn.mock.calls[0][0])).toBe('https://accounts.google.com/.well-known/openid-configuration');
  });

  it('REFUSES a custom discoveryUrl on the google provider', async () => {
    stubFetch();
    await expect(buildAuthorizeUrl({ ...cfg, provider: 'google' }, 's1', 'n1')).rejects.toThrow('OIDC_PROVIDER_UNSUPPORTED');
  });

  it('REFUSES a generic OIDC discovery URL on Google\'s host', async () => {
    stubFetch();
    await expect(buildAuthorizeUrl({ ...cfg, discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration' }, 's1', 'n1'))
      .rejects.toThrow('OIDC_PROVIDER_UNSUPPORTED');
  });

  it('caches the discovery document (one fetch across two initiates)', async () => {
    const fn = stubFetch();
    await buildAuthorizeUrl(cfg, 's1', 'n1');
    await buildAuthorizeUrl(cfg, 's2', 'n2');
    const discoveryCalls = fn.mock.calls.filter(c => String(c[0]).endsWith('/.well-known/openid-configuration'));
    expect(discoveryCalls.length).toBe(1);
  });
});

describe('exchangeAndValidate', () => {
  it('returns the verified identity for a well-signed id_token', async () => {
    stubFetch(signIdToken(goodPem));
    const identity = await exchange(cfg, 'auth-code', 'nonce-1');
    expect(identity).toEqual({
      subject: 'idp-user-1', issuer: 'https://idp.test', email: 'user@acme.com', name: 'Test User', groups: [],
    });
  });

  it('surfaces auth_time so step-up re-auth can check recency', async () => {
    stubFetch(signIdToken(goodPem, { auth_time: 1_700_000_042 }));
    const identity = await exchange(cfg, 'auth-code', 'nonce-1');
    expect(identity.authTime).toBe(1_700_000_042);
  });

  it('REFUSES a generic OIDC discovery document that claims Google\'s issuer', async () => {
    stubDiscovery({ issuer: 'https://accounts.google.com' }, signIdToken(goodPem, { iss: 'https://accounts.google.com' }));
    await expect(exchange(cfg, 'auth-code', 'nonce-1')).rejects.toThrow('OIDC_PROVIDER_UNSUPPORTED');
  });

  it('lowercases the email claim', async () => {
    stubFetch(signIdToken(goodPem, { email: 'User@ACME.com' }));
    const identity = await exchange(cfg, 'c', 'nonce-1');
    expect(identity.email).toBe('user@acme.com');
  });

  it('REJECTS an id_token signed by a different (attacker) key', async () => {
    stubFetch(signIdToken(evilPem));
    await expect(exchange(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_INVALID_ID_TOKEN');
  });

  it('REJECTS a token whose payload was tampered after signing', async () => {
    const token = signIdToken(goodPem);
    const [h, , s] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({
      iss: 'https://idp.test',
      aud: 'client-1',
      sub: 'attacker',
      email: 'attacker@acme.com',
      email_verified: true,
      nonce: 'nonce-1',
      exp: Math.floor(Date.now() / 1000) + 300,
    })).toString('base64url');
    await expect(exchange(cfg, 'c', 'nonce-1')).rejects.toThrow(); // sanity: uses stub below
    stubFetch(`${h}.${forgedPayload}.${s}`);
    await expect(exchange(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_INVALID_ID_TOKEN');
  });

  it('REJECTS a nonce mismatch (replay from another flow)', async () => {
    stubFetch(signIdToken(goodPem, { nonce: 'other-nonce' }));
    await expect(exchange(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_INVALID_ID_TOKEN');
  });

  it('REJECTS a wrong audience', async () => {
    stubFetch(signIdToken(goodPem, { aud: 'someone-else' }));
    await expect(exchange(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_INVALID_ID_TOKEN');
  });

  it('REJECTS an unsigned (alg:none) token before any verification', async () => {
    const noneToken = jwt.sign(
      { iss: 'https://idp.test', aud: 'client-1', sub: 's', email: 'user@acme.com', email_verified: true, nonce: 'nonce-1' },
      '', { algorithm: 'none' },
    );
    stubFetch(noneToken);
    await expect(exchange(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_INVALID_ID_TOKEN');
  });

  it('REJECTS when the email is unverified (account-takeover guard)', async () => {
    stubFetch(signIdToken(goodPem, { email_verified: false }));
    await expect(exchange(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_NO_EMAIL');
  });

  it('REJECTS a verified email whose domain is not in allowedEmailDomains', async () => {
    // cfg pins allowedEmailDomains:['acme.com']; a broad/shared IdP can still
    // authenticate a foreign identity, so the domain gate must reject it.
    stubFetch(signIdToken(goodPem, { email: 'attacker@evil-contractor.com' }));
    await expect(exchange(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_ALLOWED');
  });

  it('maps a failed token exchange to OIDC_TOKEN_EXCHANGE_FAILED', async () => {
    stubFetch(signIdToken(goodPem), { tokenOk: false });
    await expect(exchange(cfg, 'bad', 'nonce-1')).rejects.toThrow('OIDC_TOKEN_EXCHANGE_FAILED');
  });

  it('reads the groups claim for JIT mapping, under the org\'s configured name', async () => {
    stubFetch(signIdToken(goodPem, { 'cognito:groups': ['Engineering', 'SRE'] }));
    const identity = await exchange({ ...cfg, groupsClaim: 'cognito:groups' }, 'c', 'nonce-1');
    expect(identity.groups).toEqual(['Engineering', 'SRE']);
  });
});

// PKCE (RFC 7636)

/** The S256 challenge for a verifier, computed independently of the helper. */
function expectedChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

describe('PKCE', () => {
  it('sends an S256 challenge derived from a verifier it keeps server-side', async () => {
    stubFetch();
    const { url, codeVerifier } = await buildAuthorizeUrl(cfg, 's1', 'n1');
    const q = new URL(url).searchParams;

    expect(codeVerifier).toBeDefined();
    // RFC 7636 §4.1: 43-128 chars from the unreserved set.
    expect(codeVerifier!).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBe(expectedChallenge(codeVerifier!));
    // The verifier itself must NEVER be in the redirect.
    expect(url).not.toContain(codeVerifier!);
  });

  it('mints a DIFFERENT verifier for every authorization request', async () => {
    stubFetch();
    const a = await buildAuthorizeUrl(cfg, 's1', 'n1');
    const b = await buildAuthorizeUrl(cfg, 's2', 'n2');
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it('sends the verifier on the token exchange', async () => {
    const fn = stubFetch(signIdToken(goodPem));
    await exchange(cfg, 'auth-code', 'nonce-1');
    const tokenCall = fn.mock.calls.find((c) => String(c[0]) === DISCOVERY.token_endpoint)!;
    const body = new URLSearchParams(String((tokenCall[1] as { body: string }).body));
    expect(body.get('code_verifier')).toBe(VERIFIER);
  });

  it('REFUSES to exchange without a verifier once the issuer takes PKCE', async () => {
    stubFetch(signIdToken(goodPem));
    // A state minted before PKCE shipped, or a forged callback with no stored
    // verifier: no silent downgrade to an unprotected exchange.
    await expect(exchangeAndValidate(cfg, 'auth-code', 'nonce-1')).rejects.toThrow('OIDC_INVALID_STATE');
  });

  it('surfaces the IdP\'s rejection of a MISMATCHED verifier as a failed exchange', async () => {
    // The IdP re-derives the challenge and refuses a code redeemed with the
    // wrong verifier — an invalid_grant, which maps to OIDC_TOKEN_EXCHANGE_FAILED.
    stubFetch(signIdToken(goodPem), { tokenOk: false });
    await expect(exchangeAndValidate(cfg, 'auth-code', 'nonce-1', { codeVerifier: 'someone-elses-verifier' }))
      .rejects.toThrow('OIDC_TOKEN_EXCHANGE_FAILED');
  });

  it('sends S256 when the discovery document advertises it', async () => {
    stubDiscovery({ code_challenge_methods_supported: ['S256', 'plain'] });
    const { url, codeVerifier } = await buildAuthorizeUrl(cfg, 's1', 'n1');
    expect(codeVerifier).toBeDefined();
    expect(new URL(url).searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('sends S256 when the discovery document omits the field entirely', async () => {
    stubDiscovery({}); // no code_challenge_methods_supported — the common case
    const { url, codeVerifier } = await buildAuthorizeUrl(cfg, 's1', 'n1');
    expect(codeVerifier).toBeDefined();
    expect(new URL(url).searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('NEVER falls back to plain: an issuer advertising only plain gets no PKCE', async () => {
    stubDiscovery({ code_challenge_methods_supported: ['plain'] });
    const { url, codeVerifier } = await buildAuthorizeUrl(cfg, 's1', 'n1');
    expect(codeVerifier).toBeUndefined();
    const q = new URL(url).searchParams;
    expect(q.get('code_challenge')).toBeNull();
    expect(q.get('code_challenge_method')).toBeNull();
  });

  it('exchanges WITHOUT a verifier for an issuer that advertises only plain', async () => {
    stubDiscovery({ code_challenge_methods_supported: ['plain'] }, signIdToken(goodPem));
    const identity = await exchangeAndValidate(cfg, 'c', 'nonce-1');
    expect(identity.subject).toBe('idp-user-1');
  });
});
