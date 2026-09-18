// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-org SSO login controller (controllers/sso.ts):
 *   - state/nonce lifecycle: getSsoAuthUrl mints a one-time state bound to the
 *     org + nonce; handleSsoCallback consumes it once; a replay is rejected.
 *   - callback org binding: a state minted for org A can't be replayed on org B.
 *   - discover: returns ONLY `{ sso: boolean }` — never the internal orgId /
 *     provider (the enumeration-oracle fix, C2).
 *
 * The pending-state store runs its in-memory fallback (redis-client mocked to
 * return undefined), so the mint→consume round-trip stays within-process.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetEnforcedLoginConfig = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindSsoEnforcementForEmail = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAssertSsoIdentityTrusted = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockBuildAuthorizeUrl = jest.fn<(...a: unknown[]) => Promise<{ url: string; codeVerifier?: string }>>();
const mockExchangeAndValidate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindOrCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAssertSeat = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockProvisionJit = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAudit = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json(data); return res; },
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { oauth: { stateTtlMs: 600000, cleanupIntervalMs: 600000 } },
}));

// Force the pending-state store's in-memory fallback (Redis unset).
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));

jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  getEnforcedLoginConfig: (...a: unknown[]) => mockGetEnforcedLoginConfig(...a),
  findSsoEnforcementForEmail: (...a: unknown[]) => mockFindSsoEnforcementForEmail(...a),
  assertSsoIdentityTrusted: (...a: unknown[]) => mockAssertSsoIdentityTrusted(...a),
  rejectIfSsoEnforced: async () => false,
}));

jest.unstable_mockModule('../src/services/oidc-service.js', () => ({
  OIDC_ERROR_MAP: {
    OIDC_NOT_CONFIGURED: { status: 404, message: 'not configured' },
    OIDC_DISABLED: { status: 403, message: 'disabled' },
    OIDC_NOT_ENTITLED: { status: 403, message: 'not entitled' },
    OIDC_INVALID_STATE: { status: 403, message: 'Invalid or expired SSO state' },
    OIDC_EMAIL_DOMAIN_NOT_VERIFIED: { status: 403, message: 'domain not verified' },
    JIT_SEAT_LIMIT: { status: 403, message: 'no seats left' },
  },
  buildAuthorizeUrl: (...a: unknown[]) => mockBuildAuthorizeUrl(...a),
  exchangeAndValidate: (...a: unknown[]) => mockExchangeAndValidate(...a),
}));

jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { findOrCreateOAuthUser: (...a: unknown[]) => mockFindOrCreate(...a) },
}));

// JIT provisioning (3a) — the callback runs the seat pre-flight before turning
// the identity into an account, then provisions the membership + mapped Roles.
jest.unstable_mockModule('../src/services/sso-jit-service.js', () => ({
  assertJitSeatAvailable: (...a: unknown[]) => mockAssertSeat(...a),
  provisionJitMembership: (...a: unknown[]) => mockProvisionJit(...a),
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
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  oauthCallbackSchema: {},
  ssoDiscoverSchema: {},
  validateBody: (_schema: unknown, body: any, res: any) => {
    if (body?.email !== undefined) return body; // discover
    if (body?.code && body?.state) return body; // callback
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

const { getSsoAuthUrl, handleSsoCallback, discoverSso } = await import('../src/controllers/sso.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Mint a one-time state for `orgId` via the real getSsoAuthUrl. */
async function mintState(orgId: string): Promise<string> {
  const res = makeRes();
  mockGetEnforcedLoginConfig.mockResolvedValue({ provider: 'generic-oidc' });
  mockBuildAuthorizeUrl.mockResolvedValue({ url: 'https://idp.test/authorize?state=x', codeVerifier: 'verifier-1' });
  await (getSsoAuthUrl as any)({ params: { orgId } }, res);
  return (res.json as jest.Mock).mock.calls[0][0].state as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIssueTokens.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
  mockAssertSsoIdentityTrusted.mockResolvedValue(undefined);
  mockAssertSeat.mockResolvedValue(undefined);
  mockProvisionJit.mockResolvedValue({ membershipCreated: false, matchedGroups: [], rolesAdded: [], rolesRemoved: [] });
});
afterEach(() => { jest.clearAllMocks(); });

describe('getSsoAuthUrl', () => {
  it('mints a state + returns the IdP authorize URL', async () => {
    const res = makeRes();
    mockGetEnforcedLoginConfig.mockResolvedValue({ provider: 'generic-oidc' });
    mockBuildAuthorizeUrl.mockResolvedValue({ url: 'https://idp.test/authorize', codeVerifier: 'verifier-1' });
    await (getSsoAuthUrl as any)({ params: { orgId: 'org-1' } }, res);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.url).toBe('https://idp.test/authorize');
    expect(typeof body.state).toBe('string');
    expect(body.state.length).toBeGreaterThan(0);
  });

  it('maps a disabled/unentitled org to its typed OIDC status', async () => {
    const res = makeRes();
    mockGetEnforcedLoginConfig.mockRejectedValue(new Error('OIDC_NOT_ENTITLED'));
    await (getSsoAuthUrl as any)({ params: { orgId: 'org-x' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('handleSsoCallback (state lifecycle + org binding)', () => {
  it('exchanges the code and issues tokens on a valid state', async () => {
    const state = await mintState('org-1');
    mockGetEnforcedLoginConfig.mockResolvedValue({ provider: 'generic-oidc' });
    mockExchangeAndValidate.mockResolvedValue({ subject: 'sub-1', issuer: 'https://idp.test', email: 'u@x.com', name: 'U' });
    mockFindOrCreate.mockResolvedValue({ _id: 'u1' });

    const res = makeRes();
    await (handleSsoCallback as any)({ params: { orgId: 'org-1' }, body: { code: 'c', state } }, res);

    expect(mockExchangeAndValidate).toHaveBeenCalled();
    expect(mockAssertSsoIdentityTrusted).toHaveBeenCalledWith('org-1', expect.objectContaining({ email: 'u@x.com' }));
    // The link is bound to the IdP that signed the token.
    expect(mockFindOrCreate).toHaveBeenCalledWith(
      'generic-oidc',
      expect.objectContaining({ email: 'u@x.com' }),
      { markOnboarding: false, sso: { issuer: 'https://idp.test' } },
    );
    // SSO opens an INTERACTIVE session stamped `amr: ['sso']`.
    expect(mockIssueTokens).toHaveBeenCalledWith(
      expect.anything(), 'org-1', expect.objectContaining({ kind: 'interactive' }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('refuses an identity on a domain the org has not verified — before any account is touched', async () => {
    const state = await mintState('org-1');
    mockGetEnforcedLoginConfig.mockResolvedValue({ provider: 'generic-oidc' });
    mockExchangeAndValidate.mockResolvedValue({ subject: 's', issuer: 'https://evil-idp.test', email: 'ceo@victim.com' });
    mockAssertSsoIdentityTrusted.mockRejectedValue(new Error('OIDC_EMAIL_DOMAIN_NOT_VERIFIED'));

    const res = makeRes();
    await (handleSsoCallback as any)({ params: { orgId: 'org-1' }, body: { code: 'c', state } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });

  it('hands the exchange the PKCE verifier stored with the state — never one from the request', async () => {
    const state = await mintState('org-1');
    mockGetEnforcedLoginConfig.mockResolvedValue({ provider: 'generic-oidc' });
    mockExchangeAndValidate.mockResolvedValue({ subject: 's', issuer: 'https://idp.test', email: 'u@x.com', groups: [] });
    mockFindOrCreate.mockResolvedValue({ _id: 'u1' });

    const res = makeRes();
    await (handleSsoCallback as any)(
      // A caller-supplied verifier in the body must be ignored entirely.
      { params: { orgId: 'org-1' }, body: { code: 'c', state, code_verifier: 'attacker-supplied' } },
      res,
    );

    expect(mockExchangeAndValidate).toHaveBeenCalledWith(
      expect.anything(), 'c', expect.any(String), { codeVerifier: 'verifier-1' },
    );
  });

  it('provisions the membership from the token\'s groups, and audits it', async () => {
    const state = await mintState('org-1');
    mockGetEnforcedLoginConfig.mockResolvedValue({ provider: 'generic-oidc' });
    mockExchangeAndValidate.mockResolvedValue({ subject: 's', issuer: 'https://idp.test', email: 'u@x.com', groups: ['eng'] });
    mockFindOrCreate.mockResolvedValue({ _id: 'u1' });
    mockProvisionJit.mockResolvedValue({ membershipCreated: true, matchedGroups: ['eng'], rolesAdded: ['r1'], rolesRemoved: [] });

    const res = makeRes();
    await (handleSsoCallback as any)({ params: { orgId: 'org-1' }, body: { code: 'c', state } }, res);

    expect(mockProvisionJit).toHaveBeenCalledWith({ orgId: 'org-1', user: { _id: 'u1' }, groups: ['eng'] });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'sso.jit.provision', expect.objectContaining({
      affectedOrgId: 'org-1',
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('REFUSES the sign-in when the account is out of seats — before any account is created', async () => {
    const state = await mintState('org-1');
    mockGetEnforcedLoginConfig.mockResolvedValue({ provider: 'generic-oidc' });
    mockExchangeAndValidate.mockResolvedValue({ subject: 's', issuer: 'https://idp.test', email: 'u@x.com', groups: [] });
    mockAssertSeat.mockRejectedValue(new Error('JIT_SEAT_LIMIT'));

    const res = makeRes();
    await (handleSsoCallback as any)({ params: { orgId: 'org-1' }, body: { code: 'c', state } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    // The refusal is auditable + counted, not just a status code.
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'sso.jit.refused', expect.objectContaining({
      outcome: 'failure',
      details: expect.objectContaining({ reason: 'seat_limit' }),
    }));
  });

  it('audits a Role change on a returning member without re-announcing the provision', async () => {
    const state = await mintState('org-1');
    mockGetEnforcedLoginConfig.mockResolvedValue({ provider: 'generic-oidc' });
    mockExchangeAndValidate.mockResolvedValue({ subject: 's', issuer: 'https://idp.test', email: 'u@x.com', groups: ['sre'] });
    mockFindOrCreate.mockResolvedValue({ _id: 'u1' });
    mockProvisionJit.mockResolvedValue({ membershipCreated: false, matchedGroups: ['sre'], rolesAdded: [], rolesRemoved: ['r1'] });

    const res = makeRes();
    await (handleSsoCallback as any)({ params: { orgId: 'org-1' }, body: { code: 'c', state } }, res);

    const actions = mockAudit.mock.calls.map((c) => c[1]);
    expect(actions).toContain('sso.jit.role.change');
    expect(actions).not.toContain('sso.jit.provision');
  });

  it('rejects a REPLAYED state (consumed on first use) — 403', async () => {
    const state = await mintState('org-1');
    mockGetEnforcedLoginConfig.mockResolvedValue({ provider: 'generic-oidc' });
    mockExchangeAndValidate.mockResolvedValue({ subject: 's', email: 'u@x.com' });
    mockFindOrCreate.mockResolvedValue({ _id: 'u1' });

    const res1 = makeRes();
    await (handleSsoCallback as any)({ params: { orgId: 'org-1' }, body: { code: 'c', state } }, res1); // consumes
    const res2 = makeRes();
    await (handleSsoCallback as any)({ params: { orgId: 'org-1' }, body: { code: 'c', state } }, res2); // replay
    expect(res2.status).toHaveBeenCalledWith(403);
  });

  it('rejects a state minted for a DIFFERENT org (cross-org replay) — 403', async () => {
    const state = await mintState('org-A');
    const res = makeRes();
    await (handleSsoCallback as any)({ params: { orgId: 'org-B' }, body: { code: 'c', state } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockExchangeAndValidate).not.toHaveBeenCalled();
  });

  it('rejects a never-minted (forged) state — 403', async () => {
    const res = makeRes();
    await (handleSsoCallback as any)({ params: { orgId: 'org-1' }, body: { code: 'c', state: 'forged' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockExchangeAndValidate).not.toHaveBeenCalled();
  });
});

describe('discoverSso (enumeration-oracle fix, C2)', () => {
  it('returns { sso: true } WITHOUT leaking orgId/provider when enforced', async () => {
    mockFindSsoEnforcementForEmail.mockResolvedValue({ orgId: 'secret-org', provider: 'okta' });
    const res = makeRes();
    await (discoverSso as any)({ body: { email: 'a@corp.com' } }, res);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body).toEqual({ sso: true });
    expect(JSON.stringify(body)).not.toContain('secret-org');
    expect(JSON.stringify(body)).not.toContain('okta');
  });

  it('returns { sso: false } when no org enforces the domain', async () => {
    mockFindSsoEnforcementForEmail.mockResolvedValue(null);
    const res = makeRes();
    await (discoverSso as any)({ body: { email: 'a@personal.com' } }, res);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ sso: false });
  });
});
