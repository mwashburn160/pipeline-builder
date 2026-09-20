// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SSO setup helpers on the org-admin surface (controllers/org-idp-self.ts):
 *   - GET  /organization/:id/idp/sp-info — the values to register AT the IdP,
 *     computed from SERVER config (never the browser's origin), incl. the OIDC
 *     redirect URI and the SP certificates;
 *   - POST /organization/:id/idp/metadata/import — parse pasted XML, or fetch a
 *     URL under the shared SSRF guard (private/loopback refused, redirects
 *     refused, byte cap enforced while streaming), save nothing, audit it.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockAssertSafeUrl = jest.fn<(url: string) => Promise<void>>();
const mockParse = jest.fn<(xml: string) => Promise<unknown>>();
const mockRequireOwnOrgSso = jest.fn<(...a: unknown[]) => Promise<boolean>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: any, status: number, data: unknown) => { res.status(status).json(data); return res; },
  getParam: (params: Record<string, unknown>, key: string) => params?.[key],
  assertSafeUrl: (url: string) => mockAssertSafeUrl(url),
  isRefusedRedirect: (r: { type?: string; status: number }) => r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400),
  SSRF_FETCH_INIT: { redirect: 'manual' },
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireAuth: (req: any) => !!req.user,
  withController: (_label: string, fn: Function, errorMap?: Record<string, { status: number; message: string }>) =>
    async (req: any, res: any) => {
      try { return await fn(req, res); } catch (e: any) {
        const mapped = errorMap?.[e?.message];
        if (mapped) return res.status(mapped.status).json({ success: false, code: e.message });
        return res.status(500).json({ success: false, message: e?.message });
      }
    },
}));
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
const body = (res: any) => (res.json as jest.Mock).mock.calls[0][0] as any;

/** A fetch Response whose body streams `chunks`. */
function streamed(chunks: string[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: init.status ?? 200, headers: init.headers });
}

let fetchSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  jest.clearAllMocks();
  mockRequireOwnOrgSso.mockResolvedValue(true);
  mockAssertSafeUrl.mockResolvedValue(undefined);
  mockParse.mockResolvedValue(PARSED);
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});
afterEach(() => fetchSpy.mockRestore());

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
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(body(res)).toEqual({ metadata: PARSED });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.idp.metadata.import', expect.objectContaining({
      details: expect.objectContaining({ source: 'xml', entityId: 'https://idp.test' }),
    }));
  });

  it('fetches a URL through the SSRF guard with redirects disabled and a timeout', async () => {
    fetchSpy.mockResolvedValue(streamed(['<Entity', 'Descriptor/>']));
    const res = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { url: 'https://idp.test/metadata' } }, res);
    expect(mockAssertSafeUrl).toHaveBeenCalledWith('https://idp.test/metadata');
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeDefined();
    expect(mockParse).toHaveBeenCalledWith('<EntityDescriptor/>');
    expect(mockAudit.mock.calls[0][2]).toMatchObject({ details: { source: 'url', host: 'idp.test' } });
  });

  it('refuses a URL the SSRF guard rejects — nothing is fetched', async () => {
    mockAssertSafeUrl.mockRejectedValue(new Error('url resolves to a private address'));
    const res = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { url: 'https://internal.test/md' } }, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(body(res).code).toBe('SAML_METADATA_FETCH_FAILED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a redirect (it could pivot to an internal host)', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    const res = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { url: 'https://idp.test/md' } }, res);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('refuses a body over the size cap — declared or streamed', async () => {
    fetchSpy.mockResolvedValue(streamed(['x'], { headers: { 'content-length': String(10 * 1024 * 1024) } }));
    const declared = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { url: 'https://idp.test/md' } }, declared);
    expect(declared.status).toHaveBeenCalledWith(502);

    const big = 'y'.repeat(300 * 1024);
    fetchSpy.mockResolvedValue(streamed([big, big]));
    const streamedRes = makeRes();
    await (importOwnOrgIdpMetadata as any)({ params: { id: ORG }, user: USER, body: { url: 'https://idp.test/md' } }, streamedRes);
    expect(streamedRes.status).toHaveBeenCalledWith(502);
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
