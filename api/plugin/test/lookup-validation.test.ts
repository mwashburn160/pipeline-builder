// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /plugins/lookup filter validation.
 *
 * Without `PluginFilterSchema` validation, callers could inject internal
 * fields (e.g. `deletedAt`, `orgId`) to peek at soft-deleted plugins or
 * bypass tenant scoping. The route must validate before forwarding the
 * filter to the service layer.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import * as z from 'zod';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFind = jest.fn();
const mockIncrementQuotaFromCtx = jest.fn();
const mockNormalizeArrayFields = jest.fn((p: unknown) => p);
const mockSendBadRequest = jest.fn((res: any, msg: string, code?: string) =>
  res.status(400).json({ message: msg, code }));
const mockSendSuccess = jest.fn((res: any, status: number, data: any) =>
  res.status(status).json({ success: true, statusCode: status, data }));
const mockSendEntityNotFound = jest.fn((res: any) => res.status(404).json({}));
const mockSendError = jest.fn((res: any, status: number, msg: string, code?: string) =>
  res.status(status).json({ message: msg, code }));
const mockVerify = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const mockFetchSbom = jest.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>();
const mockFindById = jest.fn();

class ImageVerificationError extends Error {
  constructor(message: string) { super(message); this.name = 'ImageVerificationError'; }
}

jest.unstable_mockModule('../src/helpers/supply-chain.js', () => ({
  verifyImageSignature: mockVerify,
  fetchImageSbom: mockFetchSbom,
  ImageVerificationError,
}));

jest.unstable_mockModule('../src/services/plugin-service.js', () => ({
  pluginService: { find: mockFind, findFirst: mockFind, findPaginated: jest.fn(), findById: mockFindById },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendBadRequest: mockSendBadRequest,
  sendSuccess: mockSendSuccess,
  sendEntityNotFound: mockSendEntityNotFound,
  sendError: mockSendError,
  sendPaginatedNested: jest.fn((res: any, _k: string, items: any) => res.json({ items })),
  normalizeArrayFields: mockNormalizeArrayFields,
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateQuery: () => ({ ok: true, value: {} }),
  getParam: (p: any, k: string) => p[k],
  // Keep using the real PluginFilterSchema so this test exercises the
  // actual validation surface — that's the whole point of the test.
  PluginFilterSchema: z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    pluginType: z.string().optional(),
    computeType: z.string().optional(),
    isActive: z.union([z.boolean(), z.string()]).optional(),
    isDefault: z.union([z.boolean(), z.string()]).optional(),
    visibility: z.enum(['public', 'private']).optional(),
    id: z.union([z.string(), z.array(z.string())]).optional(),
  }).strict(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: Function) => async (req: any, res: any) => {
    await handler({ req, res, ctx: { log: jest.fn() }, orgId: 'org-1', userId: 'u-1' });
  },
  incrementQuotaFromCtx: (...a: unknown[]) => mockIncrementQuotaFromCtx(...a),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: { CACHE_CONTROL_LIST: 'public, max-age=60', CACHE_CONTROL_DETAIL: 'public, max-age=300' },
  Config: { get: () => ({ host: 'registry', port: 5000, network: '', http: true }) },
  db: { execute: jest.fn().mockResolvedValue({ rows: [] }) },
  withTenantTx: jest.fn((fn: any) => fn({ execute: jest.fn().mockResolvedValue({ rows: [] }) })),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  CoreConstants: { CACHE_CONTROL_LIST: 'public, max-age=60', CACHE_CONTROL_DETAIL: 'public, max-age=300' },
  db: { execute: jest.fn().mockResolvedValue({ rows: [] }) },
  withTenantTx: jest.fn((fn: any) => fn({ execute: jest.fn().mockResolvedValue({ rows: [] }) })),
}));;

const { createReadPluginRoutes } = await import('../src/routes/read-plugins.js');

const stubQuotaService = { increment: jest.fn() } as any;

function getLookupHandler() {
  const router = createReadPluginRoutes(stubQuotaService);
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/lookup' && l.route?.methods?.post,
  );
  // The terminal withRoute handler is the LAST entry in the route stack: each
  // route now carries its permission gate (and, on writes, the `audited(...)`
  // declaration) ahead of it.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  return { res: { status, json, setHeader }, status, json };
}

describe('POST /plugins/lookup — filter validation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when filter is missing', async () => {
    const handler = getLookupHandler();
    const { res, status } = makeRes();
    await handler({ body: {} }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('returns 400 when filter is non-object', async () => {
    const handler = getLookupHandler();
    const { res, status } = makeRes();
    await handler({ body: { filter: 'not-an-object' } }, res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('rejects internal fields like deletedAt (strict whitelist)', async () => {
    const handler = getLookupHandler();
    const { res, status } = makeRes();
    await handler({ body: { filter: { deletedAt: null } } }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('rejects orgId in filter (tenancy boundary)', async () => {
    const handler = getLookupHandler();
    const { res, status } = makeRes();
    await handler({ body: { filter: { orgId: 'OTHER-org' } } }, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('accepts whitelisted fields and returns the plugin', async () => {
    mockFind.mockResolvedValue({ id: 'p1', name: 'mine', keywords: [], installCommands: [], commands: [] });
    const handler = getLookupHandler();
    const { res } = makeRes();
    await handler({ body: { filter: { name: 'mine' } } }, res);
    expect(mockFind).toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      plugin: expect.objectContaining({ id: 'p1' }),
    }));
  });

  it('verifies the image signature of an image-producing plugin before returning it', async () => {
    mockFind.mockResolvedValue({
      id: 'p1',
      name: 'mine',
      orgId: 'org-1',
      buildType: 'build_image',
      pluginType: 'CodeBuildStep',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      keywords: [],
      installCommands: [],
      commands: [],
    });
    const handler = getLookupHandler();
    const { res } = makeRes();
    await handler({ body: { filter: { name: 'mine' } } }, res);
    expect(mockVerify).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), expect.objectContaining({ host: 'registry' }));
    expect(mockSendSuccess).toHaveBeenCalled();
  });

  it('answers 409 IMAGE_VERIFICATION_FAILED when the signature does not verify', async () => {
    mockFind.mockResolvedValue({
      id: 'p1',
      name: 'mine',
      orgId: 'org-1',
      buildType: 'prebuilt',
      pluginType: 'CodeBuildStep',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      keywords: [],
      installCommands: [],
      commands: [],
    });
    mockVerify.mockRejectedValueOnce(new ImageVerificationError('failed signature verification'));
    const handler = getLookupHandler();
    const { res, status } = makeRes();
    await handler({ body: { filter: { name: 'mine' } } }, res);
    expect(status).toHaveBeenCalledWith(409);
    expect(mockSendError).toHaveBeenCalledWith(res, 409, 'failed signature verification', 'IMAGE_VERIFICATION_FAILED');
    expect(mockSendSuccess).not.toHaveBeenCalled();
  });

  it('propagates an infrastructure failure instead of reporting it as a bad signature', async () => {
    mockFind.mockResolvedValue({
      id: 'p1',
      name: 'mine',
      orgId: 'org-1',
      buildType: 'build_image',
      pluginType: 'CodeBuildStep',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      keywords: [],
      installCommands: [],
      commands: [],
    });
    mockVerify.mockRejectedValueOnce(new Error('spawn cosign ENOENT'));
    const handler = getLookupHandler();
    const { res } = makeRes();
    await expect(handler({ body: { filter: { name: 'mine' } } }, res)).rejects.toThrow('spawn cosign ENOENT');
    expect(mockSendError).not.toHaveBeenCalled();
  });

  it.each([
    ['metadata_only', 'CodeBuildStep'],
    ['build_image', 'ManualApprovalStep'],
  ])('skips verification for a plugin with no image (%s / %s)', async (buildType, pluginType) => {
    mockFind.mockResolvedValue({
      id: 'p1',
      name: 'mine',
      orgId: 'org-1',
      buildType,
      pluginType,
      imageDigest: null,
      keywords: [],
      installCommands: [],
      commands: [],
    });
    const handler = getLookupHandler();
    const { res } = makeRes();
    await handler({ body: { filter: { name: 'mine' } } }, res);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalled();
  });

  it('returns 404 when no plugin matches', async () => {
    mockFind.mockResolvedValue(null);
    const handler = getLookupHandler();
    const { res } = makeRes();
    await handler({ body: { filter: { name: 'missing' } } }, res);
    expect(mockSendEntityNotFound).toHaveBeenCalledWith(res, 'Plugin');
  });
});

function getSbomHandler() {
  const router = createReadPluginRoutes(stubQuotaService);
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/:id/sbom' && l.route?.methods?.get,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeDownloadRes() {
  const send = jest.fn();
  const type = jest.fn().mockReturnValue({ send });
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json, type });
  const setHeader = jest.fn();
  return { res: { status, json, setHeader }, status, type, send, setHeader };
}

describe('GET /plugins/:id/sbom', () => {
  beforeEach(() => jest.clearAllMocks());

  const imagePlugin = {
    id: 'p1',
    name: 'foo',
    version: '1.2.3',
    orgId: 'org-1',
    buildType: 'build_image',
    pluginType: 'CodeBuildStep',
    imageDigest: `sha256:${'b'.repeat(64)}`,
  };

  it('downloads the verified SPDX SBOM as an attachment', async () => {
    mockFindById.mockResolvedValue(imagePlugin);
    mockFetchSbom.mockResolvedValue({ spdxVersion: 'SPDX-2.3', name: 'foo' });
    const { res, status, type, send, setHeader } = makeDownloadRes();
    await getSbomHandler()({ params: { id: 'p1' } }, res);
    expect(mockFetchSbom).toHaveBeenCalledWith(imagePlugin, expect.objectContaining({ host: 'registry' }));
    expect(setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="foo-1.2.3.spdx.json"');
    expect(status).toHaveBeenCalledWith(200);
    expect(type).toHaveBeenCalledWith('application/spdx+json');
    expect(JSON.parse(send.mock.calls[0][0] as string)).toEqual({ spdxVersion: 'SPDX-2.3', name: 'foo' });
  });

  it('answers 404 for a plugin with no image', async () => {
    mockFindById.mockResolvedValue({ ...imagePlugin, buildType: 'metadata_only', imageDigest: null });
    const { res, status } = makeDownloadRes();
    await getSbomHandler()({ params: { id: 'p1' } }, res);
    expect(status).toHaveBeenCalledWith(404);
    expect(mockFetchSbom).not.toHaveBeenCalled();
  });

  it('answers 409 IMAGE_VERIFICATION_FAILED when no attestation verifies', async () => {
    mockFindById.mockResolvedValue(imagePlugin);
    mockFetchSbom.mockRejectedValue(new ImageVerificationError('Plugin "foo" has no verified SBOM attestation'));
    const { res, status } = makeDownloadRes();
    await getSbomHandler()({ params: { id: 'p1' } }, res);
    expect(status).toHaveBeenCalledWith(409);
    expect(mockSendError).toHaveBeenCalledWith(res, 409, expect.stringContaining('no verified SBOM'), 'IMAGE_VERIFICATION_FAILED');
  });

  it('answers 404 when the plugin is not visible', async () => {
    mockFindById.mockResolvedValue(null);
    const { res } = makeDownloadRes();
    await getSbomHandler()({ params: { id: 'nope' } }, res);
    expect(mockSendEntityNotFound).toHaveBeenCalledWith(res, 'Plugin');
  });
});
