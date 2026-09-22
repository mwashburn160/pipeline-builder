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
jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({ headManifest }));
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
