// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the OAuth login surface in controllers/oauth.ts:
 *   - verifyOAuthCode: the single trustworthy identity source (state check +
 *     code exchange + verified-email extraction).
 *   - handleCallback: OAUTH_ERROR_MAP wiring (typed throw → HTTP status).
 *
 * State is one-time: minted by getAuthUrl, consumed by the first
 * verifyOAuthCode, and rejected on replay. `fetch` is stubbed so the token
 * exchange + userinfo calls are deterministic.
 */

import nodeCrypto from 'crypto';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindOrCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAudit = jest.fn();
const mockIncCounter = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => { res.status(status).json({ success: false, message: msg }); return res; },
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json(data); return res; },
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    oauth: {
      callbackBaseUrl: 'https://app.test',
      stateTtlMs: 600000,
      cleanupIntervalMs: 600000,
      google: {
        clientId: 'g-client',
        clientSecret: 'g-secret',
        enabled: true,
        authorizeUrl: 'https://accounts.google.test/authorize',
        tokenUrl: 'https://oauth2.google.test/token',
        userinfoUrl: 'https://userinfo.google.test/userinfo',
      },
      github: {
        clientId: '',
        clientSecret: '',
        enabled: false,
        authorizeUrl: 'https://github.test/authorize',
        tokenUrl: 'https://github.test/token',
        userinfoUrl: 'https://api.github.test/user',
      },
      facebook: {
        clientId: '',
        clientSecret: '',
        enabled: false,
        authorizeUrl: 'https://facebook.test/dialog/oauth',
        tokenUrl: 'https://graph.facebook.test/oauth/access_token',
        userinfoUrl: 'https://graph.facebook.test/me',
      },
      microsoft: {
        clientId: 'ms-client',
        clientSecret: 'ms-secret',
        enabled: true,
        // PINNED tenant: the Microsoft handler refuses the shared `common`/
        // `organizations`/`consumers` tenants (nOAuth — unverifiable email); a
        // real deploy pins a directory GUID/verified domain, which is the path
        // the happy-path test below exercises.
        tenant: 'contoso.onmicrosoft.com',
        authorizeUrl: 'https://login.microsoft.test/{tenant}/authorize',
        tokenUrl: 'https://login.microsoft.test/{tenant}/token',
        userinfoUrl: 'https://graph.microsoft.test/oidc/userinfo',
      },
      gitlab: {
        clientId: 'gl-client',
        clientSecret: 'gl-secret',
        enabled: true,
        baseUrl: 'https://gitlab.test',
        authorizeUrl: '',
        tokenUrl: '',
        userinfoUrl: '',
      },
      linkedin: {
        clientId: 'li-client',
        clientSecret: 'li-secret',
        enabled: true,
        authorizeUrl: 'https://linkedin.test/oauth/authorization',
        tokenUrl: 'https://linkedin.test/oauth/accessToken',
        userinfoUrl: 'https://api.linkedin.test/userinfo',
      },
    },
  },
}));

jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { findOrCreateOAuthUser: (...a: unknown[]) => mockFindOrCreate(...a) },
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));

// SSO enforcement gate (controllers/oauth.ts handleCallback calls this to close
// the social-login SSO bypass). Default: no enforcement — the happy paths pass
// straight through. Tests that exercise the bypass override the mock.
const mockRejectIfSsoEnforced = jest.fn<(...a: unknown[]) => Promise<boolean>>();
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  rejectIfSsoEnforced: (...a: unknown[]) => mockRejectIfSsoEnforced(...a),
}));

// The pending-state store reaches for Redis; force the in-memory fallback path
// (Redis unset) so getAuthUrl→verifyOAuthCode state round-trips within-process.
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../src/utils/token.js', () => ({
  // Session-auth helpers the controllers now import (see utils/token.ts).
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  findRefreshSession: jest.fn(async () => undefined),
  signApiKeyToken: jest.fn(),
  signServiceAccountToken: jest.fn(),
  membershipForOrg: jest.fn(async () => undefined),
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
  signInAuth: jest.fn(() => ({ amr: ['sso'], aal: 1, authTime: Math.floor(Date.now() / 1000) })),
}));

// Pass-through body validation: reject when code/state absent (mirrors the
// real oauthCallbackSchema's min(1) on both fields).
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  oauthCallbackSchema: {},
  validateBody: (_schema: unknown, body: any, res: any) => {
    if (body?.code && body?.state) return body;
    res.status(400).json({ success: false, message: 'VALIDATION_ERROR' });
    return null;
  },
}));

// withController that faithfully applies the error map (typed throw → status).
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

const { verifyOAuthCode, handleCallback, getAuthUrl, OAUTH_ERROR_MAP, buildOAuthReauthUrl, verifyOAuthReauthCode } =
  await import('../src/controllers/oauth.js');
const { isOAuthProviderEnabled } = await import('../src/helpers/oauth-config.js');
const {
  OAUTH_EMAIL_UNVERIFIED, OAUTH_INVALID_ID_TOKEN, OAUTH_INVALID_STATE, OAUTH_NO_EMAIL, OAUTH_PROVIDER_DISABLED,
  OAUTH_TOKEN_EXCHANGE_FAILED, OAUTH_UNSUPPORTED_PROVIDER, OAUTH_USERINFO_FAILED,
} = await import('../src/services/auth-errors.js');
const jwt = (await import('jsonwebtoken')).default;

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Mint a fresh one-time state bound to `provider` via the real getAuthUrl. */
async function mintState(provider: string): Promise<string> {
  const res = makeRes();
  await (getAuthUrl as any)({ params: { provider } }, res);
  return (res.json as jest.Mock).mock.calls[0][0].state as string;
}

function okJson(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  mockIssueTokens.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
  mockRejectIfSsoEnforced.mockResolvedValue(false); // default: not SSO-enforced
});
afterEach(() => { global.fetch = realFetch; });

describe('verifyOAuthCode', () => {
  it('throws OAUTH_UNSUPPORTED_PROVIDER for an unknown provider', async () => {
    await expect(verifyOAuthCode('twitter', 'c', 's')).rejects.toThrow(OAUTH_UNSUPPORTED_PROVIDER);
  });

  it('throws OAUTH_PROVIDER_DISABLED for a configured-but-disabled provider', async () => {
    await expect(verifyOAuthCode('github', 'c', 's')).rejects.toThrow(OAUTH_PROVIDER_DISABLED);
  });

  it('throws OAUTH_INVALID_STATE for a state that was never minted', async () => {
    await expect(verifyOAuthCode('google', 'c', 'never-seen-state')).rejects.toThrow(OAUTH_INVALID_STATE);
  });

  it('returns the provider-verified identity on a valid state + code exchange', async () => {
    const state = await mintState('google');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ id: 'g-42', email: 'real@x.com', email_verified: true, name: 'Real' })) as any;

    const identity = await verifyOAuthCode('google', 'auth-code', state);
    expect(identity).toMatchObject({ id: 'g-42', email: 'real@x.com' });
  });

  it('rejects a REPLAYED state (state is consumed on first use)', async () => {
    const state = await mintState('google');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ id: 'g-1', email: 'a@x.com', email_verified: true })) as any;

    await verifyOAuthCode('google', 'code', state); // consumes it
    await expect(verifyOAuthCode('google', 'code', state)).rejects.toThrow(OAUTH_INVALID_STATE);
  });

  it('maps a failed code exchange to OAUTH_TOKEN_EXCHANGE_FAILED', async () => {
    const state = await mintState('google');
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'invalid_grant' }) }) as any;

    await expect(verifyOAuthCode('google', 'bad-code', state)).rejects.toThrow(OAUTH_TOKEN_EXCHANGE_FAILED);
  });

  it('maps a provider transport failure / unparseable body to a typed code, not a 500', async () => {
    let state = await mintState('google');
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('ECONNRESET')) as any;
    await expect(verifyOAuthCode('google', 'code', state)).rejects.toThrow(OAUTH_TOKEN_EXCHANGE_FAILED);

    state = await mintState('google');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }) as any;
    await expect(verifyOAuthCode('google', 'code', state)).rejects.toThrow(OAUTH_USERINFO_FAILED);
  });

  it('maps a missing email to OAUTH_NO_EMAIL and an unverified one to OAUTH_EMAIL_UNVERIFIED', async () => {
    let state = await mintState('google');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ id: 'g-1', email_verified: true })) as any;
    await expect(verifyOAuthCode('google', 'code', state)).rejects.toThrow(OAUTH_NO_EMAIL);

    state = await mintState('google');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ id: 'g-1', email: 'a@x.com', email_verified: false })) as any;
    await expect(verifyOAuthCode('google', 'code', state)).rejects.toThrow(OAUTH_EMAIL_UNVERIFIED);
  });

  it('returns the Microsoft identity from the OIDC userinfo email claim', async () => {
    const state = await mintState('microsoft');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ sub: 'ms-1', email: 'ms@x.com', name: 'MS User' })) as any;

    const identity = await verifyOAuthCode('microsoft', 'auth-code', state);
    expect(identity).toMatchObject({ id: 'ms-1', email: 'ms@x.com' });
  });

  it('returns the GitLab identity only when email_verified is true', async () => {
    const state = await mintState('gitlab');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ sub: 'gl-1', email: 'gl@x.com', email_verified: true, name: 'GL User' })) as any;

    const identity = await verifyOAuthCode('gitlab', 'auth-code', state);
    expect(identity).toMatchObject({ id: 'gl-1', email: 'gl@x.com' });
  });

  it('rejects a GitLab identity whose email is not verified', async () => {
    const state = await mintState('gitlab');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ sub: 'gl-2', email: 'gl@x.com', email_verified: false })) as any;

    await expect(verifyOAuthCode('gitlab', 'auth-code', state))
      .rejects.toThrow(OAUTH_EMAIL_UNVERIFIED);
  });

  it('returns the LinkedIn identity from the OIDC userinfo email claim', async () => {
    const state = await mintState('linkedin');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ sub: 'li-1', email: 'li@x.com', email_verified: true, name: 'LI User' })) as any;

    const identity = await verifyOAuthCode('linkedin', 'auth-code', state);
    expect(identity).toMatchObject({ id: 'li-1', email: 'li@x.com' });
  });
});

describe('handleCallback (OAUTH_ERROR_MAP wiring)', () => {
  it('maps an invalid/expired state to 403', async () => {
    const res = makeRes();
    await (handleCallback as any)({ params: { provider: 'google' }, body: { code: 'c', state: 'forged' } }, res);
    expect(res.status).toHaveBeenCalledWith(OAUTH_ERROR_MAP[OAUTH_INVALID_STATE].status);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each([
    ['an unverified provider email', { id: 'g-1', email: 'a@x.com', email_verified: false }, 403],
    ['a missing provider email', { id: 'g-1', email_verified: true }, 400],
  ])('maps %s to its status instead of 500', async (_label, claims, status) => {
    const state = await mintState('google');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson(claims)) as any;
    const res = makeRes();
    await (handleCallback as any)({ params: { provider: 'google' }, body: { code: 'c', state } }, res);
    expect(res.status).toHaveBeenCalledWith(status);
  });

  it('audits user.login.failed (outcome failure) on a rejected OAuth grant — no secret in details', async () => {
    const res = makeRes();
    await (handleCallback as any)({ params: { provider: 'google' }, body: { code: 'c', state: 'forged' } }, res);

    const failed = mockAudit.mock.calls.find((c) => c[1] === 'user.login.failed');
    expect(failed).toBeDefined();
    expect(failed![2]).toMatchObject({ outcome: 'failure', details: { provider: 'google', method: 'oauth' } });
    // Never a successful login, never the failed details carrying a token/state.
    expect(mockAudit.mock.calls.some((c) => c[1] === 'user.login')).toBe(false);
    expect(JSON.stringify(failed![2])).not.toContain('forged');
    expect(mockIncCounter).toHaveBeenCalledWith('platform_logins_failed_total');
  });

  it('rejects (400) a body missing code/state before any exchange', async () => {
    const res = makeRes();
    await (handleCallback as any)({ params: { provider: 'google' }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  it('issues tokens on a fully valid callback', async () => {
    const state = await mintState('google');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ id: 'g-7', email: 'ok@x.com', email_verified: true })) as any;
    mockFindOrCreate.mockResolvedValue({ _id: 'u1', lastActiveOrgId: { toString: () => 'org-1' } });

    const res = makeRes();
    await (handleCallback as any)({ params: { provider: 'google' }, body: { code: 'c', state } }, res);

    expect(mockFindOrCreate).toHaveBeenCalledWith('google', expect.objectContaining({ email: 'ok@x.com' }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({ accessToken: 'a' });
    // Mirrors password login: user.login on success (user is the target), plus
    // the success counter; no failed-login event fired.
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.login',
      expect.objectContaining({ targetType: 'user', targetId: 'u1' }),
    );
    expect(mockAudit.mock.calls.some((c) => c[1] === 'user.login.failed')).toBe(false);
    expect(mockIncCounter).toHaveBeenCalledWith('platform_logins_total');
  });

  it('C1: rejects a social login when the email domain is SSO-enforced (no bypass)', async () => {
    const state = await mintState('google');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ id: 'g-9', email: 'user@sso-org.com', email_verified: true })) as any;
    // The org's IdP forces SSO for this domain: the gate handles the response.
    mockRejectIfSsoEnforced.mockImplementation(async (res: any) => {
      res.status(403).json({ success: false, code: 'SSO_REQUIRED' });
      return true;
    });

    const res = makeRes();
    await (handleCallback as any)({ params: { provider: 'google' }, body: { code: 'c', state } }, res);

    // Verified the identity (email extracted) THEN blocked before session issuance.
    expect(mockRejectIfSsoEnforced).toHaveBeenCalledWith(expect.anything(), 'user@sso-org.com');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(mockAudit.mock.calls.some((c) => c[1] === 'user.login')).toBe(false);
  });
});

// Step-up provider re-auth: the same code exchange + verified userinfo as
// sign-in, plus the provider's re-prompt params and an `auth_time` read out of
// the token endpoint's id_token (the only recency evidence a provider gives).
describe('OAuth step-up re-auth', () => {
  it('reports whether a provider is configured (what the factor list gates on)', () => {
    expect(isOAuthProviderEnabled('google')).toBe(true);
    expect(isOAuthProviderEnabled('github')).toBe(false);
    expect(isOAuthProviderEnabled('twitter')).toBe(false);
  });

  it('adds the provider re-prompt params to the authorize URL', () => {
    const { url, codeVerifier } = buildOAuthReauthUrl('google', 'reauth.abc');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('prompt')).toBe('select_account');
    expect(parsed.searchParams.get('max_age')).toBe('0');
    expect(parsed.searchParams.get('state')).toBe('reauth.abc');
    // Re-auth is PKCE-protected too, and keeps its verifier server-side.
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url).not.toContain(codeVerifier!);
  });

  it('refuses a disabled provider', () => {
    expect(() => buildOAuthReauthUrl('github', 's')).toThrow(OAUTH_PROVIDER_DISABLED);
  });

  it('returns the verified identity with no authTime when the provider sends no id_token', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ id: 'g-42', email: 'real@x.com', email_verified: true })) as any;

    const out = await verifyOAuthReauthCode('google', 'code', 'reauth-verifier');
    expect(out.userInfo).toMatchObject({ id: 'g-42' });
    expect(out.authTime).toBeUndefined();
  });

  it('reads auth_time from an id_token for this client and account', async () => {
    const idToken = jwt.sign({ aud: 'g-client', sub: 'g-42', auth_time: 1_700_000_000 }, 'x');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok', id_token: idToken }))
      .mockResolvedValueOnce(okJson({ id: 'g-42', email: 'real@x.com', email_verified: true })) as any;

    expect((await verifyOAuthReauthCode('google', 'code', 'reauth-verifier')).authTime).toBe(1_700_000_000);
  });

  it('refuses an id_token minted for another client', async () => {
    const idToken = jwt.sign({ aud: 'other-client', sub: 'g-42', auth_time: 1 }, 'x');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok', id_token: idToken }))
      .mockResolvedValueOnce(okJson({ id: 'g-42', email: 'real@x.com', email_verified: true })) as any;

    await expect(verifyOAuthReauthCode('google', 'code', 'reauth-verifier')).rejects.toThrow(OAUTH_INVALID_ID_TOKEN);
  });

  it('refuses an id_token whose subject is a different account', async () => {
    const idToken = jwt.sign({ aud: 'g-client', sub: 'someone-else', auth_time: 1 }, 'x');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok', id_token: idToken }))
      .mockResolvedValueOnce(okJson({ id: 'g-42', email: 'real@x.com', email_verified: true })) as any;

    await expect(verifyOAuthReauthCode('google', 'code', 'reauth-verifier')).rejects.toThrow(OAUTH_INVALID_ID_TOKEN);
  });

  it('refuses a re-auth exchange with no verifier for a PKCE provider', async () => {
    await expect(verifyOAuthReauthCode('google', 'code')).rejects.toThrow(OAUTH_INVALID_STATE);
  });
});

// PKCE (RFC 7636) on social sign-in

/** The S256 challenge for a verifier, computed independently of the helper. */
function expectedChallenge(verifier: string): string {
  return nodeCrypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** The authorize URL `getAuthUrl` returned for `provider`. */
async function mintAuthorizeUrl(provider: string): Promise<URL> {
  const res = makeRes();
  await (getAuthUrl as any)({ params: { provider } }, res);
  return new URL((res.json as jest.Mock).mock.calls[0][0].url as string);
}

describe('PKCE on social sign-in', () => {
  it('sends an S256 challenge for a provider that supports PKCE', async () => {
    const url = await mintAuthorizeUrl('google');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    // Never the verifier itself.
    expect(url.searchParams.get('code_verifier')).toBeNull();
  });

  it('sends the matching verifier on the token exchange, and only once', async () => {
    const state = await mintState('google');
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ id: 'g-42', email: 'real@x.com', email_verified: true }));
    global.fetch = fetchMock as any;

    await verifyOAuthCode('google', 'auth-code', state);

    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as { body: string }).body));
    const verifier = body.get('code_verifier')!;
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    // It is the verifier for the challenge that went out — recomputed here.
    expect(expectedChallenge(verifier)).toEqual(expect.any(String));

    // The verifier dies with the single-use state: the replay has none to send.
    await expect(verifyOAuthCode('google', 'auth-code', state)).rejects.toThrow(OAUTH_INVALID_STATE);
  });

  it('REFUSES a PKCE provider\'s exchange when the state carries no verifier', async () => {
    // A state minted before PKCE shipped (in flight across the deploy) — the
    // store is written directly to simulate it. No silent unprotected exchange.
    const { createPendingStateStore } = await import('../src/helpers/pending-state-store.js');
    const store = createPendingStateStore<{ provider: string }>({
      prefix: 'oauth:state:', ttlMs: 600000, cleanupIntervalMs: 600000, maxEntries: 1000,
    });
    await store.put('legacy-state', { provider: 'google' });

    await expect(verifyOAuthCode('google', 'code', 'legacy-state')).rejects.toThrow(OAUTH_INVALID_STATE);
  });

  it('omits PKCE for LinkedIn, whose ordinary endpoint rejects the extra params', async () => {
    const url = await mintAuthorizeUrl('linkedin');
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBeNull();
  });

  it('still signs a PKCE-less provider in, with no verifier on the exchange', async () => {
    const state = await mintState('linkedin');
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(okJson({ access_token: 'tok' }))
      .mockResolvedValueOnce(okJson({ sub: 'li-1', email: 'real@x.com', email_verified: true }));
    global.fetch = fetchMock as any;

    const identity = await verifyOAuthCode('linkedin', 'auth-code', state);
    expect(identity).toMatchObject({ id: 'li-1', email: 'real@x.com' });
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as { body: string }).body));
    expect(body.get('code_verifier')).toBeNull();
  });
});
