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
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockGetCfg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockValidate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockBuildRequestUrl = jest.fn<(...a: unknown[]) => Promise<string>>();
const mockBuildResponseUrl = jest.fn<(...a: unknown[]) => Promise<string>>();
const mockRevoke = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockFindOneAndDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();
/** Spy on the FILTER only — the rows come from the in-memory store below, which
 *  the bounded revoke loop drains through `deleteMany` (a fixed mockResolvedValue
 *  would make the drain loop spin until its per-request cap). */
const mockFind = jest.fn<(...a: unknown[]) => void>();
interface SamlRow { _id: string; userId: string; sessionId: string }
let samlRows: SamlRow[] = [];
const givenSamlRows = (rows: SamlRow[]) => { samlRows = [...rows]; };
const mockDeleteMany = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json(data); return res; },
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ oauth: { callbackBaseUrl: 'https://pb.test' }, auth: { refreshToken: { expiresIn: 3600 } } }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
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
    find: (...a: unknown[]) => {
      mockFind(...a);
      let take = Number.POSITIVE_INFINITY;
      const q: any = {
        select: () => q,
        limit: (n: number) => { take = n; return q; },
        lean: async () => samlRows.slice(0, take),
      };
      return q;
    },
    deleteMany: (...a: any[]) => {
      const ids: string[] = a[0]?._id?.$in ?? [];
      samlRows = samlRows.filter((r) => !ids.includes(r._id));
      return mockDeleteMany(...a);
    },
    updateOne: (...a: unknown[]) => mockUpdateOne(...a),
  },
}));

const { startSsoLogout, handleSamlSlo } = await import('../src/controllers/saml-slo.js');
const { recordSamlSession } = await import('../src/services/saml-sessions.js');

const ORG = 'org-1';
const CFG = { orgId: ORG, entityId: 'https://idp.test', sloUrl: 'https://idp.test/slo' };

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}
const redirectOf = (res: any) => (res.redirect as jest.Mock<AnyFn>).mock.calls[0][1] as string;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCfg.mockResolvedValue(CFG);
  mockBuildRequestUrl.mockResolvedValue('https://idp.test/slo?SAMLRequest=x&Signature=y');
  mockBuildResponseUrl.mockResolvedValue('https://idp.test/slo?SAMLResponse=x&Signature=y');
  mockRevoke.mockResolvedValue(undefined);
  mockDeleteMany.mockResolvedValue({});
  mockUpdateOne.mockResolvedValue({});
  samlRows = [];
});

describe('SP-initiated (POST /auth/sso/logout)', () => {
  const req = { user: { sub: 'u1', sid: 'sess-1' } };

  it('returns a signed LogoutRequest for a SAML session and forgets the record', async () => {
    mockFindOneAndDelete.mockResolvedValue({ organizationId: ORG, issuer: 'https://idp.test', nameID: 'ada@acme.test', sessionIndex: '_s1' });
    const res = makeRes();
    await (startSsoLogout as any)(req, res);
    expect(mockFindOneAndDelete).toHaveBeenCalledWith({ userId: 'u1', sessionId: 'sess-1' });
    expect(mockBuildRequestUrl).toHaveBeenCalledWith(CFG, expect.objectContaining({ nameID: 'ada@acme.test', sessionIndex: '_s1' }), '');
    expect((res.json as jest.Mock<AnyFn>).mock.calls[0][0]).toEqual({ redirectUrl: 'https://idp.test/slo?SAMLRequest=x&Signature=y' });
    expect(mockAudit).toHaveBeenCalledWith(req, 'sso.saml.logout', expect.objectContaining({ details: { direction: 'sp', stage: 'request' } }));
  });

  it('answers null for a session that was not a SAML sign-in', async () => {
    mockFindOneAndDelete.mockResolvedValue(null);
    const res = makeRes();
    await (startSsoLogout as any)(req, res);
    expect((res.json as jest.Mock<AnyFn>).mock.calls[0][0]).toEqual({ redirectUrl: null });
    expect(mockBuildRequestUrl).not.toHaveBeenCalled();
  });

  it('answers null when the IdP has no SLO URL, or the connection now points at another IdP', async () => {
    mockFindOneAndDelete.mockResolvedValue({ organizationId: ORG, issuer: 'https://idp.test', nameID: 'n' });
    mockGetCfg.mockResolvedValue({ ...CFG, sloUrl: undefined });
    const noSlo = makeRes();
    await (startSsoLogout as any)(req, noSlo);
    expect((noSlo.json as jest.Mock<AnyFn>).mock.calls[0][0]).toEqual({ redirectUrl: null });

    mockGetCfg.mockResolvedValue({ ...CFG, entityId: 'https://new-idp.test' });
    const repointed = makeRes();
    await (startSsoLogout as any)(req, repointed);
    expect((repointed.json as jest.Mock<AnyFn>).mock.calls[0][0]).toEqual({ redirectUrl: null });
    expect(mockBuildRequestUrl).not.toHaveBeenCalled();
  });
});

describe('IdP-initiated (GET|POST /auth/sso/:orgId/saml/slo)', () => {
  const getReq = (query: Record<string, string>) => ({
    method: 'GET', params: { orgId: ORG }, query, originalUrl: `/auth/sso/${ORG}/saml/slo?SAMLRequest=abc&RelayState=rs&SigAlg=a&Signature=s`,
  });

  it('revokes the matching sessions in this org and answers with a signed LogoutResponse', async () => {
    mockValidate.mockResolvedValue({ kind: 'request', id: '_lr1', session: { nameID: 'ada@acme.test', sessionIndex: '_s1' } });
    givenSamlRows([{ _id: 'r1', userId: 'u1', sessionId: 'sess-1' }]);
    const res = makeRes();
    await (handleSamlSlo as any)(getReq({ SAMLRequest: 'abc', RelayState: 'rs', SigAlg: 'a', Signature: 's' }), res);

    // The redirect binding's signature is checked over the RAW query string.
    expect(mockValidate).toHaveBeenCalledWith(CFG, {
      binding: 'redirect',
      query: { SAMLRequest: 'abc', RelayState: 'rs', SigAlg: 'a', Signature: 's' },
      rawQuery: 'SAMLRequest=abc&RelayState=rs&SigAlg=a&Signature=s',
    });
    expect(mockFind).toHaveBeenCalledWith({ organizationId: ORG, issuer: 'https://idp.test', nameID: 'ada@acme.test', sessionIndex: '_s1' });
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
    givenSamlRows([]);
    const res = makeRes();
    await (handleSamlSlo as any)({ method: 'POST', params: { orgId: ORG }, body: { SAMLRequest: 'xml' }, originalUrl: '/x' }, res);
    expect(mockValidate).toHaveBeenCalledWith(expect.anything(), { binding: 'post', body: { SAMLRequest: 'xml' } });
    // No SessionIndex named → every session of that NameID in this org.
    expect(mockFind).toHaveBeenCalledWith({ organizationId: ORG, issuer: 'https://idp.test', nameID: 'ada@acme.test' });
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
      { $set: expect.objectContaining({ organizationId: ORG, issuer: 'https://idp.test', nameID: 'n', sessionIndex: '_s', expiresAt: expect.any(Date) }) },
      { upsert: true },
    );
  });

  it('never fails the sign-in when the write fails', async () => {
    mockUpdateOne.mockRejectedValue(new Error('mongo down'));
    const token = `h.${Buffer.from(JSON.stringify({ sid: 'sess-9' })).toString('base64url')}.s`;
    await expect(recordSamlSession({ userId: 'u1', orgId: ORG, accessToken: token, issuer: 'i', session: { nameID: 'n' } })).resolves.toBeUndefined();
  });
});

/**
 * The SLO endpoint is UNAUTHENTICATED (signature-gated only) and IdP-driven,
 * and a LogoutRequest naming only a NameID matches EVERY session that person
 * has in the org. An unbounded `find()` with serial revokes would let one
 * message pull an arbitrary number of rows into memory and hold the request
 * open for that many sequential writes.
 */
describe('IdP-initiated fan-out is bounded', () => {
  const getReq = () => ({
    method: 'GET', params: { orgId: ORG }, query: { SAMLRequest: 'abc' }, originalUrl: `/auth/sso/${ORG}/saml/slo?SAMLRequest=abc`,
  });
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({
    _id: `r${from + i}`, userId: `u${from + i}`, sessionId: `s${from + i}`,
  }));

  beforeEach(() => {
    mockValidate.mockResolvedValue({ kind: 'request', id: '_lr', session: { nameID: 'ada@acme.test' } });
  });

  it('reads in bounded batches and drains the whole match set', async () => {
    givenSamlRows(rows(250));
    const res = makeRes();
    await (handleSamlSlo as any)(getReq(), res);

    // 100-row batches: 3 reads of rows + 1 that finds nothing left.
    expect(mockFind).toHaveBeenCalledTimes(4);
    expect(mockDeleteMany).toHaveBeenCalledTimes(3);
    expect(mockRevoke).toHaveBeenCalledTimes(250);
    expect(samlRows).toEqual([]);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'sso.saml.logout', expect.objectContaining({
      details: expect.objectContaining({ sessionsRevoked: 250 }),
    }));
  });

  it('stops at the per-request cap and REPORTS it rather than working unbounded', async () => {
    givenSamlRows(rows(1500));
    const res = makeRes();
    await (handleSamlSlo as any)(getReq(), res);

    expect(mockRevoke).toHaveBeenCalledTimes(1000);
    expect(samlRows).toHaveLength(500); // the rest lapse with their refresh window
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'sso.saml.logout', expect.objectContaining({
      details: expect.objectContaining({ sessionsRevoked: 1000, capped: 1000 }),
    }));
  });

  it('deletes the bookkeeping rows only AFTER their sessions are revoked', async () => {
    givenSamlRows(rows(2));
    const order: string[] = [];
    mockRevoke.mockImplementation(async () => { order.push('revoke'); });
    mockDeleteMany.mockImplementation(async () => { order.push('delete'); return {}; });

    await (handleSamlSlo as any)(getReq(), makeRes());

    expect(order).toEqual(['revoke', 'revoke', 'delete']);
  });

  it('does no work at all when nothing matches', async () => {
    givenSamlRows([]);
    await (handleSamlSlo as any)(getReq(), makeRes());
    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
