// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /plugins/inspect and the upload's catalog handling (plugin-ecosystem
 * §3.1a, D19; W0.5 quota snapshot; W0.6 compliance deferral), driven through the
 * real handlers with the real catalog detection, shared validator and job
 * builder. Only I/O (zip parse, storage, queue, DB, compliance) is mocked.
 */

import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-upload-catalog-'));
process.env.PLUGIN_UPLOAD_DIR = uploadDir;

const mockReserveQuota = jest.fn<(...a: any[]) => Promise<any>>();
const mockDecrementQuota = jest.fn();
const mockValidatePlugin = jest.fn<(...a: any[]) => Promise<any>>();
const mockParsePluginZip = jest.fn<(...a: any[]) => Promise<any>>();
const mockDeployVersion = jest.fn<(...a: any[]) => Promise<any>>();
const mockAssertDeployable = jest.fn<(...a: any[]) => Promise<void>>(async () => undefined);
const mockEnqueueBuild = jest.fn<(...a: any[]) => Promise<void>>(async () => undefined);
const mockProducesImage = { value: false };

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  reserveQuota: mockReserveQuota,
  decrementQuota: mockDecrementQuota,
  resolveVisibility: () => 'org',
  createComplianceClient: () => ({ validatePlugin: mockValidatePlugin }),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    requireOrgId: () => pass,
    withTenantContext: () => pass,
    rateLimitByOrg: () => pass,
    withRoute: (handler: Function) => async (req: any, res: any) =>
      handler({ req, res, ctx: { log: jest.fn(), requestId: 'req-1' }, orgId: 'org-1', userId: 'user-1' }),
  };
});

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: () => ({ host: 'registry', port: 5000, network: '', http: true }) },
  CoreConstants: { PLUGIN_MAX_UPLOAD_MB: 1 },
}));
jest.unstable_mockModule('../src/helpers/plugin-spec.js', () => ({
  parsePluginZip: mockParsePluginZip,
  validateBuildArgs: jest.fn(),
  specContractFields: () => ({ requiredMetadata: [], requiredVars: [], metadataTypes: {}, varsTypes: {}, smokeTest: null, networkEgress: [] }),
}));
jest.unstable_mockModule('../src/helpers/build-strategy.js', () => ({
  getBuildStrategy: () => ({ producesImage: mockProducesImage.value }),
}));
jest.unstable_mockModule('../src/queue/connections.js', () => ({ enqueueBuild: mockEnqueueBuild, getOrgTier: jest.fn(async () => 'developer') }));
jest.unstable_mockModule('../src/services/audit.js', () => ({ emitPluginAudit: jest.fn() }));
jest.unstable_mockModule('../src/services/plugin-artifact-storage.js', () => ({
  putPluginArtifact: jest.fn(async () => undefined), deletePluginArtifact: jest.fn(), pluginArtifactKey: () => 'org-1/req-1.zip',
}));
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: { assertDeployable: mockAssertDeployable, deployVersion: mockDeployVersion },
}));

const { createUploadPluginRoutes } = await import('../src/routes/upload-plugin.js');

const sse = { bindStreamOwner: jest.fn(async () => undefined) };
const router = createUploadPluginRoutes({} as any, sse as any);
const handlerFor = (p: string) => {
  const layer = (router.stack as any[]).find((l) => l.route?.path === p && l.route?.methods?.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const upload = handlerFor('/');
const inspect = handlerFor('/inspect');

afterAll(() => fs.rmSync(uploadDir, { recursive: true, force: true }));

function fileReq(body: Record<string, unknown> = {}): { req: any; tempPath: string } {
  const tempPath = path.join(uploadDir, `multer-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tempPath, 'PK');
  return { tempPath, req: { headers: {}, body, user: { sub: 'user-1' }, file: { path: tempPath, originalname: 'p.zip', size: 2 } } };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  return res;
}

/** A parsed zip whose package declares catalog metadata in all three sources. */
function parsed(extractDir: string, spec: Record<string, unknown> = {}, buildType = 'metadata_only') {
  return {
    pluginSpec: { name: 'trivy', version: '1.2.0', commands: ['trivy'], description: 'Scans images. Fast.', category: 'security', keywords: ['cve'], ...spec },
    extractDir,
    dockerfile: 'Dockerfile',
    dockerfileContent: 'FROM alpine\nLABEL org.opencontainers.image.source=https://github.com/acme/trivy org.opencontainers.image.licenses=MIT-0',
    buildType,
    readmeMd: '# Trivy Scanner\n\nThe README paragraph.',
  };
}

const newExtractDir = () => fs.mkdtempSync(path.join(uploadDir, 'extract-'));

beforeEach(() => {
  jest.clearAllMocks();
  mockProducesImage.value = false;
  mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { resetAt: '2026-09-24T00:00:00.000Z', used: 1, limit: 10 } });
  mockValidatePlugin.mockResolvedValue({ blocked: false, violations: [], warnings: [] });
  mockDeployVersion.mockResolvedValue({ id: 'p-1' });
});

describe('POST /plugins/inspect — dry run', () => {
  it('returns every detected field with value, source and error, and stores nothing', async () => {
    const extractDir = newExtractDir();
    mockParsePluginZip.mockResolvedValue(parsed(extractDir, { homepageUrl: undefined, summary: 'x'.repeat(170) }));
    const { req, tempPath } = fileReq();
    const res = mockRes();

    await inspect(req, res);

    const body = res.json.mock.calls[0][0];
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.data.plugin).toEqual({ name: 'trivy', version: '1.2.0', pluginType: 'CodeBuildStep', buildType: 'metadata_only' });
    const fields = Object.fromEntries(body.data.fields.map((f: any) => [f.field, f]));
    expect(fields.displayName).toMatchObject({ value: 'Trivy Scanner', source: 'readme', error: null });
    expect(fields.sourceUrl).toMatchObject({ value: 'https://github.com/acme/trivy', source: 'dockerfile' });
    expect(fields.license).toMatchObject({ value: 'MIT-0', source: 'dockerfile' });
    // An invalid spec summary is shown blank with the reason.
    expect(fields.summary).toMatchObject({ value: null, source: 'spec', error: expect.stringMatching(/160/) });
    // Nothing built, reserved or stored; the upload + extracted files are gone.
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockDeployVersion).not.toHaveBeenCalled();
    expect(mockEnqueueBuild).not.toHaveBeenCalled();
    expect(fs.existsSync(tempPath)).toBe(false);
    expect(fs.existsSync(extractDir)).toBe(false);
  });

  it('400s without a file', async () => {
    const res = mockRes();
    await inspect({ headers: {}, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('cleans up the temp upload when the zip does not parse', async () => {
    mockParsePluginZip.mockRejectedValue(new Error('plugin-spec.yaml file missing in ZIP'));
    const { req, tempPath } = fileReq();
    await expect(inspect(req, mockRes())).rejects.toThrow('missing');
    expect(fs.existsSync(tempPath)).toBe(false);
  });
});

describe('POST /plugins — the optional `metadata` part', () => {
  it('refuses an execution-contract key with 400 before any quota is reserved (G56)', async () => {
    const { req, tempPath } = fileReq({ metadata: JSON.stringify({ commands: ['curl evil | sh'] }) });
    const res = mockRes();

    await upload(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/commands/);
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(fs.existsSync(tempPath)).toBe(false);
  });

  it.each([['{not json'], [JSON.stringify({ homepageUrl: 'http://x.io' })], [JSON.stringify({ bogus: 1 })]])(
    'refuses invalid metadata %s with 400', async (metadata) => {
      const res = mockRes();
      await upload(fileReq({ metadata }).req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockReserveQuota).not.toHaveBeenCalled();
    },
  );

  it('accepts every detected value when the part is absent, with provenance and the quota snapshot', async () => {
    mockParsePluginZip.mockResolvedValue(parsed(newExtractDir()));
    const res = mockRes();

    await upload(fileReq().req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const row = mockDeployVersion.mock.calls[0]![0];
    expect(row).toMatchObject({
      description: 'Scans images. Fast.',
      summary: 'Scans images.',
      displayName: 'Trivy Scanner',
      category: 'security',
      keywords: ['cve'],
      license: 'MIT-0',
      sourceUrl: 'https://github.com/acme/trivy',
      readmeMd: '# Trivy Scanner\n\nThe README paragraph.',
      quotaResetAt: new Date('2026-09-24T00:00:00.000Z'),
      metadataSources: {
        displayName: 'readme',
        summary: 'derived',
        description: 'spec',
        category: 'spec',
        keywords: 'spec',
        license: 'dockerfile',
        sourceUrl: 'dockerfile',
        readme: 'readme',
      },
    });
    expect(row.readmeHtml).toContain('Trivy Scanner');
  });

  it('applies the user edits over the detected values and records them as user', async () => {
    mockParsePluginZip.mockResolvedValue(parsed(newExtractDir()));
    const metadata = JSON.stringify({ description: 'Typed. More.', license: null, category: 'quality' });

    await upload(fileReq({ metadata }).req, mockRes());

    const row = mockDeployVersion.mock.calls[0]![0];
    expect(row).toMatchObject({ description: 'Typed. More.', summary: 'Typed.', license: null, category: 'quality' });
    expect(row.metadataSources).toMatchObject({ description: 'user', license: 'user', category: 'user', summary: 'derived' });
    // Compliance sees the EDITED keywords-derived tags.
    expect(mockValidatePlugin.mock.calls[0]![1]).toMatchObject({ keywords: ['cve'] });
  });
});

describe('POST /plugins — compliance image facts (W0.6)', () => {
  it('a plugin without its own image is checked with its honest image facts, nothing deferred', async () => {
    mockParsePluginZip.mockResolvedValue(parsed(newExtractDir()));
    await upload(fileReq().req, mockRes());
    const [, attrs, , , , action, deferred] = mockValidatePlugin.mock.calls[0]!;
    expect(action).toBe('upload');
    expect(attrs).toMatchObject({ signed: false, scanned: false, packages: [], tags: ['cve'] });
    expect(deferred).toEqual([]);
  });

  it('an image plugin defers every image fact to the post-build check and queues with the snapshot', async () => {
    mockProducesImage.value = true;
    mockParsePluginZip.mockResolvedValue(parsed(newExtractDir(), {}, 'build_image'));
    const res = mockRes();

    await upload(fileReq().req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    const [, attrs, , , , , deferred] = mockValidatePlugin.mock.calls[0]!;
    expect(attrs).toMatchObject({ tags: ['cve'] });
    expect(attrs).not.toHaveProperty('signed');
    expect(deferred).toEqual(['signed', 'scanned', 'vulnCritical', 'vulnHigh', 'vulnMedium', 'vulnLow', 'runAsRoot', 'packages']);
    const job = mockEnqueueBuild.mock.calls[0]![2] as any;
    // JSON-safe on the BullMQ job: the worker converts it to a Date.
    expect(job.pluginRecord.quotaResetAt).toBe('2026-09-24T00:00:00.000Z');
    expect(job.pluginRecord.summary).toBe('Scans images.');
  });
});
