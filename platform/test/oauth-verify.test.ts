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

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindOrCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>();

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
    },
  },
}));

jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { findOrCreateOAuthUser: (...a: unknown[]) => mockFindOrCreate(...a) },
}));

jest.unstable_mockModule('../src/utils/token.js', () => ({
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
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
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_label: string, fn: Function, errorMap?: Record<string, { status: number; message: string }>) =>
    async (req: any, res: any) => {
      try { return await fn(req, res); } catch (e: any) {
        const mapped = errorMap?.[e?.message];
        if (mapped) return res.status(mapped.status).json({ success: false, message: mapped.message });
        return res.status(500).json({ success: false, message: e?.message });
      }
    },
}));

const { verifyOAuthCode, handleCallback, getAuthUrl, OAUTH_ERROR_MAP } =
  await import('../src/controllers/oauth.js');

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
});
afterEach(() => { global.fetch = realFetch; });

describe('verifyOAuthCode', () => {
  it('throws OAUTH_UNSUPPORTED_PROVIDER for an unknown provider', async () => {
    await expect(verifyOAuthCode('facebook', 'c', 's')).rejects.toThrow('OAUTH_UNSUPPORTED_PROVIDER');
  });

  it('throws OAUTH_PROVIDER_DISABLED for a configured-but-disabled provider', async () => {
    await expect(verifyOAuthCode('github', 'c', 's')).rejects.toThrow('OAUTH_PROVIDER_DISABLED');
  });

  it('throws OAUTH_INVALID_STATE for a state that was never minted', async () => {
    await expect(verifyOAuthCode('google', 'c', 'never-seen-state')).rejects.toThrow('OAUTH_INVALID_STATE');
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
    await expect(verifyOAuthCode('google', 'code', state)).rejects.toThrow('OAUTH_INVALID_STATE');
  });

  it('maps a failed code exchange to TOKEN_EXCHANGE_FAILED', async () => {
    const state = await mintState('google');
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'invalid_grant' }) }) as any;

    await expect(verifyOAuthCode('google', 'bad-code', state)).rejects.toThrow('TOKEN_EXCHANGE_FAILED');
  });
});

describe('handleCallback (OAUTH_ERROR_MAP wiring)', () => {
  it('maps an invalid/expired state to 403', async () => {
    const res = makeRes();
    await (handleCallback as any)({ params: { provider: 'google' }, body: { code: 'c', state: 'forged' } }, res);
    expect(res.status).toHaveBeenCalledWith(OAUTH_ERROR_MAP.OAUTH_INVALID_STATE.status);
    expect(res.status).toHaveBeenCalledWith(403);
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
  });
});
