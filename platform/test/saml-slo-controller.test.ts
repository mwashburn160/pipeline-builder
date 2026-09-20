// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SAML Single Logout endpoints (controllers/saml-slo.ts). The XML-DSig and
 * replay checks are covered in saml-service.test.ts; this suite pins what the
 * endpoints DO with a verified (or refused) message:
 *   - SP-initiated: only a SAML session whose IdP has an SLO URL gets a
 *     LogoutRequest; the session's SAML record is forgotten either way; a
 *     connection repointed at another IdP gets none;
 *   - IdP-initiated: the matching sessions IN THIS ORG are revoked through the
 *     shared single-session revocation helper, the IdP gets a signed
 *     LogoutResponse (or the browser lands on sign-in), and it is audited;
 *   - a refused message revokes nothing and is audited as a failure;
 *   - a LogoutResponse just lands the browser on the sign-in page;
 *   - the sign-in records the IdP handle against the session's `sid`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockGetCfg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockValidate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockBuildRequestUrl = jest.fn<(...a: unknown[]) => Promise<string>>();
const mockBuildResponseUrl = jest.fn<(...a: unknown[]) => Promise<string>>();
const mockRevoke = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockFindOneAndDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFind = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();
const mockDeleteMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json(data); return res; },
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
}));
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { oauth: { callbackBaseUrl: 'https://pb.test' }, auth: { refreshToken: { expiresIn: 3600 } } },
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_l: string, fn: Function) => async (req: any, res: any) => fn(req, res),
}));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  getSamlConfigForLogout: (...a: unknown[]) => mockGetCfg(...a),
}));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: { revokeRefreshSession: (...a: unknown[]) => mockRevoke(...a) },
}));
jest.unstable_mockModule('../src/services/saml-service.js', () => ({
  SAML_ERROR_MAP: {},
  buildSamlLogoutRequestUrl: (...a: unknown[]) => mockBuildRequestUrl(...a),
  buildSamlLogoutResponseUrl: (...a: unknown[]) => mockBuildResponseUrl(...a),
  samlLandingUrl: (orgId: string) => `https://pb.test/auth/sso/${orgId}/saml`,
  validateSamlLogoutMessage: (...a: unknown[]) => mockValidate(...a),
}));
jest.unstable_mockModule('../src/models/saml-session.js', () => ({
  default: {
    findOneAndDelete: (...a: unknown[]) => ({ lean: () => mockFindOneAndDelete(...a) }),
    find: (...a: unknown[]) => ({ select: () => ({ lean: () => mockFind(...a) }) }),
    deleteMany: (...a: unknown[]) => mockDeleteMany(...a),
    updateOne: (...a: unknown[]) => mockUpdateOne(...a),
  },
}));

const { startSsoLogout, handleSamlSlo, recordSamlSession } = await import('../src/controllers/saml-slo.js');

const ORG = 'org-1';
const CFG = { orgId: ORG, entityId: 'https://idp.test', sloUrl: 'https://idp.test/slo' };

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}
const redirectOf = (res: any) => (res.redirect as jest.Mock).mock.calls[0][1] as string;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCfg.mockResolvedValue(CFG);
  mockBuildRequestUrl.mockResolvedValue('https://idp.test/slo?SAMLRequest=x&Signature=y');
  mockBuildResponseUrl.mockResolvedValue('https://idp.test/slo?SAMLResponse=x&Signature=y');
  mockRevoke.mockResolvedValue(undefined);
  mockDeleteMany.mockResolvedValue({});
  mockUpdateOne.mockResolvedValue({});
});

describe('SP-initiated (POST /auth/sso/logout)', () => {
  const req = { user: { sub: 'u1', sid: 'sess-1' } };

  it('returns a signed LogoutRequest for a SAML session and forgets the record', async () => {
    mockFindOneAndDelete.mockResolvedValue({ orgId: ORG, issuer: 'https://idp.test', nameID: 'ada@acme.test', sessionIndex: '_s1' });
    const res = makeRes();
    await (startSsoLogout as any)(req, res);
    expect(mockFindOneAndDelete).toHaveBeenCalledWith({ userId: 'u1', sessionId: 'sess-1' });
    expect(mockBuildRequestUrl).toHaveBeenCalledWith(CFG, expect.objectContaining({ nameID: 'ada@acme.test', sessionIndex: '_s1' }), '');
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ redirectUrl: 'https://idp.test/slo?SAMLRequest=x&Signature=y' });
    expect(mockAudit).toHaveBeenCalledWith(req, 'sso.saml.logout', expect.objectContaining({ details: { direction: 'sp', stage: 'request' } }));
  });

  it('answers null for a session that was not a SAML sign-in', async () => {
    mockFindOneAndDelete.mockResolvedValue(null);
    const res = makeRes();
    await (startSsoLogout as any)(req, res);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ redirectUrl: null });
    expect(mockBuildRequestUrl).not.toHaveBeenCalled();
  });

  it('answers null when the IdP has no SLO URL, or the connection now points at another IdP', async () => {
    mockFindOneAndDelete.mockResolvedValue({ orgId: ORG, issuer: 'https://idp.test', nameID: 'n' });
    mockGetCfg.mockResolvedValue({ ...CFG, sloUrl: undefined });
    const noSlo = makeRes();
    await (startSsoLogout as any)(req, noSlo);
    expect((noSlo.json as jest.Mock).mock.calls[0][0]).toEqual({ redirectUrl: null });

    mockGetCfg.mockResolvedValue({ ...CFG, entityId: 'https://new-idp.test' });
    const repointed = makeRes();
    await (startSsoLogout as any)(req, repointed);
    expect((repointed.json as jest.Mock).mock.calls[0][0]).toEqual({ redirectUrl: null });
    expect(mockBuildRequestUrl).not.toHaveBeenCalled();
  });
});

describe('IdP-initiated (GET|POST /auth/sso/:orgId/saml/slo)', () => {
  const getReq = (query: Record<string, string>) => ({
    method: 'GET', params: { orgId: ORG }, query, originalUrl: `/auth/sso/${ORG}/saml/slo?SAMLRequest=abc&RelayState=rs&SigAlg=a&Signature=s`,
  });

  it('revokes the matching sessions in this org and answers with a signed LogoutResponse', async () => {
    mockValidate.mockResolvedValue({ kind: 'request', id: '_lr1', session: { nameID: 'ada@acme.test', sessionIndex: '_s1' } });
    mockFind.mockResolvedValue([{ _id: 'r1', userId: 'u1', sessionId: 'sess-1' }]);
    const res = makeRes();
    await (handleSamlSlo as any)(getReq({ SAMLRequest: 'abc', RelayState: 'rs', SigAlg: 'a', Signature: 's' }), res);

    // The redirect binding's signature is checked over the RAW query string.
    expect(mockValidate).toHaveBeenCalledWith(CFG, {
      binding: 'redirect',
      query: { SAMLRequest: 'abc', RelayState: 'rs', SigAlg: 'a', Signature: 's' },
      rawQuery: 'SAMLRequest=abc&RelayState=rs&SigAlg=a&Signature=s',
    });
    expect(mockFind).toHaveBeenCalledWith({ orgId: ORG, issuer: 'https://idp.test', nameID: 'ada@acme.test', sessionIndex: '_s1' });
    expect(mockRevoke).toHaveBeenCalledWith('u1', 'sess-1');
    expect(mockDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['r1'] } });
    expect(mockBuildResponseUrl).toHaveBeenCalledWith(CFG, '_lr1', true, 'rs');
    expect(redirectOf(res)).toBe('https://idp.test/slo?SAMLResponse=x&Signature=y');
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'sso.saml.logout', expect.objectContaining({
      targetId: 'u1', details: expect.objectContaining({ direction: 'idp', sessionsRevoked: 1 }),
    }));
  });

  it('accepts the POST binding too, and lands on sign-in when the IdP has no SLO URL', async () => {
    mockGetCfg.mockResolvedValue({ ...CFG, sloUrl: undefined });
    mockValidate.mockResolvedValue({ kind: 'request', id: '_lr2', session: { nameID: 'ada@acme.test' } });
    mockFind.mockResolvedValue([]);
    const res = makeRes();
    await (handleSamlSlo as any)({ method: 'POST', params: { orgId: ORG }, body: { SAMLRequest: 'xml' }, originalUrl: '/x' }, res);
    expect(mockValidate).toHaveBeenCalledWith(expect.anything(), { binding: 'post', body: { SAMLRequest: 'xml' } });
    // No SessionIndex named → every session of that NameID in this org.
    expect(mockFind).toHaveBeenCalledWith({ orgId: ORG, issuer: 'https://idp.test', nameID: 'ada@acme.test' });
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(redirectOf(res)).toBe('https://pb.test/');
  });

  it('revokes NOTHING for a refused message and audits the failure', async () => {
    mockValidate.mockRejectedValue(new Error('SAML_INVALID_LOGOUT'));
    const res = makeRes();
    await (handleSamlSlo as any)(getReq({ SAMLRequest: 'abc' }), res);
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(redirectOf(res)).toBe(`https://pb.test/auth/sso/${ORG}/saml?error=SAML_INVALID_LOGOUT`);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'sso.saml.logout', expect.objectContaining({
      outcome: 'failure', details: { direction: 'unknown', reason: 'invalid_message' },
    }));
  });

  it('lands a LogoutResponse (answering ours) on the sign-in page', async () => {
    mockValidate.mockResolvedValue({ kind: 'response' });
    const res = makeRes();
    await (handleSamlSlo as any)(getReq({ SAMLResponse: 'abc', SigAlg: 'a', Signature: 's' }), res);
    expect(redirectOf(res)).toBe('https://pb.test/');
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});

describe('recordSamlSession', () => {
  it('stores the IdP handle against the session id carried in the access token', async () => {
    const token = `h.${Buffer.from(JSON.stringify({ sid: 'sess-9' })).toString('base64url')}.s`;
    await recordSamlSession({ userId: 'u1', orgId: ORG, accessToken: token, issuer: 'https://idp.test', session: { nameID: 'n', sessionIndex: '_s' } });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { userId: 'u1', sessionId: 'sess-9' },
      { $set: expect.objectContaining({ orgId: ORG, issuer: 'https://idp.test', nameID: 'n', sessionIndex: '_s', expiresAt: expect.any(Date) }) },
      { upsert: true },
    );
  });

  it('never fails the sign-in when the write fails', async () => {
    mockUpdateOne.mockRejectedValue(new Error('mongo down'));
    const token = `h.${Buffer.from(JSON.stringify({ sid: 'sess-9' })).toString('base64url')}.s`;
    await expect(recordSamlSession({ userId: 'u1', orgId: ORG, accessToken: token, issuer: 'i', session: { nameID: 'n' } })).resolves.toBeUndefined();
  });
});
