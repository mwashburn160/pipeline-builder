// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SAML sign-in path (#4, controllers/saml.ts) — the checks BETWEEN a
 * verified assertion and a session.
 *
 * The cryptography is covered in saml-service.test.ts; what matters here is that
 * SAML goes through the SAME gates OIDC does, in the same order, and refuses the
 * same things:
 *   - the org must have DNS-verified the email's domain;
 *   - a platform administrator can never sign in through a tenant IdP;
 *   - the pooled seat cap refuses the sign-in rather than opening a membership-
 *     less session;
 *   - JIT membership + group→Role sync run BEFORE the session is minted;
 *   - IdP-initiated responses and replays are refused AND audited;
 *   - the ACS never issues tokens — it parks a one-time, org-bound handoff that
 *     the landing page redeems;
 *   - a RelayState carrying the dry-run marker is a TEST CONNECTION: it is handed
 *     to the test path and never reaches any sign-in logic;
 *   - redeeming the handoff records the IdP's NameID/SessionIndex for Single
 *     Logout, keyed by the new session.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetEnforcedSamlConfig = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAssertSsoIdentityTrusted = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockValidateSamlResponse = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockBuildSamlAuthorizeUrl = jest.fn<(...a: unknown[]) => Promise<string>>();
const mockFindOrCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAssertSeat = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockProvisionJit = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockAudit = jest.fn();
const mockIncCounter = jest.fn();
const mockRecordSamlSession = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockHandleTest = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockFindByOrg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockBuildMetadata = jest.fn<(...a: unknown[]) => Promise<string>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json(data); return res; },
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    oauth: {
      callbackBaseUrl: 'https://pb.test',
      cleanupIntervalMs: 600_000,
      maxPendingStates: 1000,
      samlRequestTtlMs: 600_000,
      samlHandoffTtlMs: 120_000,
    },
  },
}));

// In-memory pending-state fallback (Redis unset), so state + handoff round-trip
// within the process.
jest.unstable_mockModule('../src/utils/redis-client.js', () => ({
  getRedisClient: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));
jest.unstable_mockModule('../src/helpers/client-info.js', () => ({ clientInfoOf: () => ({}) }));
jest.unstable_mockModule('../src/helpers/session-cookie.js', () => ({
  deliverSessionTokens: (_req: unknown, _res: unknown, tokens: unknown) => tokens,
}));

jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  getEnforcedSamlConfig: (...a: unknown[]) => mockGetEnforcedSamlConfig(...a),
  assertSsoIdentityTrusted: (...a: unknown[]) => mockAssertSsoIdentityTrusted(...a),
}));

jest.unstable_mockModule('../src/services/saml-service.js', () => ({
  SAML_ERROR_MAP: {
    SAML_NOT_CONFIGURED: { status: 404, message: 'not configured' },
    SAML_DISABLED: { status: 403, message: 'disabled' },
    SAML_NOT_ENTITLED: { status: 403, message: 'not entitled' },
    SAML_INVALID_STATE: { status: 403, message: 'Invalid or expired SSO state' },
    SAML_IDP_INITIATED: { status: 403, message: 'idp-initiated refused' },
    SAML_REPLAYED_ASSERTION: { status: 403, message: 'already used' },
    SAML_INVALID_ASSERTION: { status: 401, message: 'invalid assertion' },
  },
  buildSamlAuthorizeUrl: (...a: unknown[]) => mockBuildSamlAuthorizeUrl(...a),
  buildSamlMetadata: (...a: unknown[]) => mockBuildMetadata(...a),
  samlLandingUrl: (orgId: string) => `https://pb.test/auth/sso/${orgId}/saml`,
  validateSamlResponse: (...a: unknown[]) => mockValidateSamlResponse(...a),
}));

jest.unstable_mockModule('../src/controllers/saml-slo.js', () => ({
  recordSamlSession: (...a: unknown[]) => mockRecordSamlSession(...a),
}));
jest.unstable_mockModule('../src/controllers/sso-test.js', () => ({
  isTestState: (s: unknown) => typeof s === 'string' && s.startsWith('ssotest.'),
  handleSamlTestAssertion: (...a: unknown[]) => mockHandleTest(...a),
}));
jest.unstable_mockModule('../src/services/org-idp-service.js', () => ({
  orgIdpService: { findByOrg: (...a: unknown[]) => mockFindByOrg(...a) },
}));

jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { findOrCreateOAuthUser: (...a: unknown[]) => mockFindOrCreate(...a) },
}));

jest.unstable_mockModule('../src/services/sso-jit-service.js', () => ({
  assertJitSeatAvailable: (...a: unknown[]) => mockAssertSeat(...a),
  provisionJitMembership: (...a: unknown[]) => mockProvisionJit(...a),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: (...a: unknown[]) => mockFindById(...a) },
}));

jest.unstable_mockModule('../src/utils/token.js', () => ({
  signInAuth: () => ({ amr: ['sso'], aal: 1, authTime: new Date(0) }),
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
}));

jest.unstable_mockModule('../src/utils/validation.js', () => ({
  samlAcsSchema: {},
  samlCompleteSchema: {},
  validateBody: (_schema: unknown, body: any, res: any) => {
    if (body?.SAMLResponse || body?.handoff) return body;
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

const { beginSamlLogin, completeSamlLogin, getSamlMetadata, handleSamlAcs, __resetSamlControllerStores } =
  await import('../src/controllers/saml.js');

const ORG = 'org-1';

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  res.type = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}

/** Mint a real one-time RelayState through the initiate leg. */
async function mintState(orgId = ORG): Promise<string> {
  mockBuildSamlAuthorizeUrl.mockResolvedValue('https://idp.test/sso?SAMLRequest=x');
  const { state } = await beginSamlLogin(orgId);
  return state;
}

/** The handoff the ACS put in its redirect URL. */
function handoffFrom(res: any): string {
  const url: string = (res.redirect as jest.Mock).mock.calls[0][1] as string;
  return new URL(url).searchParams.get('handoff')!;
}

/** The error code the ACS put in its redirect URL. */
function errorFrom(res: any): string {
  const url: string = (res.redirect as jest.Mock).mock.calls[0][1] as string;
  return new URL(url).searchParams.get('error')!;
}

/** Every audited action, in order. */
function auditedActions(): string[] {
  return (mockAudit as jest.Mock).mock.calls.map((c) => c[1] as string);
}

/** The details of the first `sso.saml.refused` row. */
function refusalDetails(): Record<string, unknown> {
  const call = (mockAudit as jest.Mock).mock.calls.find((c) => c[1] === 'sso.saml.refused');
  return (call?.[2] as { details: Record<string, unknown> }).details;
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetSamlControllerStores();
  mockGetEnforcedSamlConfig.mockResolvedValue({ orgId: ORG, entityId: 'https://idp.test', certificates: ['cert'] });
  mockValidateSamlResponse.mockResolvedValue({
    subject: 'ada@acme.test',
    issuer: 'https://idp.test',
    email: 'ada@acme.test',
    name: 'Ada',
    groups: ['Engineering'],
    session: { nameID: 'ada@acme.test', sessionIndex: '_s1' },
  });
  mockRecordSamlSession.mockResolvedValue(undefined);
  mockFindByOrg.mockResolvedValue(null);
  mockBuildMetadata.mockImplementation(async (orgId: unknown) => `<EntityDescriptor entityID="sp-${orgId}"/>`);
  mockAssertSsoIdentityTrusted.mockResolvedValue(undefined);
  mockAssertSeat.mockResolvedValue(undefined);
  mockProvisionJit.mockResolvedValue({ membershipCreated: false, matchedGroups: [], rolesAdded: [], rolesRemoved: [] });
  mockFindOrCreate.mockResolvedValue({ _id: 'user-1' });
  mockIssueTokens.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
  mockFindById.mockReturnValue({ select: async () => ({ _id: 'user-1', isSuperAdmin: false }) });
});

describe('metadata', () => {
  it('serves SP metadata as XML without needing a working configuration', async () => {
    const res = makeRes();
    await (getSamlMetadata as any)({ params: { orgId: ORG } }, res);
    expect(res.type).toHaveBeenCalledWith('application/samlmetadata+xml');
    expect(res.status).toHaveBeenCalledWith(200);
    // No ENFORCED config is needed, so an admin can fetch it before the
    // connection exists (or is enabled) — an unknown org reads as all-off.
    expect(mockGetEnforcedSamlConfig).not.toHaveBeenCalled();
    expect(mockBuildMetadata).toHaveBeenCalledWith(ORG, { signAuthnRequests: false, encryptAssertions: false });
  });

  it('reflects the org\'s signing and encryption switches', async () => {
    mockFindByOrg.mockResolvedValue({ samlSignAuthnRequests: true, samlEncryptAssertions: true });
    await (getSamlMetadata as any)({ params: { orgId: ORG } }, makeRes());
    expect(mockBuildMetadata).toHaveBeenCalledWith(ORG, { signAuthnRequests: true, encryptAssertions: true });
  });
});

describe('ACS — a test-connection assertion', () => {
  it('is handed to the dry-run path and never reaches sign-in logic', async () => {
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: 'ssotest.abc.sig' } }, res);
    expect(mockHandleTest).toHaveBeenCalledWith(res, ORG, 'r', 'ssotest.abc.sig');
    expect(mockValidateSamlResponse).not.toHaveBeenCalled();
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(mockProvisionJit).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });
});

describe('ACS — accepting an assertion', () => {
  it('runs the OIDC checks in order and redirects with a one-time handoff', async () => {
    const state = await mintState();
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, res);

    expect(mockAssertSsoIdentityTrusted).toHaveBeenCalledWith(ORG, expect.objectContaining({ email: 'ada@acme.test' }));
    expect(mockAssertSeat).toHaveBeenCalledWith(ORG, 'ada@acme.test');
    // Issuer-bound linking under the dedicated `saml` provider key.
    expect(mockFindOrCreate).toHaveBeenCalledWith(
      'saml',
      expect.objectContaining({ id: 'ada@acme.test', email: 'ada@acme.test' }),
      { markOnboarding: false, sso: { issuer: 'https://idp.test' } },
    );
    // The ACS itself never mints a session.
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('handoff='));
  });

  it('provisions JIT membership and audits it before any session exists', async () => {
    mockProvisionJit.mockResolvedValue({
      membershipCreated: true, matchedGroups: ['Engineering'], rolesAdded: ['role-1'], rolesRemoved: [],
    });
    const state = await mintState();
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, res);

    expect(mockProvisionJit).toHaveBeenCalledWith({
      orgId: ORG, user: { _id: 'user-1' }, groups: ['Engineering'],
    });
    expect(auditedActions()).toContain('sso.jit.provision');
  });

  it('audits a mapped-role change on a returning member', async () => {
    mockProvisionJit.mockResolvedValue({
      membershipCreated: false, matchedGroups: ['Engineering'], rolesAdded: [], rolesRemoved: ['role-2'],
    });
    const state = await mintState();
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, res);
    expect(auditedActions()).toContain('sso.jit.role.change');
  });

  it('consumes the RelayState once — the same state cannot be used twice', async () => {
    const state = await mintState();
    const first = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, first);
    expect(errorFrom(first)).toBeNull();

    const second = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, second);
    expect(errorFrom(second)).toBe('SAML_INVALID_STATE');
  });

  it('refuses a state minted for another org', async () => {
    const state = await mintState('org-other');
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, res);
    expect(errorFrom(res)).toBe('SAML_INVALID_STATE');
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });
});

describe('ACS — refusals are audited and counted', () => {
  it('refuses an IdP-initiated response (no RelayState) before touching any account', async () => {
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r' } }, res);

    expect(errorFrom(res)).toBe('SAML_IDP_INITIATED');
    expect(mockValidateSamlResponse).not.toHaveBeenCalled();
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(refusalDetails()).toMatchObject({ reason: 'idp_initiated' });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_saml_signins_total', { result: 'idp_initiated' });
  });

  it('refuses a replayed assertion, with its own audit reason', async () => {
    mockValidateSamlResponse.mockRejectedValue(new Error('SAML_REPLAYED_ASSERTION'));
    const state = await mintState();
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, res);

    expect(errorFrom(res)).toBe('SAML_REPLAYED_ASSERTION');
    expect(refusalDetails()).toMatchObject({ reason: 'replay' });
    expect(mockIncCounter).toHaveBeenCalledWith('platform_saml_signins_total', { result: 'replay' });
  });

  it('refuses an identity on a domain the org has not verified — before any account is touched', async () => {
    mockAssertSsoIdentityTrusted.mockRejectedValue(new Error('OIDC_EMAIL_DOMAIN_NOT_VERIFIED'));
    const state = await mintState();
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, res);

    expect(errorFrom(res)).toBe('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(refusalDetails()).toMatchObject({ reason: 'domain_not_verified' });
  });

  it('refuses a platform administrator', async () => {
    mockFindOrCreate.mockRejectedValue(new Error('SSO_SUPERADMIN_REFUSED'));
    const state = await mintState();
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, res);

    expect(errorFrom(res)).toBe('SSO_SUPERADMIN_REFUSED');
    expect(mockProvisionJit).not.toHaveBeenCalled();
    expect(refusalDetails()).toMatchObject({ reason: 'platform_admin' });
  });

  it('refuses the sign-in when the account is at its seat limit', async () => {
    mockAssertSeat.mockRejectedValue(new Error('JIT_SEAT_LIMIT'));
    const state = await mintState();
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, res);

    expect(errorFrom(res)).toBe('JIT_SEAT_LIMIT');
    // No account is created for a sign-in the seat cap is going to refuse.
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(refusalDetails()).toMatchObject({ reason: 'seat_limit' });
  });

  it('does not leak an unexpected internal error code to the browser', async () => {
    mockValidateSamlResponse.mockRejectedValue(new Error('SOME_INTERNAL_THING'));
    const state = await mintState();
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, res);
    expect(errorFrom(res)).toBe('SAML_ERROR');
    expect(refusalDetails()).toMatchObject({ reason: 'error' });
  });
});

describe('completing the sign-in', () => {
  /** Run a full ACS leg and return the handoff it minted. */
  async function acsHandoff(): Promise<string> {
    const state = await mintState();
    const res = makeRes();
    await (handleSamlAcs as any)({ params: { orgId: ORG }, body: { SAMLResponse: 'r', RelayState: state } }, res);
    return handoffFrom(res);
  }

  it('mints an interactive session and audits the login', async () => {
    const handoff = await acsHandoff();
    const res = makeRes();
    await (completeSamlLogin as any)({ params: { orgId: ORG }, body: { handoff } }, res);

    expect(mockIssueTokens).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'user-1' }), ORG, expect.objectContaining({ kind: 'interactive' }),
    );
    expect(auditedActions()).toContain('user.login');
    expect(mockIncCounter).toHaveBeenCalledWith('platform_saml_signins_total', { result: 'success' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('records the IdP session handle for Single Logout against the new session', async () => {
    const handoff = await acsHandoff();
    await (completeSamlLogin as any)({ params: { orgId: ORG }, body: { handoff } }, makeRes());
    expect(mockRecordSamlSession).toHaveBeenCalledWith({
      userId: 'user-1',
      orgId: ORG,
      accessToken: 'a',
      issuer: 'https://idp.test',
      session: { nameID: 'ada@acme.test', sessionIndex: '_s1' },
    });
  });

  it('consumes the handoff once', async () => {
    const handoff = await acsHandoff();
    await (completeSamlLogin as any)({ params: { orgId: ORG }, body: { handoff } }, makeRes());

    const res = makeRes();
    await (completeSamlLogin as any)({ params: { orgId: ORG }, body: { handoff } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('refuses a handoff redeemed against another org', async () => {
    const handoff = await acsHandoff();
    const res = makeRes();
    await (completeSamlLogin as any)({ params: { orgId: 'org-other' }, body: { handoff } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });

  it('re-asserts the platform-admin refusal at redemption', async () => {
    const handoff = await acsHandoff();
    // Promoted between the two legs — the session must still not open.
    mockFindById.mockReturnValue({ select: async () => ({ _id: 'user-1', isSuperAdmin: true }) });
    const res = makeRes();
    await (completeSamlLogin as any)({ params: { orgId: ORG }, body: { handoff } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockIssueTokens).not.toHaveBeenCalled();
  });
});
