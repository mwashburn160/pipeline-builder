// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SSO setup helpers on the org-admin surface (controllers/org-idp-self.ts):
 *   - GET  /organization/:id/idp/sp-info — the values to register AT the IdP,
 *     computed from SERVER config (never the browser's origin), incl. the OIDC
 *     redirect URI and the SP certificates;
 *   - POST /organization/:id/idp/metadata/import — parse pasted XML, or fetch a
 *     URL through api-core's pinned-connection `safeFetch` (private/loopback
 *     refused, the vetted IP pinned into the socket, redirects refused, byte cap
 *     and timeout enforced), save nothing, audit it.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
interface StubResponse { ok: boolean; status: number; redirected: boolean; headers: Record<string, string>; body: Buffer; text(): string; json<T>(): T }
const stubResponse = (text: string, over: Partial<StubResponse> = {}): StubResponse => ({
  ok: true,
  status: 200,
  redirected: false,
  headers: {},
  body: Buffer.from(text, 'utf8'),
  text: () => text,
  json: <T>() => JSON.parse(text) as T,
  ...over,
});
const mockSafeFetch = jest.fn<(url: string, opts?: Record<string, unknown>) => Promise<StubResponse>>();
const mockParse = jest.fn<(xml: string) => Promise<unknown>>();
const mockRequireOwnOrgSso = jest.fn<(...a: unknown[]) => Promise<boolean>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json(data); return res; },
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
  safeFetch: (url: string, opts?: Record<string, unknown>) => mockSafeFetch(url, opts),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  requireOwnOrgSso: (...a: unknown[]) => mockRequireOwnOrgSso(...a),
}));
jest.unstable_mockModule('../src/controllers/org-idp-ops.js', () => ({
  ORG_IDP_ERROR_MAP: {}, deleteOrgIdp: jest.fn(), patchOrgIdp: jest.fn(), readOrgIdp: jest.fn(), upsertOrgIdp: jest.fn(),
}));
jest.unstable_mockModule('../src/services/oidc-service.js', () => ({
  ssoCallbackUrl: (orgId: string) => `https://pb.public/auth/sso/${orgId}/callback`,
}));
jest.unstable_mockModule('../src/services/saml-service.js', () => ({
  SAML_ERROR_MAP: { SAML_METADATA_INVALID: { status: 400, message: 'bad metadata' } },
  parseIdpMetadata: (xml: string) => mockParse(xml),
  samlAcsUrl: (orgId: string) => `https://pb.public/api/auth/sso/${orgId}/saml/acs`,
  samlSloUrl: (orgId: string) => `https://pb.public/api/auth/sso/${orgId}/saml/slo`,
  samlSpEntityId: (orgId: string) => `https://pb.public/api/auth/sso/${orgId}/saml/metadata`,
}));
jest.unstable_mockModule('../src/services/saml-sp-keys.js', () => ({
  getSamlSpKeys: async () => ({ signing: { certificate: 'SIGN-CERT' }, encryption: { certificate: 'ENC-CERT' } }),
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  idpMetadataImportSchema: {},
  validateBody: (_s: unknown, body: unknown) => body,
}));

const { getOwnOrgIdpSpInfo, importOwnOrgIdpMetadata } = await import('../src/controllers/org-idp-self.js');

const ORG = 'org-1';
const USER = { sub: 'admin-1' };
const PARSED = { entityId: 'https://idp.test', ssoUrl: 'https://idp.test/sso', certificates: ['PEM'], wantsSignedRequests: false };

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const body = (res: any) => (res.json as jest.Mock<AnyFn>).mock.calls[0][0] as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireOwnOrgSso.mockResolvedValue(true);
  mockSafeFetch.mockResolvedValue(stubResponse('<EntityDescriptor/>'));
  mockParse.mockResolvedValue(PARSED);
});

describe('GET sp-info', () => {
  it('returns every value to register at the IdP, from SERVER config', async () => {
    const res = makeRes();
    await (getOwnOrgIdpSpInfo as any)({ params: { id: ORG }, user: USER }, res);
    expect(body(res)).toEqual({
      sp: {
        entityId: `https://pb.public/api/auth/sso/${ORG}/saml/metadata`,
        acsUrl: `https://pb.public/api/auth/sso/${ORG}/saml/acs`,
        metadataUrl: `https://pb.public/api/auth/sso/${ORG}/saml/metadata`,
        sloUrl: `https://pb.public/api/auth/sso/${ORG}/saml/slo`,
        oidcRedirectUri: `https://pb.public/auth/sso/${ORG}/callback`,
        signingCertificate: 'SIGN-CERT',
        encryptionCertificate: 'ENC-CERT',
      },
    });
  });

  it('is gated on own-org + sso entitlement', async () => {
    mockRequireOwnOrgSso.mockResolvedValue(false);
    const res = makeRes();
    await (getOwnOrgIdpSpInfo as any)({ params: { id: ORG }, user: USER }, res);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('POST metadata/import', () => {
  it('parses pasted XML without any network call, and audits the import', async () => {
    const res = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { xml: '<EntityDescriptor/>' } }, res);
    expect(mockParse).toHaveBeenCalledWith('<EntityDescriptor/>');
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(body(res)).toEqual({ metadata: PARSED });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.idp.metadata.import', expect.objectContaining({
      details: expect.objectContaining({ source: 'xml', entityId: 'https://idp.test' }),
    }));
  });

  it('fetches a URL through safeFetch, passing the byte cap and the timeout', async () => {
    const res = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { url: 'https://idp.test/metadata' } }, res);
    expect(mockSafeFetch).toHaveBeenCalledWith('https://idp.test/metadata', expect.objectContaining({
      timeoutMs: expect.any(Number),
      maxResponseBytes: expect.any(Number),
    }));
    expect(mockParse).toHaveBeenCalledWith('<EntityDescriptor/>');
    expect(mockAudit.mock.calls[0][2]).toMatchObject({ details: { source: 'url', host: 'idp.test' } });
  });

  it('refuses a URL the SSRF guard rejects', async () => {
    mockSafeFetch.mockRejectedValue(new Error('url resolves to a private address'));
    const res = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { url: 'https://internal.test/md' } }, res);
    // 502 IS the SAML_METADATA_FETCH_FAILED mapping (METADATA_ERROR_MAP); the
    // response body shape belongs to the shared error helper, not to this test.
    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('refuses a redirect (it could pivot to an internal host)', async () => {
    mockSafeFetch.mockResolvedValue(stubResponse('', { ok: false, status: 302, redirected: true }));
    const res = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { url: 'https://idp.test/md' } }, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('refuses a body over the size cap (safeFetch throws before any parse)', async () => {
    mockSafeFetch.mockRejectedValue(new Error('Response body exceeds 524288 bytes'));
    const res = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { url: 'https://idp.test/md' } }, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('surfaces an unusable document as SAML_METADATA_INVALID', async () => {
    mockParse.mockRejectedValue(new Error('SAML_METADATA_INVALID'));
    const res = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { xml: '<foo/>' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
