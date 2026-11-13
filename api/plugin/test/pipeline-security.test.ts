// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A pipeline's plugin security from the plugin service's side: the per-step
 * security view, the runtime check (graded, never "block"), per-pipeline risk
 * triage (time-boxed, KEV only when asked, audited), the declared-resolution
 * refresh after a catalog move, the lookup 404's row state, and the image GC's
 * in-use references. Vulnerability state never refuses anything here.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

type AnyFn = (...a: any[]) => any;

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const PIPE = '11111111-1111-1111-1111-111111111111';

// -- pipeline-data ------------------------------------------------------------
let rowsQueue: unknown[][] = [];
const mockExposures = jest.fn<AnyFn>(async () => []);
const mockLookups = jest.fn<AnyFn>(async () => []);
const mockTriage = jest.fn<AnyFn>(async () => []);
const mockExposureById = jest.fn<AnyFn>(async () => null);
const mockAcceptances = jest.fn<AnyFn>(async () => ({ byKey: new Map(), versionsByPlugin: new Map() }));
const mockDeclaredPipelines = jest.fn<AnyFn>(async () => ({ pipelines: [], truncated: false }));
const mockReplace = jest.fn<AnyFn>(async () => 0);
const mockReconcile = jest.fn<AnyFn>(async () => ({ opened: 0, closed: 0 }));
const mockResolveListing = jest.fn<AnyFn>(async () => null);
const mockInUse = jest.fn<AnyFn>(async () => [DIGEST]);
const mockResolveManaged = jest.fn<AnyFn>(async () => { throw new Error('no default'); });
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  executeRows: async () => rowsQueue.shift() ?? [],
  // The fake executor ignores the SQL, so the array clause only has to build.
  anyText: (values: Iterable<string>) => [...values],
  withTenantTx: async (fn: AnyFn) => fn({}),
  runWithTenantContext: async (_c: unknown, fn: AnyFn) => fn(),
  scopeOrgIds: (s: { orgId: string; rootOrgId?: string }) => (s.rootOrgId ? [s.orgId, s.rootOrgId] : [s.orgId]),
  stepLabelOf: (stage: string, step: string) => (stage === 'synth' && step === 'synth' ? 'synth' : `${stage}/${step}`),
  isVersionRange: (spec: string) => !/^\d+\.\d+\.\d+$/.test(spec),
  effectiveConsumptionPolicy: () => ({ warnFixableHigh: 0 }),
  acceptanceKey: (n: string, v: string, d?: string | null) => `${n}@${v}@${d ?? ''}`,
  activeAcceptances: (...a: unknown[]) => mockAcceptances(...a),
  pipelineExposures: (...a: unknown[]) => mockExposures(...a),
  pipelineStepLookups: (...a: unknown[]) => mockLookups(...a),
  triageExposure: (...a: unknown[]) => mockTriage(...a),
  exposureById: (...a: unknown[]) => mockExposureById(...a),
  declaredPipelinesForPlugin: (...a: unknown[]) => mockDeclaredPipelines(...a),
  resolveManagedToolchainHalf: (...a: unknown[]) => mockManagedHalf(...a),
  declaredResolution: async (input: { steps: Array<{ label: string; lookupFilter: Record<string, unknown> }>; resolve: AnyFn; pipelineId: string; orgId: string }) => {
    const rows = [];
    for (const s of input.steps) {
      const r = await input.resolve(s.lookupFilter);
      const [stageName, stepName] = s.label.includes('/') ? s.label.split('/') : [s.label, s.label];
      rows.push({ stageName, stepName, resolvedVersion: r && 'plugin' in r ? r.plugin.version : null, resolvedDigest: r && 'plugin' in r ? r.plugin.imageDigest : null });
    }
    return { rows, exposureSteps: [] };
  },
  replacePipelineResolution: (...a: unknown[]) => mockReplace(...a),
  reconcilePipelineExposures: (...a: unknown[]) => mockReconcile(...a),
  resolveListingReference: (...a: unknown[]) => mockResolveListing(...a),
  orgImageDigestsInUse: (...a: unknown[]) => mockInUse(...a),
  resolveManagedToolchain: (...a: unknown[]) => mockResolveManaged(...a),
  compareSemver: (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }),
}));
jest.unstable_mockModule('../src/services/ecosystem/store.js', () => ({
  elevated: async (fn: AnyFn) => fn({}),
  plugins: { publicNames: async () => ['lint'] },
}));
jest.unstable_mockModule('../src/services/ecosystem/installs-store.js', () => ({ listingSource: { policiesForOrgs: async () => [] } }));
const mockNotify = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('../src/services/plugin-security-notifications.js', () => ({ notifyPipelineVulnerable: (...a: unknown[]) => mockNotify(...a) }));
const mockFindFirst = jest.fn<AnyFn>(async () => null);
const mockManagedHalf = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({ pluginService: { findFirst: (...a: unknown[]) => mockFindFirst(...a) } }));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  collectPluginSteps: (props: { steps?: Array<{ label: string; name: string; publisher?: string; filter?: Record<string, unknown> }> }) => props.steps ?? [],
  pluginLookupFilter: (s: { name: string; publisher?: string; filter?: Record<string, unknown> }) => ({ name: s.name, ...(s.publisher ? { publisher: s.publisher } : {}), ...(s.filter ?? {}) }),
}));
const mockAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: jest.fn(),
  withRoute: (handler: AnyFn) => async (req: any, res: any) => {
    try {
      await handler({ req, res, ctx: { log: jest.fn() }, orgId: 'org-1', userId: 'u1' });
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string };
      res.status(e.statusCode ?? 500).json({ code: e.code, message: e.message });
    }
  },
}));

const sec = await import('../src/services/pipeline-security.js');
const { createPipelineSecurityRoutes } = await import('../src/routes/pipeline-security.js');
const { createInternalRoutes } = await import('../src/routes/internal.js');
const { refreshDeclaredResolutions, resolutionRefreshMax } = await import('../src/services/declared-resolution-refresh.js');
const { pluginRowState } = await import('../src/services/plugin-row-state.js');
const { setVulnPolicyComplianceClientForTests, scanFindingKey } = await import('@pipeline-builder/api-core');

setVulnPolicyComplianceClientForTests({ dryRunPlugin: async () => ({ violations: [], warnings: [] }) } as never);

const scope = { orgId: 'org-1' };
const finding = { id: 'CVE-1', severity: 'critical' as const, packageName: 'openssl', packageVersion: '3.0.1', fixedIn: ['3.0.2'] };
const ownRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'lint',
  version: '1.0.0',
  image_digest: DIGEST,
  build_type: 'build_image',
  plugin_type: 'CodeBuildStep',
  scanned_at: new Date(),
  scan_summary: null,
  scan_flagged_at: null,
  scan_flag: null,
  vuln_high_fixable: null,
  deleted: false,
  is_active: true,
  yanked: false,
  ...over,
});
const flaggedRow = () => ownRow({ scan_flagged_at: new Date(), scan_flag: { gated: 1, high: 0, maxFindings: 0, findings: [finding] } });

beforeEach(() => {
  jest.clearAllMocks();
  rowsQueue = [];
  delete process.env.PLUGIN_RISK_ACCEPTANCE_MAX_DAYS;
});

describe('recordsByDigest', () => {
  it('prefers the org\'s own row (deleted ones too), then a listing version, and ignores malformed digests', async () => {
    rowsQueue = [[ownRow({ deleted: true })], [{ id: 'lv1', name: 'scan', version: '2.0.0', image_digest: OTHER, publisher: 'acme', yanked: true }]];
    const m = await sec.recordsByDigest(scope, [DIGEST, OTHER, 'nope']);
    expect(m.get(DIGEST)).toMatchObject({ source: 'org', state: 'deleted', name: 'lint' });
    expect(m.get(OTHER)).toMatchObject({ source: 'listing', publisher: 'acme', state: 'yanked' });
    expect((await sec.recordsByDigest(scope, ['nope'])).size).toBe(0);
  });
});

describe('runtimeCheck', () => {
  it('grades each step (never block): ok, error for a flagged image, warning for an unknown one — and notifies on error', async () => {
    rowsQueue = [[flaggedRow(), ownRow({ id: 'p2', image_digest: OTHER, version: '2.0.0' })], []];
    const third = `sha256:${'c'.repeat(64)}`;
    const out = await sec.runtimeCheck(scope, { id: PIPE, name: 'web' }, [
      { stepKey: 'a', imageDigest: DIGEST }, { stepKey: 'b', imageDigest: OTHER }, { stepKey: 'c', imageDigest: third },
    ]);
    expect(out.verdict).toBe('error');
    expect(out.steps.map((s) => [s.stepKey, s.verdict])).toEqual([['a', 'error'], ['b', 'ok'], ['c', 'warning']]);
    expect(out.steps[2]!.reasons[0]!.code).toBe('UNKNOWN_IMAGE');
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: PIPE, stepKey: 'a', severity: 'error', trigger: 'runtime-check' }));
  });

  it('downgrades an accepted finding to info, and says a deleted version is still running', async () => {
    rowsQueue = [[ownRow({ deleted: true, scan_flagged_at: new Date(), scan_flag: { gated: 1, high: 0, maxFindings: 0, findings: [finding] }, scan_summary: { criticalFixable: 1, highFixable: 0, findings: [finding], kev: 0, imageDigest: DIGEST } })], []];
    mockAcceptances.mockResolvedValueOnce({ byKey: new Map([[`lint@1.0.0@${DIGEST}`, { findingKeys: [scanFindingKey(finding)], kev: false, acceptedUntil: '2026-12-01T00:00:00Z' }]]), versionsByPlugin: new Map() });
    const out = await sec.runtimeCheck(scope, { id: PIPE, name: null }, [{ stepKey: 'a', imageDigest: DIGEST }]);
    expect(out.steps[0]!.reasons.map((r) => [r.code, r.severity])).toEqual([['VULN_ACCEPTED', 'info'], ['PLUGIN_DELETED', 'warning']]);
    expect(out.verdict).toBe('warning');
  });

  it('validates its body', () => {
    expect(() => sec.parseRuntimeCheck({})).toThrow(/pipelineId/);
    expect(() => sec.parseRuntimeCheck({ pipelineId: PIPE, steps: [] })).toThrow(/steps/);
    expect(() => sec.parseRuntimeCheck({ pipelineId: PIPE, steps: [{ stepKey: 'a', imageDigest: 'x' }] })).toThrow(/sha256/);
    expect(sec.parseRuntimeCheck({ pipelineId: PIPE.toUpperCase(), steps: [{ stepKey: ' a ', imageDigest: DIGEST }] })).toEqual({ pipelineId: PIPE, steps: [{ stepKey: 'a', imageDigest: DIGEST }] });
  });
});

describe('pipelineSecurity', () => {
  it('joins the declared step, the last lookup, the scan state and the exposures per step', async () => {
    rowsQueue = [
      [{ stage_name: 'Build', step_name: 'scan', plugin_publisher: null, plugin_name: 'lint', declared_version: '^1.0.0', resolved_version: '1.0.0', resolved_digest: DIGEST, within_policy: true, computed_at: new Date() }],
      [flaggedRow()],
      [],
    ];
    mockLookups.mockResolvedValueOnce([{ stepKey: 'synth', pluginName: 'cdk', pluginPublisher: 'acme', resolvedVersion: '3.0.0', imageDigest: null, lookedUpAt: new Date(), warnings: [{ code: 'X', message: 'm' }], refusal: null, requestedVersion: null }]);
    mockExposures.mockResolvedValueOnce([{
      id: 'e1',
      orgId: 'org-1',
      pipelineId: PIPE,
      pluginPublisher: null,
      pluginName: 'lint',
      pluginVersion: '1.0.0',
      imageDigest: DIGEST,
      source: 'declared',
      criticalCount: 1,
      highCount: 0,
      topFindings: [],
      findingKeys: ['k'],
      triageState: 'accepted',
      acceptanceActive: true,
      acceptedUntil: new Date('2026-12-01'),
      acceptedFindingKeys: ['k'],
      acceptedKev: false,
      triageReason: 'r',
      triagedBy: 'u1',
      triagedAt: new Date(),
      flaggedAt: new Date(),
      fixedAt: null,
    }]);
    const view = await sec.pipelineSecurity(scope, { id: PIPE, name: 'web' });
    expect(view.severity).toBe('error');
    expect(view.steps.map((s) => s.stepKey)).toEqual(['Build/scan', 'synth']);
    expect(view.steps[0]).toMatchObject({ plugin: 'lint', version: '1.0.0', scan: expect.objectContaining({ flagged: true }), severity: 'error', exposures: [expect.objectContaining({ id: 'e1', acceptance: expect.objectContaining({ active: true }) })] });
    expect(view.steps[1]).toMatchObject({ plugin: 'acme/cdk', warnings: [{ code: 'X', message: 'm' }], scan: null, severity: 'ok' });
    // Nothing recorded for the build image: no row.
    expect(view.buildImage).toBeNull();
    expect(mockResolveManaged).not.toHaveBeenCalled();
  });
});

describe('pipelineSecurity — the Build image row', () => {
  const BOOT = `sha256:${'b'.repeat(64)}`;
  const changedAt = new Date('2026-11-10T09:00:00.000Z');
  const buildImageRow = (over: Record<string, unknown> = {}) => ({
    step_key: 'build-image',
    stage_name: '(toolchain)',
    action_name: 'build-image',
    plugin_publisher: null,
    plugin_name: 'pipeline-bootstrap',
    plugin_version: '1.4.2',
    image_digest: BOOT,
    image_repository: 'system/pipeline-bootstrap',
    resolved_via: 'pin',
    previous_release_version: null,
    release_changed_at: null,
    updated_at: changedAt,
    ...over,
  });
  const synthRow = (name: string, publisher: string | null = null) => ({
    step_key: 'synth',
    stage_name: 'Build',
    action_name: 'Synth',
    plugin_publisher: publisher,
    plugin_name: name,
    plugin_version: '1.4.2',
    image_digest: null,
    image_repository: null,
    resolved_via: null,
    previous_release_version: null,
    release_changed_at: null,
    updated_at: changedAt,
  });
  const bootRecord = (over: Record<string, unknown> = {}) => ownRow({ id: 'boot', name: 'pipeline-bootstrap', version: '1.4.2', image_digest: BOOT, build_type: 'prebuilt', plugin_type: 'BuildImage', ...over });

  it('shows the deployed release, its scan state, the build-image lookup warnings, behind the EFFECTIVE default, and the last change', async () => {
    // declared (none), the manifest rows, the system bootstrap row, the release notes.
    rowsQueue = [
      [],
      [buildImageRow({ previous_release_version: '1.4.1', release_changed_at: changedAt }), synthRow('cdk-synth')],
      [bootRecord({ scan_flagged_at: new Date(), scan_flag: { gated: 1, high: 0, maxFindings: 0, findings: [finding] } })],
      [{ release_notes: 'Bumps aws-cdk.' }],
    ];
    mockLookups.mockResolvedValueOnce([{
      stepKey: 'build-image',
      pluginName: 'pipeline-bootstrap',
      pluginPublisher: null,
      resolvedVersion: '1.4.2',
      imageDigest: BOOT,
      lookedUpAt: changedAt,
      warnings: [{ code: 'TOOLCHAIN_RELEASE_DEPRECATED', message: 'deprecated', severity: 'warning' }],
      refusal: null,
      requestedVersion: null,
    }]);
    // The org's effective default (its org default here) is newer than the pinned release.
    mockResolveManaged.mockResolvedValueOnce({ releaseVersion: '1.5.0', resolvedVia: 'org-default' });
    const view = await sec.pipelineSecurity(scope, { id: PIPE, name: 'web' });

    // The build image is a row of its own, never a step.
    expect(view.steps).toEqual([]);
    expect(mockResolveManaged).toHaveBeenCalledWith({ orgId: 'org-1' });
    expect(view.buildImage).toMatchObject({
      stepKey: 'build-image',
      releaseVersion: '1.4.2',
      digest: BOOT,
      imageRepository: 'system/pipeline-bootstrap',
      resolvedVia: 'pin',
      warnings: [{ code: 'TOOLCHAIN_RELEASE_DEPRECATED', message: 'deprecated', severity: 'warning' }],
      catalogState: 'live',
      scan: expect.objectContaining({ flagged: true }),
      severity: 'error',
      effectiveDefault: { releaseVersion: '1.5.0', resolvedVia: 'org-default' },
      behindDefault: true,
      synthPlugin: 'cdk-synth',
      toolchainUnmanaged: false,
      change: { from: '1.4.1', to: '1.4.2', changedAt: changedAt.toISOString() },
      releaseNotes: 'Bumps aws-cdk.',
    });
    // Its grade counts toward the pipeline's.
    expect(view.severity).toBe('error');
  });

  it('a custom synth plugin is "toolchain unmanaged"; on the effective default it is not behind; no change, no marker', async () => {
    rowsQueue = [[], [buildImageRow({ resolved_via: 'default' }), synthRow('my-synth')], [bootRecord()], []];
    mockResolveManaged.mockResolvedValueOnce({ releaseVersion: '1.4.2', resolvedVia: 'default' });
    const view = await sec.pipelineSecurity(scope, { id: PIPE, name: 'web' });
    expect(view.buildImage).toMatchObject({ releaseVersion: '1.4.2', behindDefault: false, toolchainUnmanaged: true, synthPlugin: 'my-synth', change: null, severity: 'ok' });

    // A listed synth under the managed NAME is still not the managed synth.
    rowsQueue = [[], [buildImageRow(), synthRow('cdk-synth', 'acme')], [bootRecord()], []];
    mockResolveManaged.mockResolvedValueOnce({ releaseVersion: '1.4.2', resolvedVia: 'default' });
    expect((await sec.pipelineSecurity(scope, { id: PIPE, name: 'web' })).buildImage).toMatchObject({ toolchainUnmanaged: true, synthPlugin: 'acme/cdk-synth' });
  });

  it('before any deploy, the bootstrap lookup alone gives the row; no effective default leaves "behind" false', async () => {
    rowsQueue = [[], [], [bootRecord()], []];
    mockLookups.mockResolvedValueOnce([{
      stepKey: 'build-image',
      pluginName: 'pipeline-bootstrap',
      pluginPublisher: null,
      resolvedVersion: '1.4.2',
      imageDigest: BOOT,
      lookedUpAt: changedAt,
      warnings: [],
      refusal: null,
      requestedVersion: null,
    }]);
    const view = await sec.pipelineSecurity(scope, { id: PIPE, name: 'web' });
    expect(view.buildImage).toMatchObject({ releaseVersion: '1.4.2', resolvedVia: null, deployedAt: null, effectiveDefault: null, behindDefault: false, toolchainUnmanaged: false, synthPlugin: null });
  });
});

describe('triage', () => {
  const exposure = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    orgId: 'org-1',
    pipelineId: PIPE,
    pluginPublisher: null,
    pluginName: 'lint',
    pluginVersion: '1.0.0',
    imageDigest: DIGEST,
    source: 'declared',
    criticalCount: 1,
    highCount: 0,
    topFindings: [],
    findingKeys: ['k1', 'k2'],
    triageState: 'open',
    acceptanceActive: false,
    acceptedUntil: null,
    acceptedFindingKeys: [],
    acceptedKev: false,
    triageReason: null,
    triagedBy: null,
    triagedAt: null,
    flaggedAt: new Date(),
    fixedAt: null,
    ...over,
  });
  const soon = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

  it('validates: accept needs a reason and a future expiry within the cap; false_positive needs a reason', () => {
    expect(() => sec.parseTriage({ action: 'mute' })).toThrow(/action/);
    expect(() => sec.parseTriage({ action: 'accept', acceptedUntil: soon() })).toThrow(/reason/);
    expect(() => sec.parseTriage({ action: 'accept', reason: 'r' })).toThrow(/acceptedUntil/);
    expect(() => sec.parseTriage({ action: 'accept', reason: 'r', acceptedUntil: '2020-01-01T00:00:00Z' })).toThrow(/future/);
    process.env.PLUGIN_RISK_ACCEPTANCE_MAX_DAYS = '3';
    expect(sec.riskAcceptanceMaxDays()).toBe(3);
    expect(() => sec.parseTriage({ action: 'accept', reason: 'r', acceptedUntil: soon() })).toThrow(/at most 3 days/);
    expect(() => sec.parseTriage({ action: 'false_positive' })).toThrow(/reason/);
    expect(() => sec.parseTriage({ action: 'reopen', kev: 'yes' })).toThrow(/kev/);
    expect(sec.parseTriage({ action: 'reopen' })).toEqual({ action: 'reopen', kev: false });
  });

  it('accepts (freezing the version\'s findings) and audits pipeline.vuln.accepted', async () => {
    mockExposureById.mockResolvedValueOnce(exposure());
    rowsQueue = [[ownRow()], []];
    mockTriage.mockResolvedValueOnce([exposure({ triageState: 'accepted', acceptanceActive: true, acceptedUntil: new Date(soon()) })]);
    const out = await sec.triagePipelineExposure(scope, PIPE, 'e1', sec.parseTriage({ action: 'accept', reason: 'upstream fix pending', acceptedUntil: soon() }), 'u1');
    expect(out[0]).toMatchObject({ id: 'e1', triageState: 'accepted', acceptance: expect.objectContaining({ active: true }) });
    expect(mockTriage).toHaveBeenCalledWith('org-1', 'e1', expect.objectContaining({ state: 'accepted', kev: false, actor: 'u1' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline.vuln.accepted', targetType: 'pipeline', targetId: PIPE, details: expect.objectContaining({ kev: false, findings: 2 }) }));
  });

  it('refuses to accept KEV findings unless kev: true, and records kev when it is', async () => {
    const kevRow = ownRow({ scan_summary: { criticalFixable: 0, highFixable: 0, kev: 1, findings: [{ ...finding, kev: true }], imageDigest: DIGEST } });
    mockExposureById.mockResolvedValueOnce(exposure());
    rowsQueue = [[kevRow], []];
    await expect(sec.triagePipelineExposure(scope, PIPE, 'e1', sec.parseTriage({ action: 'accept', reason: 'r', acceptedUntil: soon() }), 'u1')).rejects.toThrow(/kev: true/);
    mockExposureById.mockResolvedValueOnce(exposure());
    rowsQueue = [[kevRow], []];
    mockTriage.mockResolvedValueOnce([exposure()]);
    await sec.triagePipelineExposure(scope, PIPE, 'e1', sec.parseTriage({ action: 'accept', reason: 'r', acceptedUntil: soon(), kev: true }), 'u1');
    expect(mockTriage).toHaveBeenLastCalledWith('org-1', 'e1', expect.objectContaining({ kev: true }));
  });

  it('dismisses, reopens, and refuses another pipeline\'s or a closed exposure', async () => {
    mockExposureById.mockResolvedValueOnce(exposure());
    mockTriage.mockResolvedValueOnce([exposure({ triageState: 'false_positive' })]);
    await sec.triagePipelineExposure(scope, PIPE, 'e1', sec.parseTriage({ action: 'false_positive', reason: 'not reachable' }), 'u1');
    expect(mockAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'pipeline.vuln.false_positive' }));
    mockExposureById.mockResolvedValueOnce(exposure({ pipelineId: 'other' }));
    await expect(sec.triagePipelineExposure(scope, PIPE, 'e1', { action: 'reopen', kev: false }, 'u1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    mockExposureById.mockResolvedValueOnce(exposure({ fixedAt: new Date() }));
    await expect(sec.triagePipelineExposure(scope, PIPE, 'e1', { action: 'reopen', kev: false }, 'u1')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('routes', () => {
  const router = createPipelineSecurityRoutes();
  const handlerOf = (method: string, path: string) => {
    const layer = (router.stack as any[]).find((l) => l.route?.path === path && l.route?.methods?.[method]);
    return layer.route.stack[layer.route.stack.length - 1].handle as AnyFn;
  };
  const res = () => {
    const r: any = { headers: {} as Record<string, string> };
    r.status = jest.fn(() => r);
    r.json = jest.fn(() => r);
    r.setHeader = jest.fn((k: string, v: string) => { r.headers[k] = v; });
    return r;
  };
  const user = { sub: 'u1', organizationId: 'org-1', permissions: ['pipelines:read', 'pipelines:write', 'plugins:read'] };
  const owned = () => { rowsQueue.unshift([{ id: PIPE, pipeline_name: 'web' }]); };

  it('answers 404 for a pipeline the org does not own (or a malformed id)', async () => {
    const r = res();
    await handlerOf('get', '/pipelines/:pipelineId/security')({ params: { pipelineId: PIPE }, user, query: {} }, r);
    expect(r.status).toHaveBeenCalledWith(404);
    const bad = res();
    await handlerOf('get', '/pipelines/:pipelineId/exposures')({ params: { pipelineId: 'x' }, user, query: {} }, bad);
    expect(bad.status).toHaveBeenCalledWith(404);
  });

  it('serves the security view, the exposures, a triage and a runtime check', async () => {
    owned();
    const a = res();
    await handlerOf('get', '/pipelines/:pipelineId/security')({ params: { pipelineId: PIPE }, user, query: {} }, a);
    expect(a.status).toHaveBeenCalledWith(200);

    owned();
    const b = res();
    await handlerOf('get', '/pipelines/:pipelineId/exposures')({ params: { pipelineId: PIPE }, user, query: { includeFixed: 'true' } }, b);
    expect(mockExposures).toHaveBeenLastCalledWith('org-1', PIPE, { includeFixed: true });

    owned();
    mockExposureById.mockResolvedValueOnce({ id: 'e1', pipelineId: PIPE, fixedAt: null, findingKeys: [], topFindings: [], pluginName: 'lint', pluginVersion: '1.0.0', pluginPublisher: null, imageDigest: null, triageState: 'open' });
    mockTriage.mockResolvedValueOnce([]);
    const c = res();
    await handlerOf('post', '/pipelines/:pipelineId/exposures/:exposureId/triage')({ params: { pipelineId: PIPE, exposureId: 'e1' }, user, body: { action: 'reopen' } }, c);
    expect(c.status).toHaveBeenCalledWith(404); // nothing updated

    owned();
    rowsQueue.push([], []);
    const d = res();
    await handlerOf('post', '/runtime-check')({ user, body: { pipelineId: PIPE, steps: [{ stepKey: 'a', imageDigest: DIGEST }] } }, d);
    expect(d.status).toHaveBeenCalledWith(200);
    expect(d.json.mock.calls[0][0]).toMatchObject({ data: { verdict: 'warning' } });
  });

  it('serves the image GC its in-use digests (internal)', async () => {
    const internal = createInternalRoutes();
    const layer = (internal.stack as any[]).find((l) => l.route?.path === '/plugins/image-references');
    const h = layer.route.stack[layer.route.stack.length - 1].handle as AnyFn;
    const r = res();
    await h({ query: { orgId: 'ORG-1' } }, r);
    expect(mockInUse).toHaveBeenCalledWith('org-1');
    expect(r.json.mock.calls[0][0]).toMatchObject({ data: { digests: [DIGEST] } });
    const bad = res();
    await h({ query: {} }, bad);
    expect(bad.status).toHaveBeenCalledWith(400);
  });
});

describe('refreshDeclaredResolutions', () => {
  it('re-resolves the declaring pipelines the way lookup does and rewrites only the changed ones', async () => {
    mockDeclaredPipelines.mockResolvedValueOnce({
      truncated: true,
      pipelines: [
        { pipelineId: 'p-changed', orgId: 'org-1', rootOrgId: null, props: { steps: [{ label: 'Build/scan', name: 'lint' }] }, current: new Map([['Build\u0000scan', { resolvedVersion: '1.0.0', resolvedDigest: DIGEST }]]) },
        { pipelineId: 'p-same', orgId: 'org-1', rootOrgId: 'root', props: { steps: [{ label: 'Build/scan', name: 'acme-lint', publisher: 'acme' }] }, current: new Map([['Build\u0000scan', { resolvedVersion: '2.0.0', resolvedDigest: OTHER }]]) },
        { pipelineId: 'p-gone', orgId: 'org-1', rootOrgId: null, props: { steps: [{ label: 'Build/scan', name: 'nope', filter: { id: 'x' } }] }, current: new Map() },
      ],
    });
    mockFindFirst.mockResolvedValueOnce({ id: 'p9', name: 'lint', version: '1.1.0', imageDigest: OTHER, scanSummary: null, scanFlag: null, scanFlaggedAt: null });
    mockResolveListing.mockResolvedValueOnce({ ok: true, publisher: { handle: 'acme' }, listing: { name: 'acme-lint' }, version: { id: 'v2', version: '2.0.0', imageDigest: OTHER, scanSummary: null, scanFlag: null, scanFlaggedAt: null } });
    mockFindFirst.mockResolvedValueOnce(null);
    const out = await refreshDeclaredResolutions({ pluginName: 'lint', orgId: 'org-1' });
    expect(out).toEqual({ refreshed: 2, unchanged: 1, truncated: true });
    expect(mockReplace).toHaveBeenCalledWith('p-changed', [expect.objectContaining({ resolvedVersion: '1.1.0' })]);
    expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'p-changed', source: 'declared' }));
    expect(resolutionRefreshMax()).toBe(500);
  });

  it('re-resolves a managed toolchain step through the toolchain resolver with the pipeline\'s release pin, never a row or listing', async () => {
    mockFindFirst.mockClear();
    mockResolveListing.mockClear();
    mockReplace.mockClear();
    mockDeclaredPipelines.mockResolvedValueOnce({
      truncated: false,
      pipelines: [
        { pipelineId: 'p-tc', orgId: 'org-1', rootOrgId: null, props: { toolchain: { release: '1.2.0' }, steps: [{ label: 'synth', name: 'BuildSynth', filter: { name: 'cdk-synth' } }] }, current: new Map() },
        { pipelineId: 'p-pinned', orgId: 'org-1', rootOrgId: null, props: { steps: [{ label: 'synth', name: 'cdk-synth', filter: { version: '1.0.0' } }] }, current: new Map() },
      ],
    });
    mockManagedHalf.mockResolvedValueOnce({ plugin: { id: 'sys-1', name: 'cdk-synth', version: '1.2.0', imageDigest: DIGEST, scanSummary: null, scanFlag: null, scanFlaggedAt: null } });
    const out = await refreshDeclaredResolutions({ pluginName: 'cdk-synth', orgId: 'org-1' });
    expect(out.refreshed).toBe(2);
    expect(mockManagedHalf).toHaveBeenCalledTimes(1);
    expect(mockManagedHalf).toHaveBeenCalledWith({ orgId: 'org-1' }, 'cdk-synth', { releasePin: '1.2.0' });
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockResolveListing).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('p-tc', [expect.objectContaining({ resolvedVersion: '1.2.0' })]);
    // A step pinning a managed half's own version resolves to nothing (refused).
    expect(mockReplace).toHaveBeenCalledWith('p-pinned', [expect.objectContaining({ resolvedVersion: null })]);
  });

  it('never throws', async () => {
    mockDeclaredPipelines.mockRejectedValueOnce(new Error('db down'));
    await expect(refreshDeclaredResolutions({ pluginName: 'lint', publisher: 'acme' })).resolves.toEqual({ refreshed: 0, unchanged: 0, truncated: false });
  });
});

describe('pluginRowState', () => {
  it('says what became of the org rows a reference names', async () => {
    rowsQueue = [[{ deleted: true, active: false, yanked: false }]];
    await expect(pluginRowState(scope, { name: 'lint' })).resolves.toBe('deleted');
    rowsQueue = [[{ deleted: false, active: true, yanked: true }]];
    await expect(pluginRowState(scope, { name: 'lint', version: '1.0.0' })).resolves.toBe('yanked');
    rowsQueue = [[{ deleted: false, active: false, yanked: false }]];
    await expect(pluginRowState(scope, { id: 'p1' })).resolves.toBe('inactive');
    rowsQueue = [[{ deleted: false, active: true, yanked: false }]];
    await expect(pluginRowState(scope, { name: 'lint' })).resolves.toBe('live');
    rowsQueue = [[]];
    await expect(pluginRowState(scope, { name: 'lint' })).resolves.toBe('missing');
    await expect(pluginRowState(scope, {})).resolves.toBe('missing');
  });
});
