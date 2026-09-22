// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * nOAuth mitigation: the Microsoft OAuth handler must REFUSE the shared
 * `common`/`organizations`/`consumers` tenants, because their `email` claim is a
 * user-mutable, unverifiable directory attribute — an attacker who brings their
 * own Azure AD tenant could set it to a victim's address and (since sign-in
 * account-links by email) take over the victim's account. Only a PINNED tenant
 * (directory GUID / verified domain) is trusted. This suite mocks `tenant:
 * 'common'` and asserts the handler throws before any account link.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const provider = (over: Record<string, unknown> = {}) => ({
  clientId: '',
  clientSecret: '',
  enabled: false,
  authorizeUrl: 'https://x.test/a',
  tokenUrl: 'https://x.test/t',
  userinfoUrl: 'https://x.test/u',
  ...over,
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
  sendError: (res: any, status: number, msg: string) => { res.status(status).json({ success: false, message: msg }); return res; },
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json(data); return res; },
}));

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  oauth: {
    callbackBaseUrl: 'https://app.test',
    stateTtlMs: 600000,
    cleanupIntervalMs: 600000,
    google: provider(),
    github: provider(),
    facebook: provider(),
    // The one under test: enabled, but on the SHARED `common` tenant.
    microsoft: provider({
      clientId: 'ms',
      clientSecret: 's',
      enabled: true,
      tenant: 'common',
      authorizeUrl: 'https://login.microsoft.test/{tenant}/authorize',
      tokenUrl: 'https://login.microsoft.test/{tenant}/token',
      userinfoUrl: 'https://graph.microsoft.test/oidc/userinfo',
    }),
    gitlab: provider({ baseUrl: 'https://gitlab.test' }),
    linkedin: provider(),
  },
}));

jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { findOrCreateOAuthUser: jest.fn<AnyFn>() },
}));
// oauth.ts now imports rejectIfSsoEnforced (social-OAuth honors per-org SSO
// enforcement); mock it so the real sso-enforcement→models→audit-event chain
// (which reads config.audit at load) isn't pulled in. Mirrors the sibling oauth tests.
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ rejectIfSsoEnforced: async () => false }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn<AnyFn>() }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn<AnyFn>() }));
jest.unstable_mockModule('../src/services/session/membership-context.js', () => ({
  membershipForOrg: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/services/session/access-tokens.js', () => ({
  enforceOrgAssurance: async (_u: unknown, _m: unknown, a: unknown) => a,
  // Session-auth helpers the controllers now import (see utils/token.ts).
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  signApiKeyToken: jest.fn<AnyFn>(),
  signServiceAccountToken: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/services/session/refresh-sessions.js', () => ({
  hashRefreshToken: (t: string) => `h:${t}`,
  findRefreshSession: jest.fn(async () => undefined),
  issueTokens: jest.fn<AnyFn>(),
  renewSessionTokens: jest.fn<AnyFn>(),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({ oauthCallbackSchema: {}, validateBody: jest.fn<AnyFn>() }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

const { getAuthUrl } = await import('../src/controllers/oauth.js');
const { verifyOAuthCode } = await import('../src/services/oauth-providers.js');
const { OAUTH_MICROSOFT_TENANT_NOT_PINNED } = await import('../src/services/auth-errors.js');

/** The browser-binding cookie the last minted flow set (helpers/login-binding.ts). */
let bindingCookie = '';
function makeRes() {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  res.cookie = jest.fn((name: string, value: string) => { if (name === 'pb_login_binding') bindingCookie = value; return res; });
  res.clearCookie = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}
/** The request surface of the browser that started the flow (carries its binding cookie). */
const browser = () => ({ headers: { cookie: `pb_login_binding=${bindingCookie}` } });
async function mintState(p: string): Promise<string> {
  const res = makeRes();
  await (getAuthUrl as any)({ params: { provider: p } }, res);
  return (res.json as jest.Mock<AnyFn>).mock.calls[0][0].state as string;
}

const realFetch = global.fetch;
beforeEach(() => { jest.clearAllMocks(); });

describe('Microsoft OAuth nOAuth mitigation', () => {
  it('refuses the shared `common` tenant even when the IdP returns a well-formed email', async () => {
    const state = await mintState('microsoft');
    // Token exchange succeeds and userinfo returns an email — the handler must
    // STILL reject purely on the shared-tenant policy, before linking anything.
    global.fetch = jest.fn<AnyFn>()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: 'ms-1', email: 'victim@company.com' }) }) as any;

    await expect(verifyOAuthCode('microsoft', 'code', state, browser())).rejects.toThrow(OAUTH_MICROSOFT_TENANT_NOT_PINNED);
    global.fetch = realFetch;
  });
});
