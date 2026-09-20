// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SSO "test connection" (controllers/sso-test.ts) — a DRY RUN of the org's IdP.
 *
 * What must hold:
 *   - a test runs the real verification + the read-only half of the sign-in
 *     rules (domain authority, platform-admin refusal, seat pre-flight) and
 *     reports the identity, groups and the mappings that WOULD apply;
 *   - it creates NOTHING: no user, no membership, no session;
 *   - a test state is useless anywhere else: the real OIDC callback refuses it,
 *     a forged / other-org / other-admin state is refused, and it is single-use;
 *   - the SAML leg (ACS) parks the report for the admin's window and redirects
 *     with `?test=`, never with a handoff;
 *   - the outcome is audited and recorded as the config's last test.
 */

import crypto from 'crypto';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockFindByOrg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRecord = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockBuildAuthorizeUrl = jest.fn<(...a: unknown[]) => Promise<{ url: string; codeVerifier?: string }>>();
const mockExchange = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockBuildSamlUrl = jest.fn<(...a: unknown[]) => Promise<string>>();
const mockValidateSaml = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockTrusted = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockSeat = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockResolveMapped = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUserFindOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRoleFind = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRequireOwnOrgSso = jest.fn<(...a: unknown[]) => Promise<boolean>>();
// Tripwires: the sign-in side effects a dry run must never reach.
const mockFindOrCreate = jest.fn();
const mockProvisionJit = jest.fn();
const mockIssueTokens = jest.fn();
const mockGetEnforcedLoginConfig = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json(data); return res; },
  sendError: (res: any, status: number, message: string, code?: string) => { res.status(status).json({ success: false, message, code }); return res; },
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
}));
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { oauth: { callbackBaseUrl: 'https://pb.test', stateTtlMs: 600_000, cleanupIntervalMs: 600_000, maxPendingStates: 1000 } },
}));
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({ getRedisClient: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  requireOwnOrgSso: (...a: unknown[]) => mockRequireOwnOrgSso(...a),
  assertSsoIdentityTrusted: (...a: unknown[]) => mockTrusted(...a),
  getTestableLoginConfig: async (orgId: string) => ({ orgId, provider: 'generic-oidc' }),
  getTestableSamlConfig: async (orgId: string) => ({ orgId, entityId: 'https://idp.test' }),
  // The REAL sign-in callback's resolvers — used below to prove it refuses a test state.
  getEnforcedLoginConfig: (...a: unknown[]) => mockGetEnforcedLoginConfig(...a),
  getEnforcedIdpProtocol: async () => 'oidc',
  findSsoCoverageForEmail: async () => null,
}));
jest.unstable_mockModule('../src/services/org-idp-service.js', () => ({
  orgIdpService: { findByOrg: (...a: unknown[]) => mockFindByOrg(...a), recordTestResult: (...a: unknown[]) => mockRecord(...a) },
}));
jest.unstable_mockModule('../src/services/oidc-service.js', () => ({
  OIDC_ERROR_MAP: {
    OIDC_INVALID_STATE: { status: 403, message: 'Invalid or expired SSO state' },
    OIDC_INVALID_ID_TOKEN: { status: 401, message: 'The identity provider returned an invalid token' },
    OIDC_EMAIL_DOMAIN_NOT_VERIFIED: { status: 403, message: 'domain not verified' },
  },
  buildAuthorizeUrl: (...a: unknown[]) => mockBuildAuthorizeUrl(...a),
  exchangeAndValidate: (...a: unknown[]) => mockExchange(...a),
}));
jest.unstable_mockModule('../src/services/saml-service.js', () => ({
  SAML_ERROR_MAP: { SAML_INVALID_ASSERTION: { status: 401, message: 'The identity provider returned an invalid SAML assertion' } },
  buildSamlAuthorizeUrl: (...a: unknown[]) => mockBuildSamlUrl(...a),
  samlLandingUrl: (orgId: string) => `https://pb.test/auth/sso/${orgId}/saml`,
  validateSamlResponse: (...a: unknown[]) => mockValidateSaml(...a),
}));
const MARKER_KEY = crypto.randomBytes(32);
jest.unstable_mockModule('../src/services/saml-sp-keys.js', () => ({ getSamlSpKeys: async () => ({ testMarkerKey: MARKER_KEY }) }));
jest.unstable_mockModule('../src/services/sso-jit-service.js', () => ({
  assertJitSeatAvailable: (...a: unknown[]) => mockSeat(...a),
  provisionJitMembership: (...a: unknown[]) => mockProvisionJit(...a),
}));
jest.unstable_mockModule('../src/services/idp-group-mapping-service.js', () => ({
  idpGroupMappingService: { resolveMappedRoles: (...a: unknown[]) => mockResolveMapped(...a) },
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findOne: (...a: unknown[]) => ({ select: () => ({ lean: () => mockUserFindOne(...a) }) }) },
  Role: { find: (...a: unknown[]) => ({ select: () => ({ lean: () => mockRoleFind(...a) }) }) },
}));
jest.unstable_mockModule('../src/services/index.js', () => ({ authService: { findOrCreateOAuthUser: mockFindOrCreate } }));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  issueTokens: mockIssueTokens,
  signInAuth: () => ({ amr: ['sso'], aal: 1, authTime: new Date(0) }),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  oauthCallbackSchema: {},
  ssoDiscoverSchema: {},
  validateBody: (_s: unknown, body: unknown) => body,
}));
jest.unstable_mockModule('../src/controllers/saml.js', () => ({ beginSamlLogin: jest.fn() }));

const { startSsoTest, completeSsoTest, handleSamlTestAssertion, isTestState, __resetSsoTestStores } =
  await import('../src/controllers/sso-test.js');
const { handleSsoCallback } = await import('../src/controllers/sso.js');

const ORG = 'org-1';
const ADMIN = { sub: 'admin-1', organizationId: ORG };

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}
const body = (res: any) => (res.json as jest.Mock).mock.calls[0][0] as any;

async function start(protocol: 'oidc' | 'saml', user = ADMIN): Promise<string> {
  mockFindByOrg.mockResolvedValue({ protocol, updatedAt: '2026-09-01T00:00:00.000Z' });
  const res = makeRes();
  await (startSsoTest as any)({ params: { id: ORG }, user }, res);
  return body(res).state as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetSsoTestStores();
  mockRequireOwnOrgSso.mockResolvedValue(true);
  mockRecord.mockResolvedValue(true);
  mockBuildAuthorizeUrl.mockResolvedValue({ url: 'https://idp.test/authorize?x', codeVerifier: 'verifier-1' });
  mockBuildSamlUrl.mockResolvedValue('https://idp.test/saml?SAMLRequest=x');
  mockExchange.mockResolvedValue({ subject: 'sub-1', issuer: 'https://idp.test', email: 'ada@acme.test', name: 'Ada', groups: ['Eng'] });
  mockValidateSaml.mockResolvedValue({ subject: 'ada@acme.test', issuer: 'https://idp.test', email: 'ada@acme.test', groups: ['Eng'] });
  mockTrusted.mockResolvedValue(undefined);
  mockSeat.mockResolvedValue(undefined);
  mockUserFindOne.mockResolvedValue(null);
  mockResolveMapped.mockResolvedValue({ roleIds: ['r1'], matchedGroups: ['Eng'] });
  mockRoleFind.mockResolvedValue([{ _id: 'r1', name: 'Engineers' }]);
});

describe('start', () => {
  it('mints a signed ssotest. marker and the real authorize URL', async () => {
    const state = await start('oidc');
    expect(isTestState(state)).toBe(true);
    expect(state.split('.')).toHaveLength(3);
    expect(mockBuildAuthorizeUrl).toHaveBeenCalledWith({ orgId: ORG, provider: 'generic-oidc' }, state, expect.any(String));
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'sso.test', expect.objectContaining({ details: { stage: 'start', protocol: 'oidc' } }));
  });

  it('asks the SAML service for a TEST AuthnRequest (its own request-id cache)', async () => {
    const state = await start('saml');
    expect(mockBuildSamlUrl).toHaveBeenCalledWith({ orgId: ORG, entityId: 'https://idp.test' }, state, { test: true });
  });

  it('404s when there is nothing to test', async () => {
    mockFindByOrg.mockResolvedValue(null);
    const res = makeRes();
    await (startSsoTest as any)({ params: { id: ORG }, user: ADMIN }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('OIDC dry run', () => {
  it('reports identity, groups and mappings — and creates nothing', async () => {
    const state = await start('oidc');
    const res = makeRes();
    await (completeSsoTest as any)({ params: { id: ORG }, user: ADMIN, body: { state, code: 'code-1' } }, res);

    expect(mockExchange).toHaveBeenCalledWith(expect.anything(), 'code-1', expect.any(String), { codeVerifier: 'verifier-1' });
    const { report } = body(res);
    expect(report).toMatchObject({
      ok: true,
      protocol: 'oidc',
      identity: { email: 'ada@acme.test', name: 'Ada', groups: ['Eng'] },
      mappings: { matchedGroups: ['Eng'], roles: [{ id: 'r1', name: 'Engineers' }] },
      recorded: true,
    });
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(mockProvisionJit).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith(ORG, '2026-09-01T00:00:00.000Z', expect.objectContaining({ ok: true, protocol: 'oidc', actorId: 'admin-1' }));
    expect(mockAudit).toHaveBeenLastCalledWith(expect.anything(), 'sso.test', expect.objectContaining({
      outcome: 'success', details: expect.objectContaining({ stage: 'complete', ok: true, email: 'ada@acme.test' }),
    }));
  });

  it('reports the sign-in rule that would refuse the person (domain not verified)', async () => {
    mockTrusted.mockRejectedValue(new Error('OIDC_EMAIL_DOMAIN_NOT_VERIFIED'));
    const state = await start('oidc');
    const res = makeRes();
    await (completeSsoTest as any)({ params: { id: ORG }, user: ADMIN, body: { state, code: 'c' } }, res);
    expect(body(res).report).toMatchObject({ ok: false, reason: 'domain_not_verified', identity: { email: 'ada@acme.test' } });
    expect(mockRecord).toHaveBeenCalledWith(ORG, expect.any(String), expect.objectContaining({ ok: false, reason: 'domain_not_verified' }));
  });

  it('reports a platform administrator as refused', async () => {
    mockUserFindOne.mockResolvedValue({ isSuperAdmin: true });
    const state = await start('oidc');
    const res = makeRes();
    await (completeSsoTest as any)({ params: { id: ORG }, user: ADMIN, body: { state, code: 'c' } }, res);
    expect(body(res).report).toMatchObject({ ok: false, reason: 'platform_admin' });
  });

  it('reports an invalid token with its reason', async () => {
    mockExchange.mockRejectedValue(new Error('OIDC_INVALID_ID_TOKEN'));
    const state = await start('oidc');
    const res = makeRes();
    await (completeSsoTest as any)({ params: { id: ORG }, user: ADMIN, body: { state, code: 'c' } }, res);
    expect(body(res).report).toMatchObject({ ok: false, reason: 'invalid_id_token', message: 'The identity provider returned an invalid token' });
  });

  it('reports an IdP-side error without exchanging anything', async () => {
    const state = await start('oidc');
    const res = makeRes();
    await (completeSsoTest as any)({ params: { id: ORG }, user: ADMIN, body: { state, error: 'access_denied' } }, res);
    expect(body(res).report).toMatchObject({ ok: false, reason: 'idp_error' });
    expect(mockExchange).not.toHaveBeenCalled();
  });
});

describe('a test state is good for nothing else', () => {
  it('is REFUSED by the real sign-in callback — a test can never become a session', async () => {
    const state = await start('oidc');
    const res = makeRes();
    await (handleSsoCallback as any)({ params: { orgId: ORG }, body: { code: 'c', state } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockExchange).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });

  it('is single-use', async () => {
    const state = await start('oidc');
    await (completeSsoTest as any)({ params: { id: ORG }, user: ADMIN, body: { state, code: 'c' } }, makeRes());
    const res = makeRes();
    await (completeSsoTest as any)({ params: { id: ORG }, user: ADMIN, body: { state, code: 'c' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('can only be collected by the admin who started it', async () => {
    const state = await start('oidc');
    const res = makeRes();
    await (completeSsoTest as any)({ params: { id: ORG }, user: { sub: 'someone-else' }, body: { state, code: 'c' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('refuses a marker forged without the deployment key, or presented for another org', async () => {
    const forged = makeRes();
    await (completeSsoTest as any)({ params: { id: ORG }, user: ADMIN, body: { state: 'ssotest.abc.forgedsig', code: 'c' } }, forged);
    expect(forged.status).toHaveBeenCalledWith(403);

    const state = await start('oidc');
    const other = makeRes();
    await (completeSsoTest as any)({ params: { id: 'org-2' }, user: ADMIN, body: { state, code: 'c' } }, other);
    expect(other.status).toHaveBeenCalledWith(403);
  });
});

describe('SAML dry run (ACS leg + collection)', () => {
  it('parks the report and redirects with ?test=, never a handoff; the admin collects it', async () => {
    const state = await start('saml');
    const acsRes = makeRes();
    await handleSamlTestAssertion(acsRes, ORG, 'b64-response', state);

    expect(mockValidateSaml).toHaveBeenCalledWith(expect.anything(), 'b64-response', state, state, { test: true });
    const redirect = (acsRes.redirect as jest.Mock).mock.calls[0][1] as string;
    expect(redirect).toContain(`?test=${encodeURIComponent(state)}`);
    expect(redirect).not.toContain('handoff');

    const res = makeRes();
    await (completeSsoTest as any)({ params: { id: ORG }, user: ADMIN, body: { state } }, res);
    expect(body(res).report).toMatchObject({ ok: true, protocol: 'saml', identity: { email: 'ada@acme.test' } });
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });

  it('reports an invalid assertion as a failed test', async () => {
    mockValidateSaml.mockRejectedValue(new Error('SAML_INVALID_ASSERTION'));
    const state = await start('saml');
    await handleSamlTestAssertion(makeRes(), ORG, 'r', state);
    const res = makeRes();
    await (completeSsoTest as any)({ params: { id: ORG }, user: ADMIN, body: { state } }, res);
    expect(body(res).report).toMatchObject({ ok: false, reason: 'invalid_assertion' });
  });

  it('refuses a forged marker at the ACS without validating anything', async () => {
    const res = makeRes();
    await handleSamlTestAssertion(res, ORG, 'r', 'ssotest.abc.nope');
    expect((res.redirect as jest.Mock).mock.calls[0][1]).toContain('error=SAML_INVALID_STATE');
    expect(mockValidateSaml).not.toHaveBeenCalled();
  });
});
