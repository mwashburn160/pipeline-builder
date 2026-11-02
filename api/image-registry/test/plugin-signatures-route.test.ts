// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route tests for `POST /internal/plugin-signatures` — plugin → sign a pushed
 * plugin image digest and attach its SBOM. The signing service and registry
 * client are mocked; the router runs on a real Express app over HTTP so the
 * route's own body parser, validation, org binding and audit are exercised.
 * The caller allow-list itself is pinned by route-coverage.test.ts.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { jest, beforeAll, afterAll, beforeEach, describe, it, expect } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { registryClientMock } from './helpers/registry-client-mock.js';

const headManifest = jest.fn<(name: string, ref: string) => Promise<{ digest: string } | null>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ digest: string }>>();
const deleteManifest = jest.fn<(name: string, digest: string) => Promise<void>>();
jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({ headManifest, getManifest, deleteManifest }));
// The internal router also mounts the public/* publication routes; they have
// their own coverage (route-coverage + their own suite), so stub them out here.
jest.unstable_mockModule('../src/routes/internal-publications.js', () => ({
  registerPublicationRoutes: () => undefined,
  PLUGIN_PUBLICATIONS_PATH: '/plugin-publications',
}));

class PluginSigningError extends Error {}
const signPluginImage = jest.fn<(p: unknown) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/services/plugin-signing.js', () => ({
  signPluginImage,
  PluginSigningError,
}));

// The quarantine delete hook (DELETE /internal/quarantine/:submissionId) is
// exercised below against a stubbed registry-gc (its own suite covers the walk).
const deleteQuarantineRepository = jest.fn<(repo: string, reason: string) => Promise<{ repository: string; deleted: number }>>();
jest.unstable_mockModule('../src/services/registry-gc.js', () => ({
  deleteQuarantineRepository,
}));

const recordAuditMock = jest.fn<AnyFn>();
const recordAuthzDenialMock = jest.fn<AnyFn>();

const mintQuarantineCredential = jest.fn<(id: string, ttl: number) => Promise<{ username: string; password: string; expiresAt: string }>>();
jest.unstable_mockModule('../src/services/quarantine-credential.js', () => ({
  mintQuarantineCredential,
  isQuarantineSubmissionId: (id: string) => /^[a-z0-9-]{1,128}$/.test(id),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
    const ctx = { log: jest.fn<AnyFn>(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx });
    } catch (err) {
      const r = res as { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void } };
      if (!r.headersSent) r.status(500).json({ success: false, message: (err as Error)?.message });
    }
  },
}));

type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: recordAuditMock,
  recordAuthzDenial: recordAuthzDenialMock,
  sendSuccess: (res: Res, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  sendBadRequest: (res: Res, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  sendError: (res: Res, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  // The allow-list is asserted by route-coverage; here the stub user IS the plugin service.
  requireInternalService: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  audited: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  actorId: () => 'system',
}));

const express = (await import('express')).default;
const { createInternalRoutes } = await import('../src/routes/internal.js');

const ORG = '6650f0c3a1b2c3d4e5f60718';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const SBOM = { spdxVersion: 'SPDX-2.3', name: 'foo', packages: [] };

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  // Stand-in for requireAuth: a plugin service token for the org in the header.
  app.use((req, _res, next) => {
    (req as { user?: unknown }).user = {
      principalType: 'service', serviceName: 'plugin', organizationId: req.header('x-test-org') ?? ORG,
    };
    next();
  });
  app.use('/internal', createInternalRoutes());
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  headManifest.mockResolvedValue({ digest: DIGEST });
});

const post = async (body: unknown, org?: string) => {
  const res = await fetch(`${baseUrl}/internal/plugin-signatures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(org ? { 'x-test-org': org } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('POST /internal/plugin-signatures', () => {
  it('signs the digest, attaches the SBOM and audits it', async () => {
    const { status, body } = await post({ repository: `org-${ORG}/foo`, digest: DIGEST, sbom: SBOM });
    expect(status).toBe(200);
    expect(body.data).toEqual({ repository: `org-${ORG}/foo`, digest: DIGEST, signed: true });
    expect(headManifest).toHaveBeenCalledWith(`org-${ORG}/foo`, DIGEST);
    expect(signPluginImage).toHaveBeenCalledWith({ repository: `org-${ORG}/foo`, digest: DIGEST, sbom: SBOM });
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.image.sign',
      affectedOrgId: ORG,
      targetId: `org-${ORG}/foo`,
      details: expect.objectContaining({ digest: DIGEST }),
    }));
  });

  it('lets the system org get system/* images signed', async () => {
    const { status } = await post({ repository: 'system/trivy', digest: DIGEST, sbom: SBOM }, '000000000000000000000001');
    expect(status).toBe(200);
  });

  it('refuses to sign another org\'s image', async () => {
    const { status, body } = await post({ repository: 'org-deadbeefdeadbeefdeadbeef/foo', digest: DIGEST, sbom: SBOM });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
    expect(signPluginImage).not.toHaveBeenCalled();
  });

  it('refuses a tenant asking for a system/* signature', async () => {
    const { status } = await post({ repository: 'system/trivy', digest: DIGEST, sbom: SBOM });
    expect(status).toBe(403);
  });

  it('refuses a digest that is not in the repository', async () => {
    headManifest.mockResolvedValue(null);
    const { status } = await post({ repository: `org-${ORG}/foo`, digest: DIGEST, sbom: SBOM });
    expect(status).toBe(404);
    expect(signPluginImage).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-plugin repository', { repository: 'library/base', digest: DIGEST, sbom: SBOM }],
    ['a tag instead of a digest', { repository: `org-${ORG}/foo`, digest: '1.0.0', sbom: SBOM }],
    ['a missing SBOM', { repository: `org-${ORG}/foo`, digest: DIGEST }],
    ['a non-SPDX SBOM', { repository: `org-${ORG}/foo`, digest: DIGEST, sbom: { bomFormat: 'CycloneDX' } }],
  ])('rejects %s', async (_label, body) => {
    const { status } = await post(body);
    expect(status).toBe(400);
    expect(signPluginImage).not.toHaveBeenCalled();
  });

  it('accepts an SBOM larger than the app-wide 1mb JSON limit', async () => {
    const big = { ...SBOM, packages: Array.from({ length: 20000 }, (_, i) => ({ SPDXID: `SPDXRef-${i}`, name: `pkg-${i}`, versionInfo: '1.0.0' })) };
    expect(JSON.stringify(big).length).toBeGreaterThan(1024 * 1024);
    const { status } = await post({ repository: `org-${ORG}/foo`, digest: DIGEST, sbom: big });
    expect(status).toBe(200);
  });

  it('signs an anonymous submission\'s quarantine/<id> image only for a system-org token', async () => {
    const repo = 'quarantine/0f3a2b1c-aaaa-4bbb-8ccc-123456789abc';
    expect((await post({ repository: repo, digest: DIGEST, sbom: SBOM }, '000000000000000000000001')).status).toBe(200);
    expect(signPluginImage).toHaveBeenCalledWith({ repository: repo, digest: DIGEST, sbom: SBOM });
    signPluginImage.mockClear();
    const tenant = await post({ repository: repo, digest: DIGEST, sbom: SBOM });
    expect(tenant.status).toBe(403);
    expect(signPluginImage).not.toHaveBeenCalled();
  });

  it('rejects a malformed quarantine repository (nested path / uppercase)', async () => {
    const { status } = await post({ repository: 'quarantine/Abc.def', digest: DIGEST, sbom: SBOM }, '000000000000000000000001');
    expect(status).toBe(400);
  });

  it('maps a signing failure to 502 and audits nothing', async () => {
    signPluginImage.mockRejectedValueOnce(new PluginSigningError('cosign sign failed: no such key'));
    const { status, body } = await post({ repository: `org-${ORG}/foo`, digest: DIGEST, sbom: SBOM });
    expect(status).toBe(502);
    expect(body.message).toMatch(/cosign sign failed/);
    expect(recordAuditMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /internal/quarantine/:submissionId', () => {
  const SYSTEM_ORG = '000000000000000000000001';
  const ID = '0f3a2b1c-aaaa-4bbb-8ccc-123456789abc';
  const del = async (id: string, org = SYSTEM_ORG) => {
    const res = await fetch(`${baseUrl}/internal/quarantine/${id}`, { method: 'DELETE', headers: { 'x-test-org': org } });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  it('deletes every manifest in quarantine/<id> and audits the prune as registry.gc', async () => {
    deleteQuarantineRepository.mockResolvedValue({ repository: `quarantine/${ID}`, deleted: 3 });
    const { status, body } = await del(ID);
    expect(status).toBe(200);
    expect(body.data).toEqual({ repository: `quarantine/${ID}`, deleted: 3 });
    expect(deleteQuarantineRepository).toHaveBeenCalledWith(`quarantine/${ID}`, 'requested');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.gc', targetId: `quarantine/${ID}`, affectedOrgId: SYSTEM_ORG,
    }));
  });

  it('is idempotent: an already-gone repo answers deleted: 0 and audits nothing', async () => {
    deleteQuarantineRepository.mockResolvedValue({ repository: `quarantine/${ID}`, deleted: 0 });
    const { status, body } = await del(ID);
    expect(status).toBe(200);
    expect(body.data).toEqual({ repository: `quarantine/${ID}`, deleted: 0 });
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it('refuses a token minted for a tenant org (moderation state is the system org\'s)', async () => {
    const { status, body } = await del(ID, ORG);
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
    expect(deleteQuarantineRepository).not.toHaveBeenCalled();
  });

  it.each([['uppercase', 'ABC'], ['a dot', 'a.b'], ['an overlong id', 'a'.repeat(129)]])('rejects %s as the submission id', async (_l, id) => {
    const { status } = await del(id);
    expect(status).toBe(400);
    expect(deleteQuarantineRepository).not.toHaveBeenCalled();
  });
});

describe('POST /internal/plugin-images/discard', () => {
  const HEX = 'a'.repeat(64);
  const notFound = () => Object.assign(new Error('404'), { response: { status: 404 } });
  const discard = async (body: unknown, org?: string) => {
    const res = await fetch(`${baseUrl}/internal/plugin-images/discard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(org ? { 'x-test-org': org } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  beforeEach(() => {
    // A companion tag resolves to its own (signature / attestation) manifest.
    getManifest.mockImplementation(async (_repo, ref) => ({ digest: `sha256:${(ref.endsWith('.sig') ? 'c' : 'd').repeat(64)}` }));
    deleteManifest.mockResolvedValue(undefined);
  });

  it('deletes the signature, the attestation and the manifest, and audits it as registry.image.delete', async () => {
    const { status, body } = await discard({ repository: `org-${ORG}/foo`, digest: DIGEST });
    expect(status).toBe(200);
    expect(body.data).toEqual({ repository: `org-${ORG}/foo`, digest: DIGEST, deleted: 3 });
    expect(getManifest.mock.calls.map((c) => c[1])).toEqual([`sha256-${HEX}.sig`, `sha256-${HEX}.att`]);
    // Companions before the image, the image last.
    expect(deleteManifest.mock.calls.at(-1)).toEqual([`org-${ORG}/foo`, DIGEST]);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.image.delete',
      affectedOrgId: ORG,
      targetId: `org-${ORG}/foo`,
      details: expect.objectContaining({ scope: 'refused-build', digest: DIGEST, manifestsDeleted: 3 }),
    }));
  });

  it('is idempotent: everything already gone answers deleted: 0 and audits nothing', async () => {
    getManifest.mockRejectedValue(notFound());
    deleteManifest.mockRejectedValue(notFound());
    const { status, body } = await discard({ repository: `org-${ORG}/foo`, digest: DIGEST });
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ deleted: 0 });
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it('refuses another org\'s image, and puts the attempt on the authz.denied trail', async () => {
    const { status, body } = await discard({ repository: 'org-deadbeefdeadbeefdeadbeef/foo', digest: DIGEST });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
    expect(deleteManifest).not.toHaveBeenCalled();
    expect(recordAuthzDenialMock).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('registry.image.delete'));
  });

  it('records WHY and WHOSE from the plugin service\'s context (refusal, version, job, request, user)', async () => {
    await discard({
      repository: `org-${ORG}/foo`,
      digest: DIGEST,
      context: { refusalCode: 'PLUGIN_VULN_GATE', pluginVersion: '1.0.0', jobId: 'j-1', requestId: 'r-1', userId: 'u-1', extra: 'dropped' },
    });
    const e = recordAuditMock.mock.calls.at(-1)![0] as Record<string, any>;
    expect(e.details).toMatchObject({ scope: 'refused-build', refusalCode: 'PLUGIN_VULN_GATE', pluginVersion: '1.0.0', jobId: 'j-1', requestId: 'r-1' });
    expect(e.details.extra).toBeUndefined();
  });

  it('records a lapsed kept setup image under its own scope, with the reason and the row id', async () => {
    await discard({ repository: `org-${ORG}/foo`, digest: DIGEST, context: { scope: 'kept-setup-image', reason: 'expired', keptSetupImageId: 'k-1', refusalCode: 'x'.repeat(200) } });
    const e = recordAuditMock.mock.calls.at(-1)![0] as Record<string, any>;
    // An oversized value is dropped, not truncated.
    expect(e.details).toMatchObject({ scope: 'kept-setup-image', reason: 'expired', keptSetupImageId: 'k-1', refusalCode: null, jobId: null });
  });

  it('ignores a context that is not an object', async () => {
    await discard({ repository: `org-${ORG}/foo`, digest: DIGEST, context: ['nope'] });
    const e = recordAuditMock.mock.calls.at(-1)![0] as Record<string, any>;
    expect(e.details).toMatchObject({ scope: 'refused-build', refusalCode: null });
  });

  it.each([
    ['the append-only public namespace', { repository: 'public/acme/foo', digest: DIGEST }],
    ['a quarantine repository (it has its own lifecycle)', { repository: 'quarantine/0f3a2b1c-aaaa-4bbb-8ccc-123456789abc', digest: DIGEST }],
    ['a non-plugin repository', { repository: 'library/base', digest: DIGEST }],
    ['a tag instead of a digest', { repository: `org-${ORG}/foo`, digest: '1.0.0' }],
  ])('rejects %s', async (_label, body) => {
    const { status } = await discard(body, '000000000000000000000001');
    expect(status).toBe(400);
    expect(deleteManifest).not.toHaveBeenCalled();
  });
});

describe('POST /internal/quarantine/:submissionId/credential', () => {
  const SYSTEM_ORG = '000000000000000000000001';
  const mint = async (id: string, org = SYSTEM_ORG) => {
    const res = await fetch(`${baseUrl}/internal/quarantine/${id}/credential`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-org': org }, body: JSON.stringify({ ttlSeconds: 600 }),
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  it('mints the credential and audits the grant — expiry and TTL, never the secret', async () => {
    mintQuarantineCredential.mockResolvedValue({ username: 'q', password: 'SECRET', expiresAt: '2026-01-01T00:00:00Z' });
    const { status } = await mint('sub-1');
    expect(status).toBe(200);
    const e = recordAuditMock.mock.calls.at(-1)![0] as Record<string, any>;
    expect(e).toMatchObject({ action: 'registry.quarantine.credential.mint', orgId: SYSTEM_ORG, targetId: 'quarantine/sub-1', details: { expiresAt: '2026-01-01T00:00:00Z', ttlSeconds: expect.any(Number) } });
    expect(JSON.stringify(e)).not.toContain('SECRET');
  });

  it('refuses a tenant-org token and records the denial', async () => {
    const { status, body } = await mint('sub-1', ORG);
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
    expect(mintQuarantineCredential).not.toHaveBeenCalled();
    expect(recordAuthzDenialMock).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('credential.mint'));
  });
});
