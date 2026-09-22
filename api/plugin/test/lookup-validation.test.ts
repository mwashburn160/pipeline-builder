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

// The listing half of lookup (plan §3.5); the resolver itself is unit-tested in
// ecosystem-installs.test.ts and pipeline-data's plugin-resolution.test.ts.
const mockResolveListed = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);
const mockShadowed = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);
const mockVerifyListed = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/services/ecosystem/installs.js', () => ({
  resolveListedLookup: mockResolveListed,
  shadowedListing: mockShadowed,
  verifyListedImage: mockVerifyListed,
}));
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
    publisher: z.string().optional(),
    version: z.string().optional(),
    pluginType: z.string().optional(),
    computeType: z.string().optional(),
    isActive: z.union([z.boolean(), z.string()]).optional(),
    isDefault: z.union([z.boolean(), z.string()]).optional(),
    visibility: z.enum(['public', 'private']).optional(),
    id: z.union([z.string(), z.array(z.string())]).optional(),
  }).strict(),
}));

const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
  withRoute: (handler: Function) => async (req: any, res: any) => {
    await handler({ req, res, ctx: { log: jest.fn() }, orgId: 'org-1', userId: 'u-1' });
  },
  incrementQuotaFromCtx: (...a: unknown[]) => mockIncrementQuotaFromCtx(...a),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  pluginImageRepository: (p: { orgId: string; name: string; buildType?: string | null }) => (p.buildType === 'metadata_only' ? null : `${p.orgId === '000000000000000000000001' ? 'system' : `org-${p.orgId}`}/${p.name}`),
  CoreConstants: { CACHE_CONTROL_LIST: 'public, max-age=60', CACHE_CONTROL_DETAIL: 'public, max-age=300' },
  Config: { get: () => ({ host: 'registry', port: 5000, network: '', http: true }) },
  db: { execute: jest.fn().mockResolvedValue({ rows: [] }) },
  withTenantTx: jest.fn((fn: any) => fn({ execute: jest.fn().mockResolvedValue({ rows: [] }) })),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  CoreConstants: { CACHE_CONTROL_LIST: 'public, max-age=60', CACHE_CONTROL_DETAIL: 'public, max-age=300' },
  // Exact `x.y.z[-pre][+build]` is a pin; anything else is a range (mirrors pipeline-data).
  isVersionRange: (spec: string) => !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(spec),
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
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_lookup_refusals_total', { reason: 'signature' });
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

// ---------------------------------------------------------------------------
// Resolution semantics + lifecycle warnings (plugin-ecosystem W0.3/W0.4)
// ---------------------------------------------------------------------------

const { lookupWarnings, resolutionFilter } = await import('../src/routes/read-plugins.js');

describe('resolutionFilter — how a lookup resolves ONE plugin', () => {
  it('always matches the name exactly (trivy never resolves to trivy-scan)', () => {
    expect(resolutionFilter({ name: 'trivy' })).toMatchObject({ name: 'trivy', nameMatch: 'exact' });
    expect(resolutionFilter({ version: '1.0.0' })).not.toHaveProperty('nameMatch');
  });

  it('excludes yanked versions unless pinned exactly (by id or exact version)', () => {
    expect(resolutionFilter({ name: 'trivy' })).toMatchObject({ excludeYanked: true });
    expect(resolutionFilter({ name: 'trivy', version: '^1.2.0' })).toMatchObject({ excludeYanked: true });
    expect(resolutionFilter({ name: 'trivy', version: 'latest' })).toMatchObject({ excludeYanked: true });
    expect(resolutionFilter({ name: 'trivy', version: '1.2.3' })).not.toHaveProperty('excludeYanked');
    expect(resolutionFilter({ name: 'trivy', version: '1.2.3-rc.1' })).not.toHaveProperty('excludeYanked');
    expect(resolutionFilter({ id: 'p1' } as never)).not.toHaveProperty('excludeYanked');
  });
});

describe('lookupWarnings', () => {
  const base = { name: 'trivy', version: '1.0.0' };

  it('is empty for a healthy version', () => {
    expect(lookupWarnings({ ...base, lifecycle: 'production', yankedAt: null, deprecatedAt: null })).toEqual([]);
  });

  it('warns for a deprecated version, with its message', () => {
    expect(lookupWarnings({ ...base, deprecatedAt: new Date(), deprecationMessage: 'Use 2.x' })).toEqual([
      { code: 'PLUGIN_DEPRECATED', message: 'Plugin trivy@1.0.0 is deprecated: Use 2.x.' },
    ]);
    expect(lookupWarnings({ ...base, lifecycle: 'deprecated' })[0]!.message).toBe('Plugin trivy@1.0.0 is deprecated.');
  });

  it('warns for a yanked (pinned) version with the reason', () => {
    const [w] = lookupWarnings({ ...base, lifecycle: 'yanked', yankReason: 'CVE-2026-1' });
    expect(w).toEqual({ code: 'PLUGIN_YANKED', message: expect.stringContaining('is yanked: CVE-2026-1. It resolves only because it is pinned exactly') });
    expect(lookupWarnings({ ...base, yankedAt: '2026-09-01' })[0]!.code).toBe('PLUGIN_YANKED');
  });
});

describe('POST /plugins/lookup — answer carries warnings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolves with the exact-name / not-yanked filter and returns { plugin, warnings }', async () => {
    mockFind.mockResolvedValue({
      id: 'p1',
      orgId: 'org-1',
      name: 'trivy',
      version: '1.0.0',
      buildType: 'metadata_only',
      pluginType: 'CodeBuildStep',
      deprecatedAt: new Date(),
      deprecationMessage: 'Use 2.x',
      keywords: [],
      installCommands: [],
      commands: [],
    });
    const { res } = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy', isDefault: true } } }, res);

    expect(mockFind).toHaveBeenCalledWith({ name: 'trivy', isDefault: true, nameMatch: 'exact', excludeYanked: true }, 'org-1', undefined);
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      plugin: expect.objectContaining({ id: 'p1' }),
      warnings: [{ code: 'PLUGIN_DEPRECATED', message: 'Plugin trivy@1.0.0 is deprecated: Use 2.x.' }],
    });
  });

  it('returns an empty warnings array for a healthy version', async () => {
    mockFind.mockResolvedValue({ id: 'p1', orgId: 'org-1', name: 'trivy', version: '1.0.0', buildType: 'metadata_only', pluginType: 'CodeBuildStep', keywords: [], installCommands: [], commands: [] });
    const { res } = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy' } } }, res);
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({ warnings: [] }));
  });
});

describe('POST /plugins/lookup — listings (plan §3.5, G30)', () => {
  const record = {
    id: 'lv-1',
    source: 'listing',
    publisher: 'acme',
    publisherTier: 'verified',
    name: 'lint',
    version: '1.2.0',
    buildType: 'build_image',
    pluginType: 'CodeBuildStep',
    imageRepository: 'public/acme/lint',
    imageDigest: `sha256:${'a'.repeat(64)}`,
  };
  const resolution = { warnings: [{ code: 'PLUGIN_SECRETS_WITHHELD', message: 'no secrets' }] };
  beforeEach(() => {
    jest.clearAllMocks();
    mockFind.mockResolvedValue(null);
    mockResolveListed.mockResolvedValue(null);
    mockShadowed.mockResolvedValue(null);
    mockVerifyListed.mockResolvedValue(undefined);
  });

  it('resolves a publisher reference ONLY through the listing (own rows never considered)', async () => {
    mockResolveListed.mockResolvedValue({ resolution, record });
    const { res } = makeRes();
    await getLookupHandler()({ body: { filter: { publisher: 'acme', name: 'lint', version: '^1.0.0', isDefault: true } } }, res);
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockResolveListed).toHaveBeenCalledWith({ orgId: 'org-1' }, { publisher: 'acme', name: 'lint', version: '^1.0.0' });
    expect(mockVerifyListed).toHaveBeenCalledWith(resolution);
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { plugin: record, warnings: resolution.warnings });
  });

  it('falls back from the org\'s rows to the Official listing for an unqualified name', async () => {
    mockResolveListed.mockResolvedValue({ resolution: { warnings: [] }, record: { ...record, buildType: 'metadata_only', publisher: 'pipeline-builder' } });
    const { res } = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'lint' } }, user: { parentOrganizationId: 'root-1' } }, res);
    expect(mockFind).toHaveBeenCalled();
    expect(mockResolveListed).toHaveBeenCalledWith({ orgId: 'org-1', rootOrgId: 'root-1' }, { name: 'lint' });
    expect(mockVerifyListed).not.toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({ plugin: expect.objectContaining({ publisher: 'pipeline-builder' }) }));
  });

  it('answers the resolver\'s refusal with its status, code and reason', async () => {
    mockResolveListed.mockResolvedValue({ refused: { status: 403, code: 'PLUGIN_NOT_INSTALLED', message: 'acme/lint is not installed', details: { reason: 'not_installed' } } });
    const { res, status } = makeRes();
    await getLookupHandler()({ body: { filter: { publisher: 'acme', name: 'lint' } } }, res);
    expect(status).toHaveBeenCalledWith(403);
    expect(mockSendError).toHaveBeenCalledWith(res, 403, 'acme/lint is not installed', 'PLUGIN_NOT_INSTALLED', { reason: 'not_installed' });
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_lookup_refusals_total', { reason: 'not_installed' });
  });

  it('counts a yank or policy refusal under its alert-facing reason', async () => {
    mockResolveListed.mockResolvedValue({ refused: { status: 409, code: 'PLUGIN_UNAVAILABLE', message: 'yanked', details: { reason: 'yanked' } } });
    await getLookupHandler()({ body: { filter: { publisher: 'acme', name: 'lint' } } }, makeRes().res);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_lookup_refusals_total', { reason: 'yank' });
    mockResolveListed.mockResolvedValue({ refused: { status: 403, code: 'PLUGIN_BLOCKED_BY_POLICY', message: 'blocked', details: { reason: 'blocked_listing' } } });
    await getLookupHandler()({ body: { filter: { publisher: 'acme', name: 'lint' } } }, makeRes().res);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_lookup_refusals_total', { reason: 'policy' });
  });

  it('answers 404 for an unknown listing, and never tries a listing for an id pin or a nameless filter', async () => {
    const { res, status } = makeRes();
    await getLookupHandler()({ body: { filter: { publisher: 'acme', name: 'nope' } } }, res);
    expect(status).toHaveBeenCalledWith(404);
    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'No listing acme/nope.', 'NOT_FOUND');
    const second = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'nope' } } }, second.res);
    expect(mockSendEntityNotFound).toHaveBeenCalledWith(second.res, 'Plugin');
    mockResolveListed.mockClear();
    await getLookupHandler()({ body: { filter: { id: 'p1' } } }, makeRes().res);
    await getLookupHandler()({ body: { filter: { version: '1.0.0' } } }, makeRes().res);
    expect(mockResolveListed).not.toHaveBeenCalled();
  });

  it('refuses a listed image whose signature or tier annotation does not verify (409)', async () => {
    mockResolveListed.mockResolvedValue({ resolution, record });
    mockVerifyListed.mockRejectedValue(new ImageVerificationError('signed as community/acme, not verified/acme'));
    const { res, status } = makeRes();
    await getLookupHandler()({ body: { filter: { publisher: 'acme', name: 'lint' } } }, res);
    expect(status).toHaveBeenCalledWith(409);
    expect(mockSendError).toHaveBeenCalledWith(res, 409, expect.stringContaining('signed as community'), 'IMAGE_VERIFICATION_FAILED');
    mockVerifyListed.mockRejectedValue(new Error('registry down'));
    await expect(getLookupHandler()({ body: { filter: { publisher: 'acme', name: 'lint' } } }, makeRes().res)).rejects.toThrow('registry down');
  });

  it('answers an own row with its own-namespace imageRepository, warning when it shadows an Official listing', async () => {
    mockFind.mockResolvedValue({ id: 'p1', orgId: 'org-1', name: 'trivy', version: '1.0.0', buildType: 'build_image', pluginType: 'CodeBuildStep', imageDigest: `sha256:${'b'.repeat(64)}`, keywords: [], installCommands: [], commands: [] });
    mockShadowed.mockResolvedValue({ publisher: 'pipeline-builder', name: 'trivy' });
    const { res } = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy' } } }, res);
    expect(mockVerify).toHaveBeenCalledWith(expect.objectContaining({ imageRepository: 'org-org-1/trivy' }), expect.anything());
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      plugin: expect.objectContaining({ source: 'org', publisher: null, imageRepository: 'org-org-1/trivy' }),
      warnings: [expect.objectContaining({ code: 'PLUGIN_SHADOWS_LISTING', message: expect.stringContaining('publisher: pipeline-builder') })],
    });
  });
});
