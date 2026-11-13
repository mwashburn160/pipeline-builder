// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/plugins/lookup` and `/plugins/find` for a MANAGED toolchain name
 * (docs/plans/bootstrap-image-versioning.md §2): answered from
 * `resolveManagedToolchain` only — never the row or listing branch, for the
 * system org too — with `{ plugin, warnings, toolchain: { releaseVersion,
 * resolvedVia } }`, the half's image verified, 409 TOOLCHAIN_NO_DEFAULT and 404
 * for a deleted pin, and nothing about rollout membership or other orgs.
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
  validateQuery: (req: { query: Record<string, unknown> }) => ({ ok: true, value: req.query }),
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
const mockResolveManaged = jest.fn<AnyFn>();
/** Stands in for pipeline-data's typed resolver error (the route tests `instanceof`). */
class ManagedToolchainError extends Error {
  readonly statusCode: number;
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.statusCode = ({ TOOLCHAIN_NO_DEFAULT: 409, NOT_FOUND: 404, TOOLCHAIN_PAIR_MISMATCH: 500 } as Record<string, number>)[code] ?? 400;
  }
}
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
  resolveManagedToolchain: (...a: unknown[]) => mockResolveManaged(...a),
  ManagedToolchainError,
  // The flat `toolchain.<field>` metadata keys back into an object (api-core `toolchainFromMetadata`).
  bootstrapToolchainOf: (row: { metadata?: Record<string, string> }) => Object.fromEntries(Object.entries(row.metadata ?? {})
    .filter(([k]) => k.startsWith('toolchain.')).map(([k, v]) => [k.slice('toolchain.'.length), v])),
}));

const { createReadPluginRoutes } = await import('../src/routes/read-plugins.js');
const { setVulnPolicyComplianceClientForTests } = await import('@pipeline-builder/api-core');

// The org's compliance rules at lookup: none, unless a test says otherwise.
const mockDryRun = jest.fn<AnyFn>(async () => ({ passed: true, blocked: false, violations: [], warnings: [], rulesEvaluated: 0, rulesSkipped: 0, exemptionsApplied: [] }));
setVulnPolicyComplianceClientForTests({ dryRunPlugin: mockDryRun } as never);

function getHandler(path: '/lookup' | '/find' = '/lookup') {
  const router = createReadPluginRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === path && (path === '/lookup' ? l.route?.methods?.post : l.route?.methods?.get),
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

const DIGEST = `sha256:${'b'.repeat(64)}`;
const SYSTEM = '000000000000000000000001';
const TOOLCHAIN = { pipelineManager: '3.4.0', awsCdk: '2.275.0', cdkAssets: '3.1.0', esbuild: '0.25.0', pnpm: '10.0.0', node: '22.11.0' };
const half = (name: string, version: string) => ({
  id: `${name}-${version}`,
  orgId: SYSTEM,
  name,
  version,
  buildType: 'prebuilt',
  pluginType: name === 'pipeline-bootstrap' ? 'BuildImage' : 'CodeBuildStep',
  imageDigest: DIGEST,
  keywords: [],
  installCommands: [],
  commands: [],
  scannedAt: new Date(),
  vulnHighFixable: 0,
  metadata: Object.fromEntries(Object.entries(name === 'pipeline-bootstrap' ? TOOLCHAIN : {}).map(([k, v]) => [`toolchain.${k}`, v])),
});
const resolution = (version: string, resolvedVia = 'default', warnings: unknown[] = []) => ({
  releaseVersion: version, resolvedVia, warnings, bootstrap: half('pipeline-bootstrap', version), synth: half('cdk-synth', version),
});

const sent = () => mockSendSuccess.mock.calls.at(-1)?.[2] as Record<string, any>;

describe('/plugins/lookup — managed toolchain names', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveManaged.mockResolvedValue(resolution('1.4.0'));
  });

  it.each(['cdk-synth', 'pipeline-bootstrap'])('answers %s from the toolchain resolver, never the row or listing branch', async (name) => {
    const { res } = makeRes();
    await getHandler()({ body: { filter: { name } } }, res);
    expect(mockResolveManaged).toHaveBeenCalledWith({ orgId: 'org-1' }, {});
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockResolveListed).not.toHaveBeenCalled();
    expect(mockShadowed).not.toHaveBeenCalled();
    const data = sent();
    expect(data.plugin).toMatchObject({ name, version: '1.4.0', orgId: SYSTEM, imageRepository: `system/${name}`, source: 'org', publisher: null });
    expect(data.toolchain).toEqual({ releaseVersion: '1.4.0', resolvedVia: 'default' });
    expect(Array.isArray(data.warnings)).toBe(true);
  });

  it('carries the bootstrap half\'s tool versions on the plugin', async () => {
    const { res } = makeRes();
    await getHandler()({ body: { filter: { name: 'pipeline-bootstrap' } } }, res);
    expect(sent().plugin.toolchain).toEqual(TOOLCHAIN);
  });

  it('routes a managed name to the resolver with a publisher too (no same-named listing is ever a candidate)', async () => {
    const { res } = makeRes();
    await getHandler()({ body: { filter: { name: 'cdk-synth', publisher: 'acme' } } }, res);
    expect(mockResolveListed).not.toHaveBeenCalled();
    expect(sent().plugin).toMatchObject({ orgId: SYSTEM });
  });

  it('passes a valid releasePin through, and refuses a malformed one', async () => {
    mockResolveManaged.mockResolvedValue(resolution('1.2.0', 'pin', [{ code: 'TOOLCHAIN_RELEASE_YANKED', severity: 'warning', message: 'yanked' }]));
    const { res } = makeRes();
    await getHandler()({ body: { filter: { name: 'cdk-synth' }, releasePin: '1.2.0' } }, res);
    expect(mockResolveManaged).toHaveBeenCalledWith({ orgId: 'org-1' }, { releasePin: '1.2.0' });
    expect(sent().toolchain).toEqual({ releaseVersion: '1.2.0', resolvedVia: 'pin' });
    expect(sent().warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TOOLCHAIN_RELEASE_YANKED', severity: 'warning' })]));
    expect(sent().severity).toBe('warning');

    const bad = makeRes();
    await getHandler()({ body: { filter: { name: 'cdk-synth' }, releasePin: '^1.2.0' } }, bad.res);
    expect(bad.status).toHaveBeenCalledWith(400);
  });

  it('refuses a managed half pinned by version or id: TOOLCHAIN_PIN_VIA_RELEASE', async () => {
    for (const filter of [{ name: 'cdk-synth', version: '1.4.0' }, { name: 'cdk-synth', version: '^1.0.0' }, { name: 'cdk-synth', id: 'x' }]) {
      const { res, status } = makeRes();
      await getHandler()({ body: { filter } }, res);
      expect(status).toHaveBeenCalledWith(400);
      expect(mockSendError).toHaveBeenLastCalledWith(res, 400, expect.any(String), 'TOOLCHAIN_PIN_VIA_RELEASE', expect.anything());
    }
    expect(mockResolveManaged).not.toHaveBeenCalled();
  });

  it('no platform default → 409 TOOLCHAIN_NO_DEFAULT; a deleted pin → 404', async () => {
    mockResolveManaged.mockRejectedValueOnce(new ManagedToolchainError('TOOLCHAIN_NO_DEFAULT', 'No platform default'));
    const a = makeRes();
    await getHandler()({ body: { filter: { name: 'cdk-synth' } } }, a.res);
    expect(a.status).toHaveBeenCalledWith(409);
    expect(mockSendError).toHaveBeenLastCalledWith(a.res, 409, 'No platform default', 'TOOLCHAIN_NO_DEFAULT', expect.anything());
    expect(mockFind).not.toHaveBeenCalled();

    mockResolveManaged.mockRejectedValueOnce(new ManagedToolchainError('NOT_FOUND', 'gone', { reason: 'toolchain_release_not_found', releaseVersion: '1.0.0' }));
    const b = makeRes();
    await getHandler()({ body: { filter: { name: 'cdk-synth' }, releasePin: '1.0.0' } }, b.res);
    expect(b.status).toHaveBeenCalledWith(404);
  });

  it('verifies the half\'s image before handing out its digest', async () => {
    mockVerify.mockRejectedValueOnce(new ImageVerificationError('bad signature'));
    const { res, status } = makeRes();
    await getHandler()({ body: { filter: { name: 'cdk-synth' } } }, res);
    expect(mockVerify).toHaveBeenCalledWith(expect.objectContaining({ name: 'cdk-synth', imageDigest: DIGEST }), expect.anything());
    expect(status).toHaveBeenCalledWith(409);
  });

  it('never returns rollout membership or other orgs\' data', async () => {
    mockResolveManaged.mockResolvedValue(resolution('1.5.0', 'canary'));
    const { res } = makeRes();
    await getHandler()({ body: { filter: { name: 'cdk-synth' } } }, res);
    const data = sent();
    expect(Object.keys(data).sort()).toEqual(['plugin', 'severity', 'toolchain', 'warnings']);
    expect(Object.keys(data.toolchain).sort()).toEqual(['releaseVersion', 'resolvedVia']);
    expect(JSON.stringify(data)).not.toMatch(/rollout|members|orgDefault/i);
  });

  it('GET /plugins/find takes releasePin from the query string', async () => {
    const { res } = makeRes();
    await getHandler('/find')({ query: { name: 'cdk-synth', releasePin: '1.4.0' } }, res);
    expect(mockResolveManaged).toHaveBeenCalledWith({ orgId: 'org-1' }, { releasePin: '1.4.0' });
    expect(sent().toolchain).toEqual({ releaseVersion: '1.4.0', resolvedVia: 'default' });
  });

  it('a non-managed name keeps the row branch (releasePin is ignored)', async () => {
    mockFind.mockResolvedValue({ id: 'p1', name: 'mine', orgId: 'org-1', buildType: 'metadata_only', pluginType: 'CodeBuildStep', keywords: [], installCommands: [], commands: [] });
    const { res } = makeRes();
    await getHandler()({ body: { filter: { name: 'mine' }, releasePin: '1.4.0' } }, res);
    expect(mockResolveManaged).not.toHaveBeenCalled();
    expect(mockFind).toHaveBeenCalled();
    expect(sent().toolchain).toBeUndefined();
  });
});
