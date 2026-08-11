// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the GitHub OAuth verified-email guarantee in controllers/oauth.ts.
 *
 * The GitHub `fetchUserInfo` must NEVER trust the plain `/user` profile email
 * (GitHub returns it even when unverified). Instead it resolves the email
 * exclusively from `/user/emails`, requiring a `verified: true` entry and
 * preferring the `primary` one. Because downstream `findOrCreateOAuthUser`
 * auto-links the email onto a pre-existing local account, an unverified email
 * would be an account-takeover surface — so a login with no verified email must
 * fail cleanly (no link/create), mirroring the Google path.
 *
 * GitHub is enabled here (unlike oauth-verify.test.ts, which keeps it disabled
 * to exercise OAUTH_PROVIDER_DISABLED). `fetch` is stubbed so the token
 * exchange + `/user` + `/user/emails` calls are deterministic.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
        clientId: 'gh-client',
        clientSecret: 'gh-secret',
        enabled: true,
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

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));

jest.unstable_mockModule('../src/utils/token.js', () => ({
  signPersonalAccessToken: jest.fn(),
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  oauthCallbackSchema: {},
  validateBody: (_schema: unknown, body: any, res: any) => {
    if (body?.code && body?.state) return body;
    res.status(400).json({ success: false, message: 'VALIDATION_ERROR' });
    return null;
  },
}));

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

const { verifyOAuthCode, handleCallback, getAuthUrl } =
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

/**
 * Stub the three GitHub round-trips in order: token exchange, `/user` profile,
 * then `/user/emails`.
 */
function stubGitHubFetch(profile: unknown, emails: unknown) {
  global.fetch = jest.fn()
    .mockResolvedValueOnce(okJson({ access_token: 'gh-tok' }))
    .mockResolvedValueOnce(okJson(profile))
    .mockResolvedValueOnce(okJson(emails)) as any;
}

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  mockIssueTokens.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
});
afterEach(() => { global.fetch = realFetch; });

describe('GitHub verifyOAuthCode verified-email resolution', () => {
  it('ignores an UNVERIFIED profile email and links to the verified+primary /user/emails entry', async () => {
    const state = await mintState('github');
    // The profile carries an attacker-controllable unverified address; it must
    // be ignored in favour of the verified primary from /user/emails.
    stubGitHubFetch(
      { id: 555, email: 'attacker@evil.test', name: 'GH User', avatar_url: 'https://a/x.png' },
      [
        { email: 'attacker@evil.test', primary: false, verified: false },
        { email: 'real@verified.test', primary: true, verified: true },
      ],
    );

    const identity = await verifyOAuthCode('github', 'auth-code', state);
    expect(identity).toMatchObject({ id: '555', email: 'real@verified.test' });
    // The unverified profile email is never surfaced downstream.
    expect(identity.email).not.toBe('attacker@evil.test');
  });

  it('prefers a verified+primary address over a verified-but-non-primary one', async () => {
    const state = await mintState('github');
    stubGitHubFetch(
      { id: 42, email: null },
      [
        { email: 'secondary@verified.test', primary: false, verified: true },
        { email: 'primary@verified.test', primary: true, verified: true },
      ],
    );

    const identity = await verifyOAuthCode('github', 'auth-code', state);
    expect(identity.email).toBe('primary@verified.test');
  });

  it('falls back to any verified address when no primary-verified entry exists', async () => {
    const state = await mintState('github');
    stubGitHubFetch(
      { id: 7, email: null },
      [
        { email: 'unverified@x.test', primary: true, verified: false },
        { email: 'verified@x.test', primary: false, verified: true },
      ],
    );

    const identity = await verifyOAuthCode('github', 'auth-code', state);
    expect(identity.email).toBe('verified@x.test');
  });

  it('fails cleanly when NO verified email is available (no account link/create)', async () => {
    const state = await mintState('github');
    stubGitHubFetch(
      { id: 9, email: 'unverified@evil.test' },
      [
        { email: 'unverified@evil.test', primary: true, verified: false },
        { email: 'other@evil.test', primary: false, verified: false },
      ],
    );

    await expect(verifyOAuthCode('github', 'auth-code', state))
      .rejects.toThrow('GitHub did not return a verified email address');
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  it('handleCallback: an unverified-only GitHub login never links/creates a user', async () => {
    const state = await mintState('github');
    stubGitHubFetch(
      { id: 11, email: 'unverified@evil.test' },
      [{ email: 'unverified@evil.test', primary: true, verified: false }],
    );

    const res = makeRes();
    await (handleCallback as any)({ params: { provider: 'github' }, body: { code: 'c', state } }, res);

    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    // Recorded as a failed login, never a success.
    const failed = mockAudit.mock.calls.find((c) => c[1] === 'user.login.failed');
    expect(failed).toBeDefined();
    expect(failed![2]).toMatchObject({ outcome: 'failure', details: { provider: 'github', method: 'oauth' } });
    expect(mockAudit.mock.calls.some((c) => c[1] === 'user.login')).toBe(false);
    expect(mockIncCounter).toHaveBeenCalledWith('platform_logins_failed_total');
  });

  it('handleCallback: a verified-primary GitHub login links on the verified email and issues tokens', async () => {
    const state = await mintState('github');
    stubGitHubFetch(
      { id: 21, email: 'attacker@evil.test', name: 'GH' },
      [{ email: 'real@verified.test', primary: true, verified: true }],
    );
    mockFindOrCreate.mockResolvedValue({ _id: 'u1', lastActiveOrgId: { toString: () => 'org-1' } });

    const res = makeRes();
    await (handleCallback as any)({ params: { provider: 'github' }, body: { code: 'c', state } }, res);

    expect(mockFindOrCreate).toHaveBeenCalledWith('github', expect.objectContaining({ email: 'real@verified.test' }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockIncCounter).toHaveBeenCalledWith('platform_logins_total');
  });
});
