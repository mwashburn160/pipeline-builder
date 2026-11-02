// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for queue/vuln-rescan: the nightly pass over (a) every active image
 * plugin and (b) every listed version FROM ITS OWN public image, deduplicated
 * by digest (DB refresh, per-row persistence incl. fixable counts and the
 * scan flag, new critical/high detection, advisory drafts and N31, failure
 * isolation), the tick's stale detection off the last-completed timestamp in
 * Redis, and the leader-locked scheduler. The database is the in-memory fake
 * ecosystem db; the scanner is mocked.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { createFakeEcosystemDb } from './helpers/fake-ecosystem-db.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const db = createFakeEcosystemDb();

// -- scanner ------------------------------------------------------------------
const mockRefreshVulnDb = jest.fn<(...a: any[]) => Promise<void>>();
const DB_BUILT_AT = new Date('2026-09-21T00:00:00Z');
const mockAssertVulnDbFresh = jest.fn<(...a: any[]) => Promise<Date>>();
const mockVulnDbBuiltAt = jest.fn<(...a: any[]) => Promise<Date | null>>(async () => DB_BUILT_AT);
class MockVulnDbStaleError extends Error {}
const mockScanPluginImage = jest.fn<(...a: any[]) => Promise<any>>();
const mockInspectRunAsRoot = jest.fn<(...a: any[]) => Promise<boolean>>();
const mockOnNewCriticalOrHigh = jest.fn();
const key = (f: any) => `${f.id}|${f.packageName}|${f.packageVersion}`;
jest.unstable_mockModule('../src/helpers/vuln-scan.js', () => ({
  refreshVulnDb: mockRefreshVulnDb,
  assertVulnDbFresh: mockAssertVulnDbFresh,
  vulnDbBuiltAt: mockVulnDbBuiltAt,
  VulnDbStaleError: MockVulnDbStaleError,
  scanPluginImage: mockScanPluginImage,
  inspectRunAsRoot: mockInspectRunAsRoot,
  onNewCriticalOrHigh: mockOnNewCriticalOrHigh,
  // The real builder is covered by vuln-scan.test.ts; this keeps the fields the rescan reads back.
  scanSummary: (scan: any, input: any) => ({
    critical: scan.critical,
    high: scan.high,
    findings: scan.findings,
    truncated: false,
    waived: input.waived.map(key),
    trigger: input.trigger,
    imageDigest: input.imageDigest,
    uncataloguedBinaries: input.uncataloguedBinaries ?? [],
  }),
  scanColumns: (scan: any) => ({
    vulnCritical: scan.critical,
    vulnHigh: scan.high,
    vulnMedium: scan.medium,
    vulnLow: scan.low,
    vulnCriticalFixable: scan.criticalFixable,
    vulnHighFixable: scan.highFixable,
    scannedAt: scan.scannedAt,
  }),
}));

// -- advisory drafts, installers, listings, N31 ---------------------------------
const mockOpenRescanDraft = jest.fn<(...a: any[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/services/ecosystem/advisories.js', () => ({ openRescanDraft: mockOpenRescanDraft }));
const mockInstallingOrgs = jest.fn<(...a: any[]) => Promise<Array<{ orgId: string; install: null }>>>();
jest.unstable_mockModule('../src/services/ecosystem/install-notify.js', () => ({ installingOrgs: mockInstallingOrgs }));
const LISTING = { id: 'l-1', name: 'lint', state: 'listed', publisherId: 'pub-1' };
const PUBLISHER = { id: 'pub-1', handle: 'acme', tier: 'verified', suspendedAt: null };
jest.unstable_mockModule('../src/services/ecosystem/store.js', () => ({
  listings: { byId: async (id: string) => (id === LISTING.id ? LISTING : null) },
  publishers: { byId: async (id: string) => (id === PUBLISHER.id ? PUBLISHER : null) },
}));
const mockNotifyRescanFindings = jest.fn<(...a: any[]) => Promise<number>>();
const mockNotifyAcceptancesLapsed = jest.fn<(...a: any[]) => Promise<number>>(async () => 0);
jest.unstable_mockModule('../src/services/plugin-security-notifications.js', () => ({ notifyRescanFindings: mockNotifyRescanFindings, notifyAcceptancesLapsed: mockNotifyAcceptancesLapsed }));
// The kept-setup-image sweep rides the scheduler tick (its own suite: kept-setup-images.test.ts).
const mockSweepKeptSetupImages = jest.fn<(...a: any[]) => Promise<unknown>>(async () => ({ discarded: 0, remaining: 0 }));
jest.unstable_mockModule('../src/services/kept-setup-images.js', () => ({ sweepKeptSetupImages: mockSweepKeptSetupImages }));

// -- metrics / scheduler ------------------------------------------------------
const mockSetGauge = jest.fn();
const mockResetGauge = jest.fn();
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { setGauge: mockSetGauge, resetGauge: mockResetGauge, incCounter: mockIncCounter }));
const mockCreateScheduler = jest.fn((opts: any) => ({ opts, start: jest.fn(), stop: jest.fn() }));
const mockRecordAudit = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ createScheduler: mockCreateScheduler, recordAudit: mockRecordAudit }));
const mockHealthRedis = { get: jest.fn(), set: jest.fn() };
jest.unstable_mockModule('../src/queue/connections.js', () => ({ getHealthRedisConnection: () => mockHealthRedis }));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ host: 'registry', port: 5000, network: '', http: true }) },
}));

// -- fake database ------------------------------------------------------------
const tenantContexts: unknown[] = [];
/** The tenant context each exposure sync ran in, beside its arguments. */
const syncContexts: unknown[] = [];
let currentContext: unknown = null;
const mockSyncVersionExposures = jest.fn<(...a: any[]) => Promise<{ opened: number; closed: number }>>(async () => {
  syncContexts.push(currentContext);
  return { opened: 0, closed: 0 };
});
jest.unstable_mockModule('drizzle-orm', () => drizzleMock(db.ops));
let mockPipelinesOnVersion: () => Array<{ orgId: string }> = () => [];
let mockLapsed: () => unknown[] = () => [];
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...db.pipelineData,
  syncVersionExposures: mockSyncVersionExposures,
  // The soft-deleted-but-still-referenced safety net: the in-memory db has no
  // pipelines, so the predicate contributes nothing (an `or` part of undefined).
  versionReferencedPredicate: () => undefined,
  pipelinesOnVersion: async () => mockPipelinesOnVersion(),
  reopenLapsedAcceptances: async () => mockLapsed(),
  compareSemver: (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }),
  runWithTenantContext: async (ctx: unknown, fn: () => unknown) => {
    tenantContexts.push(ctx);
    currentContext = ctx;
    try { return await fn(); } finally { currentContext = null; }
  },
}));

const rescan = await import('../src/queue/vuln-rescan.js');

const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;
const finding = (id: string, severity: 'critical' | 'high' = 'critical', fixedIn: string[] = ['3.0.2']) =>
  ({ id, severity, packageName: 'openssl', packageVersion: '3.0.1', fixedIn });
const scan = (c: number, h: number, over: Record<string, unknown> = {}) => ({
  critical: c, high: h, medium: 0, low: 0, criticalFixable: 0, highFixable: 0, scannedAt: new Date('2026-09-21'), findings: [], dbBuiltAt: DB_BUILT_AT, ...over,
});
/** The previous scan's summary — the rescan's baseline for "new". */
const summary = (findings: any[], over: Record<string, unknown> = {}) => ({
  critical: findings.filter((f) => f.severity === 'critical').length, findings, truncated: false, waived: [], ...over,
});
/** What scanPluginImage resolves for a completed scan. */
const scanned = (sc: unknown, uncataloguedBinaries: string[] | null = []) => ({ scan: sc, packages: [], uncataloguedBinaries });

function plugin(id: string, over: Record<string, unknown> = {}) {
  return db.seed('plugins', {
    id,
    orgId: 'org-1',
    name: `p-${id}`,
    version: '1.0.0',
    imageDigest: DIGEST('a'),
    isActive: true,
    vulnCritical: 0,
    vulnHigh: 0,
    scannedAt: new Date('2026-09-01'),
    scanFlaggedAt: null,
    scanSummary: summary([]),
    runAsRoot: false,
    createdBy: 'u-1',
    ...over,
  });
}
function listed(id: string, over: Record<string, unknown> = {}) {
  return db.seed('plugin_listing_versions', {
    id,
    listingId: LISTING.id,
    version: '1.0.0',
    imageDigest: DIGEST('b'),
    imageRepository: 'public/acme/lint',
    vulnCritical: 0,
    vulnHigh: 0,
    scannedAt: new Date('2026-09-01'),
    scanFlaggedAt: null,
    scanSummary: summary([]),
    imageCollectedAt: null,
    ...over,
  });
}
const pluginRow = (id: string) => db.tables.plugins!.find((r) => r.id === id)!;
const listedRow = (id: string) => db.tables.plugin_listing_versions!.find((r) => r.id === id)!;

beforeEach(() => {
  jest.clearAllMocks();
  db.reset();
  tenantContexts.length = 0;
  syncContexts.length = 0;
  mockOpenRescanDraft.mockResolvedValue({ id: 'adv-1' });
  mockRefreshVulnDb.mockResolvedValue(undefined);
  mockAssertVulnDbFresh.mockResolvedValue(DB_BUILT_AT);
  mockScanPluginImage.mockResolvedValue(scanned(scan(0, 0)));
  mockInstallingOrgs.mockResolvedValue([]);
  mockNotifyRescanFindings.mockResolvedValue(1);
});
afterEach(() => {
  delete process.env.PLUGIN_RESCAN_ENABLED;
  delete process.env.PLUGIN_RESCAN_INTERVAL_MS;
  delete process.env.PLUGIN_RESCAN_LOCK_TTL_MS;
  delete process.env.PLUGIN_RESCAN_STARTUP_DELAY_MS;
  delete process.env.PLUGIN_VULN_MAX_CRITICAL;
  delete process.env.PLUGIN_VULN_WAIVERS;
  delete process.env.PLUGIN_VULN_GATE_KEV;
});

describe('rescanAllPlugins — (a) tenant plugin rows', () => {
  it('forces a DB refresh and checks its age, then rescans every image plugin across orgs as superadmin', async () => {
    plugin('1');
    plugin('2', { orgId: 'org-2', imageDigest: DIGEST('c') });
    mockScanPluginImage
      .mockResolvedValueOnce(scanned(scan(0, 1, { medium: 2, low: 3, highFixable: 1 })))
      .mockResolvedValueOnce(scanned(scan(1, 0)));

    const r = await rescan.rescanAllPlugins();

    expect(mockRefreshVulnDb).toHaveBeenCalledWith({ force: true });
    expect(mockRefreshVulnDb.mock.invocationCallOrder[0]!).toBeLessThan(mockAssertVulnDbFresh.mock.invocationCallOrder[0]!);
    expect(mockAssertVulnDbFresh.mock.invocationCallOrder[0]!).toBeLessThan(mockScanPluginImage.mock.invocationCallOrder[0]!);
    expect(tenantContexts).toEqual([{ isSuperAdmin: true }]);
    // The pass's DB build time rides every scan (read once, not per image).
    expect(mockScanPluginImage).toHaveBeenCalledWith({ orgId: 'org-1', name: 'p-1', imageDigest: DIGEST('a') }, expect.objectContaining({ host: 'registry' }), 'rescan', { dbBuiltAt: DB_BUILT_AT });
    expect(r).toEqual({
      total: 2,
      rescanned: 2,
      failed: 0,
      listed: 0,
      // Counts grew, but no finding IDENTITY is new (the scans itemize none).
      newCriticalOrHigh: 0,
      advisoryDrafts: 0,
      flagged: 0,
      catalog: { critical: 1, high: 1, medium: 2, low: 3 },
    });
    expect(pluginRow('1')).toMatchObject({ vulnCritical: 0, vulnHigh: 1, vulnMedium: 2, vulnLow: 3, vulnCriticalFixable: 0, vulnHighFixable: 1, scanFlaggedAt: null, scanFlag: null });
    expect(pluginRow('1').scanSummary).toMatchObject({ trigger: 'rescan', imageDigest: DIGEST('a'), high: 1 });
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_catalog_findings', { severity: 'critical' }, 1);
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_rescan_plugins', { state: 'total' }, 2);
  });

  it('skips deleted and image-less rows, and pages by id', async () => {
    plugin('del', { deletedAt: new Date() });
    plugin('noimg', { imageDigest: null });
    for (let i = 0; i < 205; i++) plugin(`r${String(i).padStart(4, '0')}`, { imageDigest: DIGEST('a') });
    const r = await rescan.rescanAllPlugins();
    expect(r.total).toBe(205);
    // One digest across all of them: scanned ONCE.
    expect(mockScanPluginImage).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: rescans an INACTIVE version too — pipelines pinned to its digest still run it', async () => {
    plugin('off', { isActive: false });
    const r = await rescan.rescanAllPlugins();
    expect(r).toMatchObject({ total: 1, rescanned: 1 });
  });

  it('REFUSES to run on a DB older than PLUGIN_VULN_DB_MAX_AGE_HOURS — nothing is scanned or stamped', async () => {
    plugin('1');
    mockAssertVulnDbFresh.mockRejectedValue(new MockVulnDbStaleError('vulnerability DB was built … older than 36h'));
    await expect(rescan.rescanAllPlugins()).rejects.toBeInstanceOf(MockVulnDbStaleError);
    expect(mockScanPluginImage).not.toHaveBeenCalled();
    expect(pluginRow('1').scannedAt).toEqual(new Date('2026-09-01'));
  });

  it('flags a version whose FIXABLE criticals exceed PLUGIN_VULN_MAX_CRITICAL, keeps the first flag time, and clears it when resolved', async () => {
    plugin('1', { vulnCritical: 0 });
    const findings = [finding('CVE-1'), finding('CVE-2', 'critical', [])];
    mockScanPluginImage.mockResolvedValue(scanned(scan(2, 0, { criticalFixable: 1, findings })));

    await rescan.rescanAllPlugins();
    const flaggedAt = pluginRow('1').scanFlaggedAt as Date;
    expect(flaggedAt).toBeInstanceOf(Date);
    expect(pluginRow('1').scanFlag).toEqual({ critical: 1, high: 0, maxCritical: 0, findings: [finding('CVE-1')] });

    // Still flagged next pass: the flag keeps its original time.
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlaggedAt).toBe(flaggedAt);

    // Resolved (rebuilt / fixed upstream): unflagged.
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0, { criticalFixable: 0, findings: [finding('CVE-2', 'critical', [])] })));
    await rescan.rescanAllPlugins();
    expect(pluginRow('1')).toMatchObject({ scanFlaggedAt: null, scanFlag: null });

    // Each TRANSITION is audited once — not the pass where it merely stayed flagged.
    const actions = mockRecordAudit.mock.calls.map((c: any) => c[0].action);
    expect(actions).toEqual(['plugin.vuln.flagged', 'plugin.vuln.cleared']);
    expect(mockRecordAudit.mock.calls[0]![0]).toMatchObject({
      actorId: 'system',
      orgId: 'org-1',
      targetType: 'plugin',
      targetId: '1',
      details: expect.objectContaining({ critical: 1, findings: ['CVE-1'], imageDigest: DIGEST('a'), trigger: 'rescan' }),
    });
  });

  it('flags an UNFIXABLE KEV-listed Critical under PLUGIN_VULN_GATE_KEV (default on)', async () => {
    plugin('1');
    const kev = { ...finding('CVE-KEV', 'critical', []), kev: true };
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0, { findings: [kev] })));
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlag).toEqual({ critical: 1, high: 0, maxCritical: 0, kev: 1, findings: [kev] });

    process.env.PLUGIN_VULN_GATE_KEV = 'false';
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlag).toBeNull();
  });

  it('counts only FIXABLE criticals against the floor, and -1 disables it', async () => {
    plugin('1');
    mockScanPluginImage.mockResolvedValue(scanned(scan(5, 0, { criticalFixable: 0, findings: [finding('CVE-1', 'critical', [])] })));
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlaggedAt).toBeNull();

    process.env.PLUGIN_VULN_MAX_CRITICAL = '-1';
    mockScanPluginImage.mockResolvedValue(scanned(scan(5, 0, { criticalFixable: 5, findings: [finding('CVE-1')] })));
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlaggedAt).toBeNull();
  });

  it('reports only the NEW findings — by identity, against the previous summary — to the owning org (N31) and the metrics', async () => {
    plugin('1', { scanSummary: summary([finding('CVE-1')]), createdBy: 'uploader-1' });
    const findings = [finding('CVE-1'), finding('CVE-9', 'high')];
    mockScanPluginImage.mockResolvedValue(scanned(scan(2, 1, { criticalFixable: 1, highFixable: 1, findings })));

    const r = await rescan.rescanAllPlugins();

    expect(r.newCriticalOrHigh).toBe(1);
    expect(mockOnNewCriticalOrHigh).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', listingVersionIds: [], imageDigest: DIGEST('a') }),
      [finding('CVE-9', 'high')],
      expect.objectContaining({ critical: 2 }),
    );
    expect(mockNotifyRescanFindings).toHaveBeenCalledWith({
      versionKey: 'plugin:1',
      plugin: 'p-1',
      version: '1.0.0',
      critical: 2,
      high: 1,
      findings: [finding('CVE-9', 'high')],
      flagged: true,
      imageDigest: DIGEST('a'),
      orgs: [{ orgId: 'org-1', uploaderId: 'uploader-1' }],
      // Flagged: the newest unflagged version to move to (none published here).
      suggestedVersion: null,
    });
    // …and the new summary is the next pass's baseline: nothing new the second time.
    jest.clearAllMocks();
    await rescan.rescanAllPlugins();
    expect(mockNotifyRescanFindings).not.toHaveBeenCalled();
  });

  it('REGRESSION: one CVE fixed and another published (counts FLAT) is still a new finding', async () => {
    plugin('1', { vulnCritical: 1, scanSummary: summary([finding('CVE-OLD')]) });
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0, { findings: [finding('CVE-NEW')] })));
    const r = await rescan.rescanAllPlugins();
    expect(r.newCriticalOrHigh).toBe(1);
    expect(mockNotifyRescanFindings.mock.calls[0]![0]).toMatchObject({ findings: [finding('CVE-NEW')] });
  });

  it('REGRESSION: a version with no summary yet only ESTABLISHES its baseline — no N31 flood for findings that are merely unrecorded', async () => {
    // Unfixable Critical: not gated, so the version does not become flagged.
    plugin('1', { scanSummary: null, imageDigest: DIGEST('c') });
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 1, { findings: [finding('CVE-1', 'critical', []), finding('CVE-2', 'high')] })));
    const r = await rescan.rescanAllPlugins();
    expect(r.newCriticalOrHigh).toBe(0);
    expect(mockNotifyRescanFindings).not.toHaveBeenCalled();
    expect(mockOnNewCriticalOrHigh).not.toHaveBeenCalled();
    expect(pluginRow('1').scanSummary).toMatchObject({ trigger: 'rescan', findings: [finding('CVE-1', 'critical', []), finding('CVE-2', 'high')] });

    // The baseline holds from the next pass on: a finding beyond it IS new.
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 2, { findings: [finding('CVE-1', 'critical', []), finding('CVE-2', 'high'), finding('CVE-3', 'high')] })));
    const r2 = await rescan.rescanAllPlugins();
    expect(r2.newCriticalOrHigh).toBe(1);
    expect(mockNotifyRescanFindings.mock.calls[0]![0]).toMatchObject({ findings: [finding('CVE-3', 'high')] });
  });

  it('a version with no summary that the baseline rescan NEWLY flags is reported — with the flag\'s findings', async () => {
    plugin('1', { scanSummary: null, imageDigest: DIGEST('c') });
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 1, { criticalFixable: 1, findings: [finding('CVE-1'), finding('CVE-2', 'high', [])] })));
    const r = await rescan.rescanAllPlugins();
    expect(r.newCriticalOrHigh).toBe(1);
    expect(mockNotifyRescanFindings.mock.calls[0]![0]).toMatchObject({ flagged: true, findings: [finding('CVE-1')] });
  });

  it('a version with no summary that was ALREADY flagged stays quiet on its baseline rescan', async () => {
    plugin('1', { scanSummary: null, scanFlaggedAt: new Date('2026-09-01'), imageDigest: DIGEST('c') });
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0, { criticalFixable: 1, findings: [finding('CVE-1')] })));
    const r = await rescan.rescanAllPlugins();
    expect(r.newCriticalOrHigh).toBe(0);
    expect(mockNotifyRescanFindings).not.toHaveBeenCalled();
  });

  it('fans the fresh summary out to the version\'s pipelines (an org row: publisher null), elevated, after the row is written', async () => {
    plugin('1', { orgId: 'org-2' });
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0, { criticalFixable: 1, findings: [finding('CVE-1')] })));
    await rescan.rescanAllPlugins();
    expect(mockSyncVersionExposures).toHaveBeenCalledTimes(1);
    expect(mockSyncVersionExposures).toHaveBeenCalledWith(
      { pluginName: 'p-1', pluginVersion: '1.0.0', pluginPublisher: null, imageDigest: DIGEST('a') },
      { scanSummary: pluginRow('1').scanSummary, scanFlag: pluginRow('1').scanFlag, scanFlaggedAt: pluginRow('1').scanFlaggedAt },
    );
    expect(pluginRow('1').scanFlag).not.toBeNull();
    expect(syncContexts).toEqual([{ isSuperAdmin: true }]);
  });

  it('syncs a CLEAN version too (so its open exposures close), and none for an image that failed to scan', async () => {
    plugin('1');
    plugin('2', { imageDigest: DIGEST('c') });
    mockScanPluginImage.mockResolvedValueOnce(scanned(scan(0, 0))).mockResolvedValueOnce({ scan: null, packages: null, uncataloguedBinaries: null });
    await rescan.rescanAllPlugins();
    expect(mockSyncVersionExposures).toHaveBeenCalledTimes(1);
    expect(mockSyncVersionExposures.mock.calls[0]![0]).toMatchObject({ pluginName: 'p-1' });
    expect(mockSyncVersionExposures.mock.calls[0]![1]).toMatchObject({ scanFlag: null, scanFlaggedAt: null });
  });

  it('writes the binaries the scanner cannot see into the summary', async () => {
    plugin('1');
    mockScanPluginImage.mockResolvedValue(scanned(scan(0, 0), ['/bin/hadolint']));
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanSummary).toMatchObject({ uncataloguedBinaries: ['/bin/hadolint'] });
  });

  it('fills runAsRoot only where unknown, and leaves it unknown when the config is unreadable', async () => {
    plugin('1', { runAsRoot: null });
    plugin('2', { runAsRoot: null, imageDigest: DIGEST('c') });
    plugin('3', { runAsRoot: true, imageDigest: DIGEST('d') });
    mockInspectRunAsRoot.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('crane 401'));
    await rescan.rescanAllPlugins();
    expect(mockInspectRunAsRoot).toHaveBeenCalledTimes(2);
    expect(pluginRow('1').runAsRoot).toBe(true);
    expect(pluginRow('2').runAsRoot).toBeNull();
    expect(pluginRow('3').runAsRoot).toBe(true);
  });

  it('an image that fails to rescan keeps its previous scan and is counted failed; the pass continues', async () => {
    plugin('1');
    plugin('2', { imageDigest: DIGEST('c') });
    plugin('3', { imageDigest: DIGEST('d') });
    mockScanPluginImage
      .mockResolvedValueOnce({ scan: null, packages: null, uncataloguedBinaries: null })
      .mockRejectedValueOnce(new Error('unexpected'))
      .mockResolvedValueOnce(scanned(scan(0, 0)));
    const r = await rescan.rescanAllPlugins();
    expect(r).toMatchObject({ total: 3, rescanned: 1, failed: 2 });
    expect(pluginRow('1').scannedAt).toEqual(new Date('2026-09-01'));
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_rescan_plugins', { state: 'failed' }, 2);
  });

  it('does not run at all when the DB refresh fails', async () => {
    plugin('1');
    mockRefreshVulnDb.mockRejectedValue(new Error('db offline'));
    await expect(rescan.rescanAllPlugins()).rejects.toThrow('db offline');
    expect(mockScanPluginImage).not.toHaveBeenCalled();
  });
});

describe('rescanAllPlugins — (b) listed versions from their own public image', () => {
  it('REGRESSION: a listed version whose source plugin was force-deleted is still rescanned from public/*, updated, and gets its drafts + N31', async () => {
    // The publisher's org row is gone (force-deleted / purged); only the listing copy remains.
    listed('lv-1', { sourcePluginId: 'gone', vulnCritical: 0, scanSummary: null });
    const findings = [finding('CVE-2026-1')];
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0, { criticalFixable: 1, findings })));
    mockInstallingOrgs.mockResolvedValue([{ orgId: 'org-x', install: null }, { orgId: 'org-y', install: null }]);

    const r = await rescan.rescanAllPlugins();

    expect(mockScanPluginImage).toHaveBeenCalledWith(
      { orgId: '000000000000000000000001', name: 'lint', imageDigest: DIGEST('b'), imageRepository: 'public/acme/lint' },
      expect.objectContaining({ host: 'registry' }), 'rescan', { dbBuiltAt: DB_BUILT_AT });
    expect(listedRow('lv-1')).toMatchObject({ vulnCritical: 1, vulnCriticalFixable: 1, scanFlag: expect.objectContaining({ critical: 1 }) });
    expect(listedRow('lv-1').scanFlaggedAt).toBeInstanceOf(Date);
    expect(mockOpenRescanDraft).toHaveBeenCalledWith({ listingVersion: expect.objectContaining({ id: 'lv-1', version: '1.0.0' }), findings });
    expect(mockInstallingOrgs).toHaveBeenCalledWith(PUBLISHER, LISTING, '1.0.0');
    expect(mockNotifyRescanFindings).toHaveBeenCalledWith(expect.objectContaining({
      versionKey: 'listing-version:lv-1',
      plugin: 'acme/lint',
      version: '1.0.0',
      flagged: true,
      imageDigest: DIGEST('b'),
      orgs: [{ orgId: 'org-x' }, { orgId: 'org-y' }],
    }));
    expect(r).toMatchObject({ total: 1, listed: 1, rescanned: 1, advisoryDrafts: 1, newCriticalOrHigh: 1, flagged: 1 });
    // Its exposures are keyed by the LISTING's identity: publisher handle + listed name.
    expect(mockSyncVersionExposures).toHaveBeenCalledWith(
      { pluginName: 'lint', pluginVersion: '1.0.0', pluginPublisher: 'acme', imageDigest: DIGEST('b') },
      expect.objectContaining({ scanSummary: listedRow('lv-1').scanSummary, scanFlag: expect.objectContaining({ critical: 1 }) }),
    );
  });

  it('scans each image once per pass: a listed copy sharing its source row\'s digest reuses that scan', async () => {
    plugin('1', { imageDigest: DIGEST('b') });
    listed('lv-1', { sourcePluginId: '1' });
    mockScanPluginImage.mockResolvedValue(scanned(scan(0, 2)));
    const r = await rescan.rescanAllPlugins();
    expect(mockScanPluginImage).toHaveBeenCalledTimes(1);
    expect(listedRow('lv-1')).toMatchObject({ vulnHigh: 2 });
    expect(r).toMatchObject({ total: 2, rescanned: 2, catalog: { critical: 0, high: 2, medium: 0, low: 0 } });
  });

  it('a digest whose tenant-namespace scan failed is retried from the public copy', async () => {
    plugin('1', { imageDigest: DIGEST('b') });
    listed('lv-1');
    mockScanPluginImage.mockResolvedValueOnce({ scan: null, packages: null, uncataloguedBinaries: null }).mockResolvedValueOnce(scanned(scan(0, 0)));
    const r = await rescan.rescanAllPlugins();
    expect(mockScanPluginImage).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ rescanned: 1, failed: 1 });
  });

  it('covers yanked versions until their image is collected, and skips image-less ones', async () => {
    listed('yanked-live', { yankedAt: new Date(), imageDigest: DIGEST('c') });
    listed('yanked-gone', { yankedAt: new Date(), imageCollectedAt: new Date(), imageDigest: DIGEST('d') });
    listed('no-image', { imageDigest: null, imageRepository: null });
    listed('no-repo', { imageRepository: null, imageDigest: DIGEST('e') });
    const r = await rescan.rescanAllPlugins();
    expect(r).toMatchObject({ total: 1, listed: 1 });
    expect(mockScanPluginImage.mock.calls[0]![0]).toMatchObject({ imageDigest: DIGEST('c') });
  });

  it('a yanked (not yet collected) version still gets its facts, its draft check AND its installers told — pinned installs still run it', async () => {
    listed('lv-1', { yankedAt: new Date() });
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0, { findings: [finding('CVE-1')] })));
    mockInstallingOrgs.mockResolvedValue([{ orgId: 'org-x', install: null }]);
    await rescan.rescanAllPlugins();
    expect(listedRow('lv-1').vulnCritical).toBe(1);
    expect(mockOpenRescanDraft).toHaveBeenCalled();
    expect(mockNotifyRescanFindings).toHaveBeenCalledWith(expect.objectContaining({ versionKey: 'listing-version:lv-1', orgs: [{ orgId: 'org-x' }] }));
  });

  it('compares a listed version against ITS OWN previous summary', async () => {
    const two = [finding('CVE-1'), finding('CVE-2')];
    listed('lv-same', { scanSummary: summary(two) });
    listed('lv-lag', { scanSummary: summary([]), imageDigest: DIGEST('c') });
    listed('lv-new', { scanSummary: null, scannedAt: null, imageDigest: DIGEST('d') });
    mockScanPluginImage.mockResolvedValue(scanned(scan(2, 0, { findings: two })));
    mockOpenRescanDraft.mockResolvedValueOnce({ id: 'adv-1' }).mockResolvedValueOnce(null); // the second was deduplicated
    const r = await rescan.rescanAllPlugins();
    // lv-new has no summary: its baseline pass reports only because it NEWLY becomes flagged (two fixable Criticals).
    expect(mockOpenRescanDraft.mock.calls.map((c) => (c[0] as any).listingVersion.id)).toEqual(['lv-lag', 'lv-new']);
    expect(mockOpenRescanDraft.mock.calls[0]![0]).toMatchObject({ findings: two });
    expect(r.advisoryDrafts).toBe(1);
    expect(listedRow('lv-lag').scanSummary).toMatchObject({ trigger: 'rescan', imageDigest: DIGEST('c') });
  });

  it('an unreadable installer set never fails the pass', async () => {
    listed('lv-1');
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0)));
    mockInstallingOrgs.mockRejectedValue(new Error('db blip'));
    const r = await rescan.rescanAllPlugins();
    expect(r).toMatchObject({ rescanned: 1, failed: 0 });
  });
});

describe('rescanAllPlugins — PLUGIN_VULN_WAIVERS', () => {
  const SYSTEM = '000000000000000000000001';

  it('applies a waiver like the build gate, audits it ONCE (not every night), and counts it per advisory', async () => {
    process.env.PLUGIN_VULN_WAIVERS = '*:2099-12-31:CVE-2026-0001';
    plugin('1', { orgId: SYSTEM });
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0, { criticalFixable: 1, findings: [finding('CVE-2026-0001')] })));

    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlag).toBeNull();
    expect(pluginRow('1').scanSummary).toMatchObject({ waived: ['CVE-2026-0001|openssl|3.0.1'] });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.vuln.waived',
      orgId: SYSTEM,
      targetType: 'plugin',
      targetId: '1',
      details: expect.objectContaining({ trigger: 'rescan', findings: ['CVE-2026-0001'], packages: ['openssl'] }),
    }));
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_waived_total', { plugin: 'p-1', advisory: 'CVE-2026-0001', trigger: 'rescan' });

    mockRecordAudit.mockClear();
    await rescan.rescanAllPlugins();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('a package-name waiver never exempts a KEV-listed Critical; an advisory-id one does', async () => {
    plugin('1', { orgId: SYSTEM, name: 'artillery' });
    const kev = { ...finding('CVE-2026-9999'), packageName: 'chromium', kev: true };
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0, { criticalFixable: 1, findings: [kev] })));

    process.env.PLUGIN_VULN_WAIVERS = 'artillery:2099-12-31:chromium';
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlag).toMatchObject({ critical: 1, kev: 1 });

    process.env.PLUGIN_VULN_WAIVERS = 'artillery:2099-12-31:CVE-2026-9999';
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlag).toBeNull();
  });

  it('exports, per entry, whether an ACTIVE waiver matched anything in the completed pass — resetting the set first', async () => {
    process.env.PLUGIN_VULN_WAIVERS = '*:2099-12-31:CVE-2026-0001;trivy@1.0.0:2099-12-31:zlib;old:2020-01-01:x';
    plugin('1', { orgId: SYSTEM });
    mockScanPluginImage.mockResolvedValue(scanned(scan(1, 0, { criticalFixable: 1, findings: [finding('CVE-2026-0001')] })));

    await rescan.rescanAllPlugins();

    expect(mockResetGauge).toHaveBeenCalledWith('plugin_vuln_waiver_unmatched');
    expect(mockResetGauge.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSetGauge.mock.invocationCallOrder[mockSetGauge.mock.calls.findIndex((c) => c[0] === 'plugin_vuln_waiver_unmatched')]!);
    const unmatched = mockSetGauge.mock.calls.filter((c) => c[0] === 'plugin_vuln_waiver_unmatched').map((c) => [c[1], c[2]]);
    // The expired entry is left to the expiry gauge.
    expect(unmatched).toEqual([
      [{ plugin: '*', targets: 'CVE-2026-0001' }, 0],
      [{ plugin: 'trivy@1.0.0', targets: 'zlib' }, 1],
    ]);
  });

  it('publishes nothing about waivers when the pass did not run', async () => {
    process.env.PLUGIN_VULN_WAIVERS = '*:2099-12-31:CVE-2026-0001';
    mockRefreshVulnDb.mockRejectedValue(new Error('db offline'));
    await expect(rescan.rescanAllPlugins()).rejects.toThrow();
    expect(mockSetGauge).not.toHaveBeenCalledWith('plugin_vuln_waiver_unmatched', expect.anything(), expect.anything());
  });
});

describe('runRescanTick — stale detection', () => {
  const redis = (last: string | null) => ({ get: jest.fn(async (_k: string) => last), set: jest.fn(async (_k: string, _v: string) => 'OK') });
  const DAY = 24 * 60 * 60 * 1000;

  it('skips while the last completed pass is younger than the interval, still publishing its timestamp', async () => {
    const now = 10 * DAY;
    const r = redis(String(now - DAY + 1));
    await expect(rescan.runRescanTick(r, () => now)).resolves.toBe('skipped');
    expect(r.get).toHaveBeenCalledWith(rescan.LAST_COMPLETED_KEY);
    expect(mockRefreshVulnDb).not.toHaveBeenCalled();
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_rescan_last_completed_timestamp_seconds', {}, Math.floor((now - DAY + 1) / 1000));
    // The DB-age gauge is refreshed on a skipped tick too.
    expect(mockVulnDbBuiltAt).toHaveBeenCalledTimes(1);
  });

  it('runs a due pass and records its completion time', async () => {
    const now = 10 * DAY;
    const r = redis(String(now - DAY));
    await expect(rescan.runRescanTick(r, () => now)).resolves.toBe('completed');
    expect(r.set).toHaveBeenCalledWith(rescan.LAST_COMPLETED_KEY, String(now));
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_rescan_runs_total', { outcome: 'completed' });
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_rescan_last_completed_timestamp_seconds', {}, Math.floor(now / 1000));
  });

  it.each([[null], ['garbage'], ['0'], ['-5']])('treats a missing or invalid timestamp (%p) as never run', async (raw) => {
    const r = redis(raw);
    await expect(rescan.runRescanTick(r, () => 1_000)).resolves.toBe('completed');
    const stamps = mockSetGauge.mock.calls.filter((c) => c[0] === 'plugin_vuln_rescan_last_completed_timestamp_seconds');
    expect(stamps).toEqual([['plugin_vuln_rescan_last_completed_timestamp_seconds', {}, 1]]);
  });

  it('honours PLUGIN_RESCAN_INTERVAL_MS', async () => {
    process.env.PLUGIN_RESCAN_INTERVAL_MS = '1000';
    await expect(rescan.runRescanTick(redis('5000'), () => 6_000)).resolves.toBe('completed');
    await expect(rescan.runRescanTick(redis('5000'), () => 5_999)).resolves.toBe('skipped');
  });

  it('a pass REFUSED for a stale DB is counted apart (outcome stale_db) and never stamps completion', async () => {
    mockAssertVulnDbFresh.mockRejectedValue(new MockVulnDbStaleError('too old'));
    const r = redis(null);
    await expect(rescan.runRescanTick(r, () => 1_000)).resolves.toBe('failed');
    expect(r.set).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_rescan_runs_total', { outcome: 'stale_db' });
  });

  it('a pass that could not run is "failed" and never stamps completion', async () => {
    mockRefreshVulnDb.mockRejectedValue(new Error('db offline'));
    const r = redis(null);
    await expect(rescan.runRescanTick(r, () => 1_000)).resolves.toBe('failed');
    expect(r.set).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_rescan_runs_total', { outcome: 'failed' });
  });
});

describe('createVulnRescanScheduler — leader lock', () => {
  it('is disabled by PLUGIN_RESCAN_ENABLED=false', () => {
    process.env.PLUGIN_RESCAN_ENABLED = 'False';
    expect(rescan.isRescanEnabled()).toBe(false);
    expect(rescan.createVulnRescanScheduler()).toBeNull();
    expect(mockCreateScheduler).not.toHaveBeenCalled();
  });

  it('ticks hourly under one Redis leader lock that outlasts a pass', () => {
    expect(rescan.isRescanEnabled()).toBe(true);
    expect(rescan.createVulnRescanScheduler()).not.toBeNull();
    const opts = mockCreateScheduler.mock.calls[0]![0];
    expect(opts).toMatchObject({
      name: 'vuln-rescan',
      intervalMs: 60 * 60 * 1000,
      startupDelayMs: 120_000,
      // 6h TTL is gone: the holder heartbeats for as long as the pass runs, so the
      // TTL only bounded how long a crashed pod parked rescans for — six hours.
      lock: { key: 'plugin:vuln-rescan:leader', ttlMs: 120_000 },
    });
    expect(opts.lock.redis()).toBe(mockHealthRedis);
  });

  it('ticks at the interval when it is shorter than an hour, with env-tuned lock and delay', () => {
    process.env.PLUGIN_RESCAN_INTERVAL_MS = '60000';
    process.env.PLUGIN_RESCAN_LOCK_TTL_MS = '5000';
    process.env.PLUGIN_RESCAN_STARTUP_DELAY_MS = '10';
    rescan.createVulnRescanScheduler();
    expect(mockCreateScheduler.mock.calls[0]![0]).toMatchObject({ intervalMs: 60_000, startupDelayMs: 10, lock: { ttlMs: 5000 } });
  });

  it('its run executes one tick against the injected Redis, sweeping expired kept setup images even when no pass is due', async () => {
    const r = { get: jest.fn(async (_k: string) => String(Date.now())), set: jest.fn() };
    rescan.createVulnRescanScheduler(() => r as any);
    await mockCreateScheduler.mock.calls[0]![0].run();
    expect(r.get).toHaveBeenCalledWith(rescan.LAST_COMPLETED_KEY);
    expect(mockRefreshVulnDb).not.toHaveBeenCalled(); // not due
    expect(mockSweepKeptSetupImages).toHaveBeenCalledTimes(1);
  });
});
