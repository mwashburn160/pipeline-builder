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

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
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
  },
}));

jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { findOrCreateOAuthUser: jest.fn() },
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/utils/token.js', () => ({ signPersonalAccessToken: jest.fn(), issueTokens: jest.fn() }));
jest.unstable_mockModule('../src/utils/validation.js', () => ({ oauthCallbackSchema: {}, validateBody: jest.fn() }));
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

const { verifyOAuthCode, getAuthUrl } = await import('../src/controllers/oauth.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
async function mintState(p: string): Promise<string> {
  const res = makeRes();
  await (getAuthUrl as any)({ params: { provider: p } }, res);
  return (res.json as jest.Mock).mock.calls[0][0].state as string;
}

const realFetch = global.fetch;
beforeEach(() => { jest.clearAllMocks(); });

describe('Microsoft OAuth nOAuth mitigation', () => {
  it('refuses the shared `common` tenant even when the IdP returns a well-formed email', async () => {
    const state = await mintState('microsoft');
    // Token exchange succeeds and userinfo returns an email — the handler must
    // STILL reject purely on the shared-tenant policy, before linking anything.
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: 'ms-1', email: 'victim@company.com' }) }) as any;

    await expect(verifyOAuthCode('microsoft', 'code', state)).rejects.toThrow(/pinned OAUTH_MICROSOFT_TENANT/);
    global.fetch = realFetch;
  });
});
