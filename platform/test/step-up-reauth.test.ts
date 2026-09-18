// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step-up by provider re-auth (controllers/step-up-reauth.ts) + the factor
 * resolution it shares with GET /user/profile (helpers/auth-factors.ts).
 *
 * The contract that matters: a re-auth may only start for a provider the
 * account is actually linked to, its state is single-use and bound to the
 * signed-in user, the returning identity must be the SAME linked identity, the
 * provider must show the sign-in is fresh when it can, and only then is the
 * ordinary step-up token issued (with `method: 'reauth'`).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const GOOGLE_ISSUER = 'https://accounts.google.com';

// -- Fixtures the mocks read -------------------------------------------------
let userDoc: Record<string, unknown> | null;
let memberships: Array<{ organizationId: string }>;
let idpConfigs: Array<{ orgId: string; provider: string }>;
let orgs: Array<{ _id: string; name: string }>;
let enabledProviders: Set<string>;
let ssoEnforcement: { orgId: string; provider: string } | null;
let entitledOrgs: Set<string>;
let passkeyCount: number;
let hasTotp = false;

const mockAudit = jest.fn();
const mockIncCounter = jest.fn();
const mockIssueStepUpToken = jest.fn(() => ({ token: 'stepup.jwt', expiresAt: 1234 }));
const mockVerifyOAuthReauthCode = jest.fn<(p: string, c: string) => Promise<{ userInfo: { id: string; email: string }; authTime?: number }>>();
const mockExchangeAndValidate = jest.fn<(...a: unknown[]) => Promise<{ subject: string; issuer: string; email: string; authTime?: number }>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) => { res.status(status).json({ success: false, message: msg, code }); return res; },
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json({ success: true, data }); return res; },
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { oauth: { stateTtlMs: 600_000, cleanupIntervalMs: 600_000, maxPendingStates: 1000 } },
}));

// Body validation: run the controller's real zod schema when it has one,
// else mirror oauthCallbackSchema's min(1) on code + state.
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  oauthCallbackSchema: {},
  validateBody: (schema: any, body: any, res: any) => {
    if (typeof schema?.safeParse === 'function') {
      const parsed = schema.safeParse(body);
      if (parsed.success) return parsed.data;
    } else if (body?.code && body?.state) {
      return body;
    }
    res.status(400).json({ success: false, message: 'VALIDATION_ERROR' });
    return null;
  },
}));

const leanOf = (value: unknown) => ({ select: () => ({ lean: async () => value }) });
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: () => leanOf(userDoc) },
  UserOrganization: { find: () => leanOf(memberships) },
  OrgIdpConfig: { find: () => leanOf(idpConfigs) },
  Organization: { find: () => leanOf(orgs) },
  PersonalAccessToken: {},
  UserPreferences: {},
  // `resolveAuthFactors` reports the account's real passkey count, and whether
  // it has a CONFIRMED authenticator-app enrolment.
  WebAuthnCredential: { countDocuments: async () => passkeyCount },
  UserTotp: { exists: async () => (hasTotp ? { _id: 'x' } : null) },
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  // Session-auth helpers the controllers now import (see utils/token.ts).
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  findRefreshSession: jest.fn(async () => undefined),
  issueStepUpToken: (...a: unknown[]) => mockIssueStepUpToken(...a),
}));
// No Redis in tests → the pending-state store uses its in-process fallback.
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({ getRedisClient: async () => null }));

jest.unstable_mockModule('../src/helpers/oauth-config.js', () => ({
  isOAuthProviderEnabled: (name: string) => enabledProviders.has(name),
}));

jest.unstable_mockModule('../src/controllers/oauth.js', () => ({
  OAUTH_ERROR_MAP: {},
  buildOAuthReauthUrl: (name: string, state: string) => ({
    url: `https://provider.test/${name}?prompt=select_account&max_age=0&state=${state}`,
    codeVerifier: 'oauth-verifier',
  }),
  verifyOAuthReauthCode: (...a: [string, string]) => mockVerifyOAuthReauthCode(...a),
}));

jest.unstable_mockModule('../src/services/oidc-service.js', () => ({
  OIDC_ERROR_MAP: {},
  buildAuthorizeUrl: async (_cfg: unknown, state: string, nonce: string) => ({
    url: `https://idp.test/authorize?prompt=login&max_age=0&state=${state}&nonce=${nonce}`,
    codeVerifier: 'sso-verifier',
  }),
  exchangeAndValidate: (...a: unknown[]) => mockExchangeAndValidate(...a),
  ssoReauthRequiresAuthTime: (provider: string) => provider !== 'google',
}));

jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  GOOGLE_ISSUER,
  findSsoEnforcementForEmail: async () => ssoEnforcement,
  isSsoEntitled: async (orgId: string) => entitledOrgs.has(orgId),
  getEnforcedLoginConfig: async (orgId: string) => ({ orgId, provider: idpConfigs.find(c => c.orgId === orgId)?.provider ?? 'generic-oidc', clientId: 'c', clientSecret: 's', discoveryUrl: 'https://idp.test', allowedEmailDomains: [] }),
  assertSsoIdentityTrusted: async () => undefined,
}));

const { resolveAuthFactors, loadFactorUser } = await import('../src/helpers/auth-factors.js');
const { startStepUpReauth, completeStepUpReauth } = await import('../src/controllers/step-up-reauth.js');

function mockRes() {
  const res: any = { body: undefined, code: undefined };
  res.status = jest.fn((s: number) => { res.code = s; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; return res; });
  return res;
}

const call = async (handler: unknown, req: unknown) => {
  const res = mockRes();
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

const asUser = (body: unknown) => ({ body, user: { sub: 'u1' } });

beforeEach(() => {
  userDoc = {
    _id: 'u1',
    email: 'dev@acme.test',
    password: undefined,
    oauth: { google: { id: 'g-sub-1' } },
  };
  memberships = [{ organizationId: 'org1' }];
  idpConfigs = [];
  orgs = [{ _id: 'org1', name: 'Acme' }];
  enabledProviders = new Set(['google']);
  ssoEnforcement = null;
  entitledOrgs = new Set(['org1']);
  passkeyCount = 0;
  hasTotp = false;
  mockAudit.mockReset();
  mockIncCounter.mockReset();
  mockVerifyOAuthReauthCode.mockReset();
  mockExchangeAndValidate.mockReset();
});

describe('resolveAuthFactors', () => {
  it('reports a password-only account with no provider options', async () => {
    userDoc = { _id: 'u1', email: 'dev@acme.test', password: 'hash', oauth: {} };
    const factors = await resolveAuthFactors((await loadFactorUser('u1'))!);
    expect(factors).toEqual({ hasPassword: true, passkeyCount: 0, hasTotp: false, providers: [] });
  });

  it('reports the account\'s real passkey count, so the modal can offer one', async () => {
    passkeyCount = 2;
    const factors = await resolveAuthFactors((await loadFactorUser('u1'))!);
    expect(factors.passkeyCount).toBe(2);
  });

  it('reports a CONFIRMED authenticator app, so the modal can offer a code', async () => {
    hasTotp = true;
    userDoc = { _id: 'u1', email: 'dev@acme.test', password: 'hash', oauth: {} };
    const factors = await resolveAuthFactors((await loadFactorUser('u1'))!);
    expect(factors.hasTotp).toBe(true);
  });

  it('offers a linked social provider (and no password) for a social-only account', async () => {
    const factors = await resolveAuthFactors((await loadFactorUser('u1'))!);
    expect(factors.hasPassword).toBe(false);
    expect(factors.providers).toEqual([{ type: 'oauth', provider: 'google' }]);
  });

  it('drops a linked provider that is no longer configured', async () => {
    enabledProviders = new Set();
    const factors = await resolveAuthFactors((await loadFactorUser('u1'))!);
    expect(factors.providers).toEqual([]);
  });

  it('drops social options when the email is SSO-enforced (sign-in refuses them too)', async () => {
    ssoEnforcement = { orgId: 'org1', provider: 'generic-oidc' };
    const factors = await resolveAuthFactors((await loadFactorUser('u1'))!);
    expect(factors.providers).toEqual([]);
  });

  it('offers an SSO org whose enabled + entitled IdP matches the linked issuer', async () => {
    userDoc = { _id: 'u1', email: 'dev@acme.test', oauth: { 'generic-oidc': { id: 'sso-sub', issuer: 'https://idp.test' } } };
    idpConfigs = [{ orgId: 'org1', provider: 'generic-oidc' }];
    const factors = await resolveAuthFactors((await loadFactorUser('u1'))!);
    expect(factors.providers).toEqual([{ type: 'sso', provider: 'generic-oidc', orgId: 'org1', orgName: 'Acme' }]);
  });

  it('refuses SSO re-auth for a platform administrator', async () => {
    userDoc = { _id: 'u1', email: 'ops@pb.test', isSuperAdmin: true, oauth: { 'generic-oidc': { id: 'sso-sub', issuer: 'https://idp.test' } } };
    idpConfigs = [{ orgId: 'org1', provider: 'generic-oidc' }];
    const factors = await resolveAuthFactors((await loadFactorUser('u1'))!);
    expect(factors.providers).toEqual([]);
  });

  it('skips an SSO org that is not entitled to SSO', async () => {
    userDoc = { _id: 'u1', email: 'dev@acme.test', oauth: { 'generic-oidc': { id: 'sso-sub', issuer: 'https://idp.test' } } };
    idpConfigs = [{ orgId: 'org1', provider: 'generic-oidc' }];
    entitledOrgs = new Set();
    const factors = await resolveAuthFactors((await loadFactorUser('u1'))!);
    expect(factors.providers).toEqual([]);
  });
});

describe('POST /auth/step-up/reauth', () => {
  it('rejects a provider the account is not linked to', async () => {
    const res = await call(startStepUpReauth, asUser({ type: 'oauth', provider: 'github' }));
    expect(res.code).toBe(400);
  });

  it('returns a re-prompting authorize URL and a reauth-prefixed state', async () => {
    const res = await call(startStepUpReauth, asUser({ type: 'oauth', provider: 'google' }));
    expect(res.code).toBe(200);
    expect(res.body.data.state.startsWith('reauth.')).toBe(true);
    expect(res.body.data.url).toContain('prompt=select_account');
  });

  it('starts an SSO re-auth with prompt=login + max_age=0', async () => {
    userDoc = { _id: 'u1', email: 'dev@acme.test', oauth: { 'generic-oidc': { id: 'sso-sub', issuer: 'https://idp.test' } } };
    idpConfigs = [{ orgId: 'org1', provider: 'generic-oidc' }];
    const res = await call(startStepUpReauth, asUser({ type: 'sso', orgId: 'org1' }));
    expect(res.code).toBe(200);
    expect(res.body.data.url).toContain('prompt=login');
    expect(res.body.data.url).toContain('max_age=0');
  });

  it('rejects a malformed body', async () => {
    const res = await call(startStepUpReauth, asUser({ type: 'passkey' }));
    expect(res.code).toBe(400);
  });
});

/** Start a re-auth and return the state the controller minted. */
async function startedState(body: unknown = { type: 'oauth', provider: 'google' }): Promise<string> {
  const res = await call(startStepUpReauth, asUser(body));
  return res.body.data.state as string;
}

describe('POST /auth/step-up/reauth/callback', () => {
  it('issues a step-up token with method reauth for the linked identity', async () => {
    const state = await startedState();
    mockVerifyOAuthReauthCode.mockResolvedValue({ userInfo: { id: 'g-sub-1', email: 'dev@acme.test' } });

    const res = await call(completeStepUpReauth, asUser({ code: 'c1', state }));
    expect(res.code).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, stepUpToken: 'stepup.jwt', method: 'reauth' });
    expect(mockIssueStepUpToken).toHaveBeenCalledWith('u1', 'reauth');
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.step-up',
      expect.objectContaining({ details: expect.objectContaining({ method: 'reauth', kind: 'oauth', provider: 'google', recencyVerified: false }) }),
    );
    expect(mockIncCounter).toHaveBeenCalledWith('platform_step_up_total', { method: 'reauth', outcome: 'success' });
  });

  it('refuses a different identity from the same provider', async () => {
    const state = await startedState();
    mockVerifyOAuthReauthCode.mockResolvedValue({ userInfo: { id: 'g-other', email: 'dev@acme.test' } });

    const res = await call(completeStepUpReauth, asUser({ code: 'c1', state }));
    expect(res.code).toBe(403);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.login.failed',
      expect.objectContaining({ targetType: 'step-up', outcome: 'failure' }),
    );
  });

  it('refuses an auth_time from before the re-auth started', async () => {
    const state = await startedState();
    mockVerifyOAuthReauthCode.mockResolvedValue({
      userInfo: { id: 'g-sub-1', email: 'dev@acme.test' },
      authTime: Math.floor(Date.now() / 1000) - 3600,
    });

    const res = await call(completeStepUpReauth, asUser({ code: 'c1', state }));
    expect(res.code).toBe(401);
  });

  it('accepts a fresh auth_time and records recencyVerified', async () => {
    const state = await startedState();
    mockVerifyOAuthReauthCode.mockResolvedValue({
      userInfo: { id: 'g-sub-1', email: 'dev@acme.test' },
      authTime: Math.floor(Date.now() / 1000),
    });

    const res = await call(completeStepUpReauth, asUser({ code: 'c1', state }));
    expect(res.code).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.step-up',
      expect.objectContaining({ details: expect.objectContaining({ recencyVerified: true }) }),
    );
  });

  it('rejects a state minted for another user', async () => {
    const state = await startedState();
    const res = await call(completeStepUpReauth, { body: { code: 'c1', state }, user: { sub: 'u2' } });
    expect(res.code).toBe(403);
    expect(mockVerifyOAuthReauthCode).not.toHaveBeenCalled();
  });

  it('consumes the state once — a replay is refused', async () => {
    const state = await startedState();
    mockVerifyOAuthReauthCode.mockResolvedValue({ userInfo: { id: 'g-sub-1', email: 'dev@acme.test' } });
    expect((await call(completeStepUpReauth, asUser({ code: 'c1', state }))).code).toBe(200);
    expect((await call(completeStepUpReauth, asUser({ code: 'c1', state }))).code).toBe(403);
  });

  it('rejects an unknown state', async () => {
    const res = await call(completeStepUpReauth, asUser({ code: 'c1', state: 'reauth.deadbeef' }));
    expect(res.code).toBe(403);
  });

  it('requires an SSO id_token auth_time for a generic OIDC IdP', async () => {
    userDoc = { _id: 'u1', email: 'dev@acme.test', oauth: { 'generic-oidc': { id: 'sso-sub', issuer: 'https://idp.test' } } };
    idpConfigs = [{ orgId: 'org1', provider: 'generic-oidc' }];
    const state = await startedState({ type: 'sso', orgId: 'org1' });
    mockExchangeAndValidate.mockResolvedValue({ subject: 'sso-sub', issuer: 'https://idp.test', email: 'dev@acme.test' });

    const res = await call(completeStepUpReauth, asUser({ code: 'c1', state }));
    expect(res.code).toBe(401);
  });

  it('accepts an SSO re-auth whose issuer + subject match the linked identity', async () => {
    userDoc = { _id: 'u1', email: 'dev@acme.test', oauth: { 'generic-oidc': { id: 'sso-sub', issuer: 'https://idp.test' } } };
    idpConfigs = [{ orgId: 'org1', provider: 'generic-oidc' }];
    const state = await startedState({ type: 'sso', orgId: 'org1' });
    mockExchangeAndValidate.mockResolvedValue({
      subject: 'sso-sub', issuer: 'https://idp.test', email: 'dev@acme.test', authTime: Math.floor(Date.now() / 1000),
    });

    const res = await call(completeStepUpReauth, asUser({ code: 'c1', state }));
    expect(res.code).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      'user.step-up',
      expect.objectContaining({ affectedOrgId: 'org1', details: expect.objectContaining({ kind: 'sso' }) }),
    );
  });

  it('refuses an SSO identity from a different issuer', async () => {
    userDoc = { _id: 'u1', email: 'dev@acme.test', oauth: { 'generic-oidc': { id: 'sso-sub', issuer: 'https://idp.test' } } };
    idpConfigs = [{ orgId: 'org1', provider: 'generic-oidc' }];
    const state = await startedState({ type: 'sso', orgId: 'org1' });
    mockExchangeAndValidate.mockResolvedValue({
      subject: 'sso-sub', issuer: 'https://evil-idp.test', email: 'dev@acme.test', authTime: Math.floor(Date.now() / 1000),
    });

    const res = await call(completeStepUpReauth, asUser({ code: 'c1', state }));
    expect(res.code).toBe(403);
  });
});
