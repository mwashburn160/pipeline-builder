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
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import * as z from 'zod';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFind = jest.fn<AnyFn>();
const mockNormalizeArrayFields = jest.fn((p: unknown) => p);
const mockSendBadRequest = jest.fn((res: any, msg: string, code?: string) =>
  res.status(400).json({ message: msg, code }));
const mockSendSuccess = jest.fn((res: any, status: number, data: any) =>
  res.status(status).json({ success: true, statusCode: status, data }));
const mockSendEntityNotFound = jest.fn((res: any, ..._rest: unknown[]) => res.status(404).json({}));
const mockSendError = jest.fn((res: any, status: number, msg: string, code?: string, ..._rest: unknown[]) =>
  res.status(status).json({ message: msg, code }));
const mockVerify = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
const mockFetchSbom = jest.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>();
const mockFindById = jest.fn<AnyFn>();

class ImageVerificationError extends Error {
  constructor(message: string) { super(message); this.name = 'ImageVerificationError'; }
}

// The listing half of lookup; the resolver itself is unit-tested in
// ecosystem-installs.test.ts and pipeline-data's plugin-resolution.test.ts.
const mockResolveListed = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);
const mockShadowed = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);
const mockVerifyListed = jest.fn<(...a: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/services/ecosystem/lookup.js', () => ({
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
  pluginService: { find: mockFind, findFirst: mockFind, findPaginated: jest.fn<AnyFn>(), findById: mockFindById },
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

const mockIncCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: (...a: unknown[]) => mockIncCounter(...a),
  withRoute: (handler: Function) => async (req: any, res: any) => {
    await handler({ req, res, ctx: { log: jest.fn<AnyFn>() }, orgId: 'org-1', userId: 'u-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  pluginImageRepository: (p: { orgId: string; name: string; buildType?: string | null }) => (p.buildType === 'metadata_only' ? null : `${p.orgId === '000000000000000000000001' ? 'system' : `org-${p.orgId}`}/${p.name}`),
  CoreConstants: { CACHE_CONTROL_LIST: 'public, max-age=60', CACHE_CONTROL_DETAIL: 'public, max-age=300' },
  Config: { get: () => ({ host: 'registry', port: 5000, network: '', http: true }) },
}));
let currentPolicy: { warnFixableHigh: number | null } = { warnFixableHigh: 0 };
// The lookup's per-org consumption policy comes from the install-policy rows;
// none here, so the defaults apply.
jest.unstable_mockModule('../src/services/ecosystem/installs-store.js', () => ({
  listingSource: { policiesForOrgs: async () => [] },
}));
// What a 404 says became of the org row (deleted / inactive / yanked / missing).
let rowState = 'missing';
jest.unstable_mockModule('../src/services/plugin-row-state.js', () => ({ pluginRowState: async () => rowState }));
const mockNotifyVulnerable = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/services/plugin-security-notifications.js', () => ({ notifyPipelineVulnerable: mockNotifyVulnerable }));
const mockRecordStepLookup = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  // The lookup's consumption-policy read (lookup-vuln-policy.ts): default policy.
  effectiveConsumptionPolicy: () => currentPolicy,
  compareSemver: (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }),
  recordStepLookup: (...a: unknown[]) => mockRecordStepLookup(...a),
  activeAcceptances: async () => ({ byKey: new Map(), versionsByPlugin: new Map() }),
  acceptanceKey: (n: string, v: string, d?: string | null) => `${n}@${v}@${d ?? ''}`,
  executeRows: async () => [{ id: '11111111-1111-1111-1111-111111111111', pipeline_name: 'web' }],
  vulnUpgradeAvailableWarning: (ref: string, resolved: string, suggested: string) => ({ code: 'VULN_UPGRADE_AVAILABLE', severity: 'info', message: `${ref}@${resolved} → ${suggested}`, resolved, suggestedVersion: suggested }),
  scopeOrgIds: (s: { orgId: string }) => [s.orgId],
  // Exact `x.y.z[-pre][+build]` is a pin; anything else is a range (mirrors pipeline-data).
  isVersionRange: (spec: string) => !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(spec),
  db: { execute: jest.fn<AnyFn>().mockResolvedValue({ rows: [] }) },
  withTenantTx: jest.fn((fn: any) => fn({ execute: jest.fn<AnyFn>().mockResolvedValue({ rows: [] }) })),
}));;

const { createReadPluginRoutes } = await import('../src/routes/read-plugins.js');
const { setVulnPolicyComplianceClientForTests } = await import('@pipeline-builder/api-core');

// The org's compliance rules at lookup: none, unless a test says otherwise.
const mockDryRun = jest.fn<AnyFn>(async () => ({ passed: true, blocked: false, violations: [], warnings: [], rulesEvaluated: 0, rulesSkipped: 0, exemptionsApplied: [] }));
setVulnPolicyComplianceClientForTests({ dryRunPlugin: mockDryRun } as never);

function getLookupHandler() {
  const router = createReadPluginRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/lookup' && l.route?.methods?.post,
  );
  // The terminal withRoute handler is the LAST entry in the route stack: each
  // route now carries its permission gate (and, on writes, the `audited(...)`
  // declaration) ahead of it.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json });
  const setHeader = jest.fn<AnyFn>();
  return { res: { status, json, setHeader }, status, json };
}

describe('POST /plugins/lookup — filter validation', () => {
  beforeEach(() => { jest.clearAllMocks(); });

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
    expect(mockSendError).toHaveBeenCalledWith(res, 409, 'failed signature verification', 'IMAGE_VERIFICATION_FAILED', undefined);
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

  it('returns 404 when no plugin matches, saying what became of the org row', async () => {
    mockFind.mockResolvedValue(null);
    mockResolveListed.mockResolvedValue(null);
    const handler = getLookupHandler();
    const { res } = makeRes();
    rowState = 'inactive';
    await handler({ body: { filter: { name: 'missing', version: '1.0.0' } } }, res);
    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'Plugin not found.', 'NOT_FOUND', { reason: 'not_found', state: 'inactive' });
    rowState = 'missing';
  });

  it('refuses 410 PLUGIN_DELETED rather than falling through to a same-named listing', async () => {
    mockFind.mockResolvedValue(null);
    rowState = 'deleted';
    const { res } = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy' } } }, res);
    expect(mockSendError).toHaveBeenCalledWith(res, 410, expect.stringContaining('was deleted in your organization'), 'PLUGIN_DELETED', expect.objectContaining({ state: 'deleted' }));
    expect(mockResolveListed).not.toHaveBeenCalled();
    rowState = 'missing';
  });

  it('records the outcome per step when synth sends a context for a pipeline the org owns, and validates it', async () => {
    mockFind.mockResolvedValue({ id: 'p1', orgId: 'org-1', name: 'trivy', version: '1.0.0', buildType: 'metadata_only', pluginType: 'CodeBuildStep', keywords: [], installCommands: [], commands: [] });
    const pipelineId = '11111111-1111-1111-1111-111111111111';
    // One lookup (the CLI de-duplicates by alias) serving two steps records both.
    await getLookupHandler()({ body: { filter: { name: 'trivy' }, context: { pipelineId, stepKeys: ['Build/scan', 'Deploy/scan', 'Build/scan'] } } }, makeRes().res);
    expect(mockRecordStepLookup).toHaveBeenCalledTimes(2);
    expect(mockRecordStepLookup).toHaveBeenCalledWith(expect.objectContaining({ pipelineId, stepKey: 'Build/scan', resolvedVersion: '1.0.0' }));
    expect(mockRecordStepLookup).toHaveBeenCalledWith(expect.objectContaining({ pipelineId, stepKey: 'Deploy/scan', resolvedVersion: '1.0.0' }));
    const bad = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy' }, context: { pipelineId: 'nope', stepKeys: ['x'] } } }, bad.res);
    expect(mockSendBadRequest).toHaveBeenCalledWith(bad.res, expect.stringContaining('context.pipelineId'), 'VALIDATION_ERROR');
    const noSteps = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy' }, context: { pipelineId, stepKeys: [] } } }, noSteps.res);
    expect(mockSendBadRequest).toHaveBeenCalledWith(noSteps.res, expect.stringContaining('context.stepKeys'), 'VALIDATION_ERROR');
  });
});

function getSbomHandler() {
  const router = createReadPluginRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/:id/sbom' && l.route?.methods?.get,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeDownloadRes() {
  const send = jest.fn<AnyFn>();
  const type = jest.fn<AnyFn>().mockReturnValue({ send });
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json, type });
  const setHeader = jest.fn<AnyFn>();
  return { res: { status, json, setHeader }, status, type, send, setHeader };
}

describe('GET /plugins/:id/sbom', () => {
  beforeEach(() => { jest.clearAllMocks(); });

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
// Resolution semantics + lifecycle warnings
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

  it('never skips rescan-flagged versions (vulnerability state only grades)', () => {
    expect(resolutionFilter({ name: 'trivy' })).not.toHaveProperty('excludeScanFlagged');
    expect(resolutionFilter({ name: 'trivy', version: '~1.2.0' })).not.toHaveProperty('excludeScanFlagged');
  });
});

describe('lookupWarnings', () => {
  const base = { name: 'trivy', version: '1.0.0' };

  it('is empty for a healthy version', () => {
    expect(lookupWarnings({ ...base, lifecycle: 'production', yankedAt: null, deprecatedAt: null })).toEqual([]);
  });

  it('warns for a deprecated version, with its message', () => {
    expect(lookupWarnings({ ...base, deprecatedAt: new Date(), deprecationMessage: 'Use 2.x' })).toEqual([
      { code: 'PLUGIN_DEPRECATED', severity: 'warning', message: 'Plugin trivy@1.0.0 is deprecated: Use 2.x.' },
    ]);
    expect(lookupWarnings({ ...base, lifecycle: 'deprecated' })[0]!.message).toBe('Plugin trivy@1.0.0 is deprecated.');
  });

  it('warns for a yanked (pinned) version with the reason', () => {
    const [w] = lookupWarnings({ ...base, lifecycle: 'yanked', yankReason: 'CVE-2026-1' });
    expect(w).toEqual({ code: 'PLUGIN_YANKED', severity: 'warning', message: expect.stringContaining('is yanked: CVE-2026-1. It resolves only because it is pinned exactly') });
    expect(lookupWarnings({ ...base, yankedAt: '2026-09-01' })[0]!.code).toBe('PLUGIN_YANKED');
  });
});

describe('POST /plugins/lookup — answer carries warnings', () => {
  beforeEach(() => { jest.clearAllMocks(); });

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
      warnings: [{ code: 'PLUGIN_DEPRECATED', severity: 'warning', message: 'Plugin trivy@1.0.0 is deprecated: Use 2.x.' }],
      severity: 'warning',
    });
  });

  it('returns an empty warnings array for a healthy version', async () => {
    mockFind.mockResolvedValue({ id: 'p1', orgId: 'org-1', name: 'trivy', version: '1.0.0', buildType: 'metadata_only', pluginType: 'CodeBuildStep', keywords: [], installCommands: [], commands: [] });
    const { res } = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy' } } }, res);
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({ warnings: [], severity: null }));
  });
});

describe('POST /plugins/lookup — rescan-flagged org versions', () => {
  const FLAG = { critical: 2, high: 1, maxCritical: 0, findings: [{ id: 'CVE-2026-1', severity: 'critical', packageName: 'openssl', packageVersion: '3.0.1', fixedIn: ['3.0.2'] }] };
  const flagged = { id: 'p2', orgId: 'org-1', name: 'trivy', version: '1.1.0', buildType: 'metadata_only', pluginType: 'CodeBuildStep', keywords: [], installCommands: [], commands: [], scanFlaggedAt: new Date(), scanFlag: FLAG };
  const clean = { ...flagged, id: 'p1', version: '1.0.0', scanFlaggedAt: null, scanFlag: null };
  beforeEach(() => { jest.clearAllMocks(); });

  it('a flagged version resolves, graded error, naming the fix — never refused', async () => {
    mockFind.mockResolvedValueOnce(flagged).mockResolvedValueOnce(null);
    const { res } = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy' } } }, res);
    expect(mockFind).toHaveBeenNthCalledWith(1, { name: 'trivy', nameMatch: 'exact', excludeYanked: true }, 'org-1', undefined);
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      plugin: expect.objectContaining({ id: 'p2' }),
      severity: 'error',
      warnings: [expect.objectContaining({ code: 'VULN_FLAGGED', severity: 'error', plugin: 'trivy', version: '1.1.0', critical: 2 })],
    }));
    expect(mockSendError).not.toHaveBeenCalled();
  });

  it('an exact pin to a flagged version resolves too, naming the newer unflagged version (VULN_UPGRADE_AVAILABLE)', async () => {
    mockFind.mockResolvedValueOnce(flagged).mockResolvedValueOnce({ ...clean, id: 'p3', version: '1.2.0' });
    const { res } = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy', version: '1.1.0' } } }, res);
    expect(mockFind).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'trivy', excludeScanFlagged: true }), 'org-1', undefined);
    const body = mockSendSuccess.mock.calls.at(-1)?.[2] as { warnings: Array<{ code: string; suggestedVersion?: string }> };
    expect(body.warnings.map((w) => w.code)).toEqual(['VULN_FLAGGED', 'VULN_UPGRADE_AVAILABLE']);
    expect(body.warnings[0]).toMatchObject({ suggestedVersion: '1.2.0' });
    expect(mockIncCounter).not.toHaveBeenCalledWith('plugin_lookup_refusals_total', expect.anything());
  });

  it('notifies the pipeline owners (N32) when a lookup with a step context is graded error or louder', async () => {
    mockFind.mockResolvedValueOnce(flagged).mockResolvedValueOnce(null);
    await getLookupHandler()({ body: { filter: { name: 'trivy' }, context: { pipelineId: '11111111-1111-1111-1111-111111111111', stepKeys: ['Build/scan'] } } }, makeRes().res);
    expect(mockNotifyVulnerable).toHaveBeenCalledWith(expect.objectContaining({ stepKey: 'Build/scan', plugin: 'trivy', version: '1.1.0', severity: 'error', trigger: 'lookup' }));
  });
});

describe('POST /plugins/lookup — listings', () => {
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
    scannedAt: new Date(),
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
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { plugin: record, warnings: [{ code: 'PLUGIN_SECRETS_WITHHELD', message: 'no secrets', severity: 'info' }], severity: 'info' });
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
    expect(mockSendError).toHaveBeenCalledWith(res, 404, 'No listing acme/nope.', 'NOT_FOUND', { reason: 'not_found', state: 'missing' });
    const second = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'nope' } } }, second.res);
    expect(mockSendError).toHaveBeenCalledWith(second.res, 404, 'Plugin not found.', 'NOT_FOUND', { reason: 'not_found', state: 'missing' });
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
    expect(mockSendError).toHaveBeenCalledWith(res, 409, expect.stringContaining('signed as community'), 'IMAGE_VERIFICATION_FAILED', undefined);
    mockVerifyListed.mockRejectedValue(new Error('registry down'));
    await expect(getLookupHandler()({ body: { filter: { publisher: 'acme', name: 'lint' } } }, makeRes().res)).rejects.toThrow('registry down');
  });

  it('answers an own row with its own-namespace imageRepository, warning when it shadows an Official listing', async () => {
    mockFind.mockResolvedValue({ id: 'p1', orgId: 'org-1', name: 'trivy', version: '1.0.0', buildType: 'build_image', pluginType: 'CodeBuildStep', imageDigest: `sha256:${'b'.repeat(64)}`, scannedAt: new Date(), keywords: [], installCommands: [], commands: [] });
    mockShadowed.mockResolvedValue({ publisher: 'pipeline-builder', name: 'trivy' });
    const { res } = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy' } } }, res);
    expect(mockVerify).toHaveBeenCalledWith(expect.objectContaining({ imageRepository: 'org-org-1/trivy' }), expect.anything());
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      plugin: expect.objectContaining({ source: 'org', publisher: null, imageRepository: 'org-org-1/trivy' }),
      warnings: [expect.objectContaining({ code: 'PLUGIN_SHADOWS_LISTING', severity: 'info', message: expect.stringContaining('publisher: pipeline-builder') })],
      severity: 'info',
    });
  });
});

describe('POST /plugins/lookup — scan freshness, org policy and compliance', () => {
  const DIGEST = `sha256:${'c'.repeat(64)}`;
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    orgId: 'org-1',
    name: 'trivy',
    version: '1.0.0',
    buildType: 'build_image',
    pluginType: 'CodeBuildStep',
    imageDigest: DIGEST,
    scannedAt: new Date(),
    keywords: [],
    installCommands: [],
    commands: [],
    ...over,
  });
  const lookup = async () => {
    const { res, status } = makeRes();
    await getLookupHandler()({ body: { filter: { name: 'trivy' } } }, res);
    return { res, status };
  };
  const warningCodes = () => ((mockSendSuccess.mock.calls.at(-1)?.[2] as { warnings: Array<{ code: string }> }).warnings).map((w) => w.code);
  const lastBody = () => mockSendSuccess.mock.calls.at(-1)?.[2] as { severity: string | null; warnings: Array<{ code: string; severity: string }> };
  beforeEach(() => {
    jest.clearAllMocks();
    currentPolicy = { warnFixableHigh: 0 };
    delete process.env.PLUGIN_SCAN_STALE_HOURS;
    mockShadowed.mockResolvedValue(null);
  });

  it('warns UNSCANNED (severity warning) for a built image nobody has scanned — never refuses', async () => {
    mockFind.mockResolvedValue(row({ scannedAt: null }));
    const { status } = await lookup();
    expect(warningCodes()).toContain('UNSCANNED');
    expect(lastBody().severity).toBe('warning');
    expect(status).not.toHaveBeenCalledWith(409);
  });

  it('warns SCAN_STALE past PLUGIN_SCAN_STALE_HOURS, using the later of build scan and rescan', async () => {
    process.env.PLUGIN_SCAN_STALE_HOURS = '24';
    mockFind.mockResolvedValue(row({ scannedAt: new Date(Date.now() - 48 * 3_600_000) }));
    await lookup();
    expect(warningCodes()).toContain('SCAN_STALE');
    mockFind.mockResolvedValue(row({ scannedAt: new Date(Date.now() - 48 * 3_600_000), scanSummary: { scannedAt: new Date().toISOString() } }));
    await lookup();
    expect(warningCodes()).not.toContain('SCAN_STALE');
  });

  it('grades fixable High against the org\'s threshold (warning over it, info under)', async () => {
    currentPolicy = { warnFixableHigh: 2 };
    mockFind.mockResolvedValue(row({ vulnHighFixable: 3 }));
    await lookup();
    expect(lastBody().warnings).toEqual([expect.objectContaining({ code: 'VULN_HIGH_FIXABLE', severity: 'warning' })]);
    mockFind.mockResolvedValue(row({ vulnHighFixable: 1 }));
    await lookup();
    expect(lastBody().warnings).toEqual([expect.objectContaining({ code: 'VULN_HIGH_FIXABLE', severity: 'info' })]);
    expect(mockSendError).not.toHaveBeenCalled();
  });

  it('grades a BLOCK-mode org compliance rule over a vuln attribute as error (no refusal), and ignores non-vuln rules', async () => {
    mockFind.mockResolvedValue(row({ vulnCriticalFixable: 1 }));
    mockDryRun.mockResolvedValueOnce({
      passed: false,
      blocked: true,
      rulesEvaluated: 2,
      rulesSkipped: 0,
      exemptionsApplied: [],
      warnings: [],
      violations: [{ ruleId: 'r1', ruleName: 'no fixable criticals', field: 'vulnCriticalFixable', operator: 'lt', expectedValue: 1, actualValue: 1, severity: 'error', message: 'fixable criticals present' }],
    });
    await lookup();
    expect(lastBody().warnings).toEqual([expect.objectContaining({ code: 'COMPLIANCE_VULN_RULE', severity: 'error' })]);
    expect(mockSendError).not.toHaveBeenCalled();

    mockDryRun.mockResolvedValueOnce({
      passed: false,
      blocked: true,
      rulesEvaluated: 1,
      rulesSkipped: 0,
      exemptionsApplied: [],
      warnings: [],
      violations: [{ ruleId: 'r2', ruleName: 'needs tags', field: 'tags', operator: 'exists', expectedValue: true, actualValue: null, severity: 'error', message: 'no tags' }],
    });
    await lookup();
    expect(lastBody().warnings).toEqual([]);
  });

  it('resolves with an info COMPLIANCE_UNAVAILABLE when the compliance service is down', async () => {
    mockFind.mockResolvedValue(row());
    mockDryRun.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await lookup();
    expect(lastBody().warnings).toEqual([expect.objectContaining({ code: 'COMPLIANCE_UNAVAILABLE', severity: 'info' })]);
  });
});
