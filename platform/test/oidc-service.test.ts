// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the OIDC enforcement engine (services/oidc-service.ts):
 *   - discovery + JWKS fetch (with caching)
 *   - buildAuthorizeUrl parameters
 *   - exchangeAndValidate happy path (JWKS-signature-validated id_token)
 *   - tampered id_token / wrong-key / nonce-mismatch / alg-confusion rejection
 *
 * Uses REAL `jsonwebtoken` + Node `crypto` (a locally-generated RSA keypair
 * feeds a served JWKS); only `fetch` and platform config are stubbed, so the
 * signature path is exercised for real rather than mocked.
 */

import crypto from 'crypto';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { oauth: { callbackBaseUrl: 'https://app.test' } },
}));

const {
  buildAuthorizeUrl,
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

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
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
  const fn = jest.fn(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/.well-known/openid-configuration')) return okJson(DISCOVERY);
    if (u === DISCOVERY.jwks_uri) return okJson({ keys: over.jwksKeys ?? [goodJwk] });
    if (u === DISCOVERY.token_endpoint) {
      if (over.tokenOk === false) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } as Response;
      return okJson({ id_token: idToken, access_token: 'at' });
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  __resetOidcCaches();
});
afterEach(() => { global.fetch = realFetch; });

describe('ssoCallbackUrl', () => {
  it('derives a per-org callback URL from the callback base', () => {
    expect(ssoCallbackUrl('org-9')).toBe('https://app.test/auth/sso/org-9/callback');
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds an authorize redirect with client_id, redirect_uri, nonce, state', async () => {
    stubFetch();
    const url = await buildAuthorizeUrl(cfg, 'state-1', 'nonce-1');
    expect(url.startsWith('https://idp.test/authorize?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('client_id')).toBe('client-1');
    expect(q.get('redirect_uri')).toBe('https://app.test/auth/sso/org-1/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('state')).toBe('state-1');
    expect(q.get('nonce')).toBe('nonce-1');
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
    const identity = await exchangeAndValidate(cfg, 'auth-code', 'nonce-1');
    expect(identity).toEqual({ subject: 'idp-user-1', email: 'user@acme.com', name: 'Test User' });
  });

  it('lowercases the email claim', async () => {
    stubFetch(signIdToken(goodPem, { email: 'User@ACME.com' }));
    const identity = await exchangeAndValidate(cfg, 'c', 'nonce-1');
    expect(identity.email).toBe('user@acme.com');
  });

  it('REJECTS an id_token signed by a different (attacker) key', async () => {
    stubFetch(signIdToken(evilPem));
    await expect(exchangeAndValidate(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_INVALID_ID_TOKEN');
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
    await expect(exchangeAndValidate(cfg, 'c', 'nonce-1')).rejects.toThrow(); // sanity: uses stub below
    stubFetch(`${h}.${forgedPayload}.${s}`);
    await expect(exchangeAndValidate(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_INVALID_ID_TOKEN');
  });

  it('REJECTS a nonce mismatch (replay from another flow)', async () => {
    stubFetch(signIdToken(goodPem, { nonce: 'other-nonce' }));
    await expect(exchangeAndValidate(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_INVALID_ID_TOKEN');
  });

  it('REJECTS a wrong audience', async () => {
    stubFetch(signIdToken(goodPem, { aud: 'someone-else' }));
    await expect(exchangeAndValidate(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_INVALID_ID_TOKEN');
  });

  it('REJECTS an unsigned (alg:none) token before any verification', async () => {
    const noneToken = jwt.sign(
      { iss: 'https://idp.test', aud: 'client-1', sub: 's', email: 'user@acme.com', email_verified: true, nonce: 'nonce-1' },
      '', { algorithm: 'none' },
    );
    stubFetch(noneToken);
    await expect(exchangeAndValidate(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_INVALID_ID_TOKEN');
  });

  it('REJECTS when the email is unverified (account-takeover guard)', async () => {
    stubFetch(signIdToken(goodPem, { email_verified: false }));
    await expect(exchangeAndValidate(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_NO_EMAIL');
  });

  it('REJECTS a verified email whose domain is not in allowedEmailDomains', async () => {
    // cfg pins allowedEmailDomains:['acme.com']; a broad/shared IdP can still
    // authenticate a foreign identity, so the domain gate must reject it.
    stubFetch(signIdToken(goodPem, { email: 'attacker@evil-contractor.com' }));
    await expect(exchangeAndValidate(cfg, 'c', 'nonce-1')).rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_ALLOWED');
  });

  it('maps a failed token exchange to OIDC_TOKEN_EXCHANGE_FAILED', async () => {
    stubFetch(signIdToken(goodPem), { tokenOk: false });
    await expect(exchangeAndValidate(cfg, 'bad', 'nonce-1')).rejects.toThrow('OIDC_TOKEN_EXCHANGE_FAILED');
  });
});
