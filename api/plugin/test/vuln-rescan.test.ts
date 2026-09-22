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
const mockScanPluginImage = jest.fn<(...a: any[]) => Promise<any>>();
const mockInspectRunAsRoot = jest.fn<(...a: any[]) => Promise<boolean>>();
const mockOnNewCriticalOrHigh = jest.fn();
jest.unstable_mockModule('../src/helpers/vuln-scan.js', () => ({
  refreshVulnDb: mockRefreshVulnDb,
  scanPluginImage: mockScanPluginImage,
  inspectRunAsRoot: mockInspectRunAsRoot,
  onNewCriticalOrHigh: mockOnNewCriticalOrHigh,
  hasNewCriticalOrHigh: (before: any, after: any) => after.critical > (before?.critical ?? 0) || after.high > (before?.high ?? 0),
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
jest.unstable_mockModule('../src/services/plugin-security-notifications.js', () => ({ notifyRescanFindings: mockNotifyRescanFindings }));

// -- metrics / scheduler ------------------------------------------------------
const mockSetGauge = jest.fn();
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { setGauge: mockSetGauge, incCounter: mockIncCounter }));
const mockCreateScheduler = jest.fn((opts: any) => ({ opts, start: jest.fn(), stop: jest.fn() }));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ createScheduler: mockCreateScheduler }));
const mockHealthRedis = { get: jest.fn(), set: jest.fn() };
jest.unstable_mockModule('../src/queue/connections.js', () => ({ getHealthRedisConnection: () => mockHealthRedis }));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ host: 'registry', port: 5000, network: '', http: true }) },
}));

// -- fake database ------------------------------------------------------------
const tenantContexts: unknown[] = [];
jest.unstable_mockModule('drizzle-orm', () => drizzleMock(db.ops));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...db.pipelineData,
  runWithTenantContext: async (ctx: unknown, fn: () => unknown) => { tenantContexts.push(ctx); return fn(); },
}));

const rescan = await import('../src/queue/vuln-rescan.js');

const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;
const finding = (id: string, severity: 'critical' | 'high' = 'critical', fixedIn: string[] = ['3.0.2']) =>
  ({ id, severity, packageName: 'openssl', packageVersion: '3.0.1', fixedIn });
const scan = (c: number, h: number, over: Record<string, unknown> = {}) => ({
  critical: c, high: h, medium: 0, low: 0, criticalFixable: 0, highFixable: 0, scannedAt: new Date('2026-09-21'), findings: [], ...over,
});

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
  mockOpenRescanDraft.mockResolvedValue({ id: 'adv-1' });
  mockRefreshVulnDb.mockResolvedValue(undefined);
  mockScanPluginImage.mockResolvedValue({ scan: scan(0, 0), packages: [] });
  mockInstallingOrgs.mockResolvedValue([]);
  mockNotifyRescanFindings.mockResolvedValue(1);
});
afterEach(() => {
  delete process.env.PLUGIN_RESCAN_ENABLED;
  delete process.env.PLUGIN_RESCAN_INTERVAL_MS;
  delete process.env.PLUGIN_RESCAN_LOCK_TTL_MS;
  delete process.env.PLUGIN_RESCAN_STARTUP_DELAY_MS;
  delete process.env.PLUGIN_VULN_MAX_CRITICAL;
});

describe('rescanAllPlugins — (a) tenant plugin rows', () => {
  it('forces a DB refresh, then rescans every image plugin across orgs as superadmin', async () => {
    plugin('1');
    plugin('2', { orgId: 'org-2', imageDigest: DIGEST('c') });
    mockScanPluginImage
      .mockResolvedValueOnce({ scan: scan(0, 1, { medium: 2, low: 3, highFixable: 1 }), packages: [] })
      .mockResolvedValueOnce({ scan: scan(1, 0), packages: [] });

    const r = await rescan.rescanAllPlugins();

    expect(mockRefreshVulnDb).toHaveBeenCalledWith({ force: true });
    expect(mockRefreshVulnDb.mock.invocationCallOrder[0]!).toBeLessThan(mockScanPluginImage.mock.invocationCallOrder[0]!);
    expect(tenantContexts).toEqual([{ isSuperAdmin: true }]);
    expect(mockScanPluginImage).toHaveBeenCalledWith({ orgId: 'org-1', name: 'p-1', imageDigest: DIGEST('a') }, expect.objectContaining({ host: 'registry' }), 'rescan');
    expect(r).toEqual({
      total: 2,
      rescanned: 2,
      failed: 0,
      listed: 0,
      newCriticalOrHigh: 2,
      advisoryDrafts: 0,
      flagged: 0,
      catalog: { critical: 1, high: 1, medium: 2, low: 3 },
    });
    expect(pluginRow('1')).toMatchObject({ vulnCritical: 0, vulnHigh: 1, vulnMedium: 2, vulnLow: 3, vulnCriticalFixable: 0, vulnHighFixable: 1, scanFlaggedAt: null, scanFlag: null });
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_catalog_findings', { severity: 'critical' }, 1);
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_rescan_plugins', { state: 'total' }, 2);
  });

  it('skips deleted, inactive and image-less rows, and pages by id', async () => {
    plugin('del', { deletedAt: new Date() });
    plugin('off', { isActive: false });
    plugin('noimg', { imageDigest: null });
    for (let i = 0; i < 205; i++) plugin(`r${String(i).padStart(4, '0')}`, { imageDigest: DIGEST('a') });
    const r = await rescan.rescanAllPlugins();
    expect(r.total).toBe(205);
    // One digest across all of them: scanned ONCE.
    expect(mockScanPluginImage).toHaveBeenCalledTimes(1);
  });

  it('flags a version whose FIXABLE criticals exceed PLUGIN_VULN_MAX_CRITICAL, keeps the first flag time, and clears it when resolved', async () => {
    plugin('1', { vulnCritical: 0 });
    const findings = [finding('CVE-1'), finding('CVE-2', 'critical', [])];
    mockScanPluginImage.mockResolvedValue({ scan: scan(2, 0, { criticalFixable: 1, findings }), packages: [] });

    await rescan.rescanAllPlugins();
    const flaggedAt = pluginRow('1').scanFlaggedAt as Date;
    expect(flaggedAt).toBeInstanceOf(Date);
    expect(pluginRow('1').scanFlag).toEqual({ critical: 1, high: 0, maxCritical: 0, findings: [finding('CVE-1')] });

    // Still flagged next pass: the flag keeps its original time.
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlaggedAt).toBe(flaggedAt);

    // Resolved (rebuilt / fixed upstream): unflagged.
    mockScanPluginImage.mockResolvedValue({ scan: scan(1, 0, { criticalFixable: 0, findings: [finding('CVE-2', 'critical', [])] }), packages: [] });
    await rescan.rescanAllPlugins();
    expect(pluginRow('1')).toMatchObject({ scanFlaggedAt: null, scanFlag: null });
  });

  it('counts only FIXABLE criticals against the floor, and -1 disables it', async () => {
    plugin('1');
    mockScanPluginImage.mockResolvedValue({ scan: scan(5, 0, { criticalFixable: 0, findings: [finding('CVE-1', 'critical', [])] }), packages: [] });
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlaggedAt).toBeNull();

    process.env.PLUGIN_VULN_MAX_CRITICAL = '-1';
    mockScanPluginImage.mockResolvedValue({ scan: scan(5, 0, { criticalFixable: 5, findings: [finding('CVE-1')] }), packages: [] });
    await rescan.rescanAllPlugins();
    expect(pluginRow('1').scanFlaggedAt).toBeNull();
  });

  it('reports new findings to the owning org (N31, uploader included) and to the metrics', async () => {
    plugin('1', { vulnCritical: 1, vulnHigh: 0, createdBy: 'uploader-1' });
    const findings = [finding('CVE-1'), finding('CVE-9', 'high')];
    mockScanPluginImage.mockResolvedValue({ scan: scan(2, 1, { criticalFixable: 1, highFixable: 1, findings }), packages: [] });

    const r = await rescan.rescanAllPlugins();

    expect(r.newCriticalOrHigh).toBe(1);
    expect(mockOnNewCriticalOrHigh).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', listingVersionIds: [], imageDigest: DIGEST('a') }),
      { critical: 1, high: 0 },
      expect.objectContaining({ critical: 2 }),
    );
    expect(mockNotifyRescanFindings).toHaveBeenCalledWith({
      versionKey: 'plugin:1',
      plugin: 'p-1',
      version: '1.0.0',
      critical: 2,
      high: 1,
      findings,
      flagged: true,
      orgs: [{ orgId: 'org-1', uploaderId: 'uploader-1' }],
    });
  });

  it('does not report unchanged counts; an unscanned row\'s findings are all new', async () => {
    plugin('1', { vulnCritical: 1, vulnHigh: 1 });
    plugin('2', { scannedAt: null, vulnCritical: null, vulnHigh: null, imageDigest: DIGEST('c') });
    mockScanPluginImage.mockResolvedValue({ scan: scan(1, 1), packages: [] });
    const r = await rescan.rescanAllPlugins();
    expect(r.newCriticalOrHigh).toBe(1);
    expect(mockOnNewCriticalOrHigh).toHaveBeenCalledTimes(1);
    expect(mockOnNewCriticalOrHigh.mock.calls[0]![1]).toBeNull();
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
      .mockResolvedValueOnce({ scan: null, packages: null })
      .mockRejectedValueOnce(new Error('unexpected'))
      .mockResolvedValueOnce({ scan: scan(0, 0), packages: [] });
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
    listed('lv-1', { sourcePluginId: 'gone', vulnCritical: 0 });
    const findings = [finding('CVE-2026-1')];
    mockScanPluginImage.mockResolvedValue({ scan: scan(1, 0, { criticalFixable: 1, findings }), packages: [] });
    mockInstallingOrgs.mockResolvedValue([{ orgId: 'org-x', install: null }, { orgId: 'org-y', install: null }]);

    const r = await rescan.rescanAllPlugins();

    expect(mockScanPluginImage).toHaveBeenCalledWith(
      { orgId: '000000000000000000000001', name: 'lint', imageDigest: DIGEST('b'), imageRepository: 'public/acme/lint' },
      expect.objectContaining({ host: 'registry' }), 'rescan');
    expect(listedRow('lv-1')).toMatchObject({ vulnCritical: 1, vulnCriticalFixable: 1, scanFlag: expect.objectContaining({ critical: 1 }) });
    expect(listedRow('lv-1').scanFlaggedAt).toBeInstanceOf(Date);
    expect(mockOpenRescanDraft).toHaveBeenCalledWith({ listingVersion: expect.objectContaining({ id: 'lv-1', version: '1.0.0' }), findings });
    expect(mockInstallingOrgs).toHaveBeenCalledWith(PUBLISHER, LISTING, '1.0.0');
    expect(mockNotifyRescanFindings).toHaveBeenCalledWith(expect.objectContaining({
      versionKey: 'listing-version:lv-1',
      plugin: 'acme/lint',
      version: '1.0.0',
      flagged: true,
      orgs: [{ orgId: 'org-x' }, { orgId: 'org-y' }],
    }));
    expect(r).toMatchObject({ total: 1, listed: 1, rescanned: 1, advisoryDrafts: 1, newCriticalOrHigh: 1, flagged: 1 });
  });

  it('scans each image once per pass: a listed copy sharing its source row\'s digest reuses that scan', async () => {
    plugin('1', { imageDigest: DIGEST('b') });
    listed('lv-1', { sourcePluginId: '1' });
    mockScanPluginImage.mockResolvedValue({ scan: scan(0, 2), packages: [] });
    const r = await rescan.rescanAllPlugins();
    expect(mockScanPluginImage).toHaveBeenCalledTimes(1);
    expect(listedRow('lv-1')).toMatchObject({ vulnHigh: 2 });
    expect(r).toMatchObject({ total: 2, rescanned: 2, catalog: { critical: 0, high: 2, medium: 0, low: 0 } });
  });

  it('a digest whose tenant-namespace scan failed is retried from the public copy', async () => {
    plugin('1', { imageDigest: DIGEST('b') });
    listed('lv-1');
    mockScanPluginImage.mockResolvedValueOnce({ scan: null, packages: null }).mockResolvedValueOnce({ scan: scan(0, 0), packages: [] });
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

  it('a yanked version still gets its facts and draft checks, but installers are not told', async () => {
    listed('lv-1', { yankedAt: new Date() });
    mockScanPluginImage.mockResolvedValue({ scan: scan(1, 0, { findings: [finding('CVE-1')] }), packages: [] });
    await rescan.rescanAllPlugins();
    expect(listedRow('lv-1').vulnCritical).toBe(1);
    expect(mockOpenRescanDraft).toHaveBeenCalled();
    expect(mockNotifyRescanFindings).not.toHaveBeenCalled();
  });

  it('compares a listed version against ITS OWN stored facts', async () => {
    listed('lv-same', { vulnCritical: 2, vulnHigh: 0 });
    listed('lv-lag', { vulnCritical: 0, vulnHigh: 0, imageDigest: DIGEST('c') });
    listed('lv-new', { vulnCritical: null, vulnHigh: null, scannedAt: null, imageDigest: DIGEST('d') });
    mockScanPluginImage.mockResolvedValue({ scan: scan(2, 0), packages: [] });
    mockOpenRescanDraft.mockResolvedValueOnce({ id: 'adv-1' }).mockResolvedValueOnce(null); // the second was deduplicated
    const r = await rescan.rescanAllPlugins();
    expect(mockOpenRescanDraft.mock.calls.map((c) => (c[0] as any).listingVersion.id)).toEqual(['lv-lag', 'lv-new']);
    expect(r.advisoryDrafts).toBe(1);
  });

  it('an unreadable installer set never fails the pass', async () => {
    listed('lv-1');
    mockScanPluginImage.mockResolvedValue({ scan: scan(1, 0), packages: [] });
    mockInstallingOrgs.mockRejectedValue(new Error('db blip'));
    const r = await rescan.rescanAllPlugins();
    expect(r).toMatchObject({ rescanned: 1, failed: 0 });
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
      lock: { key: 'plugin:vuln-rescan:leader', ttlMs: 6 * 60 * 60 * 1000 },
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

  it('its run executes one tick against the injected Redis', async () => {
    const r = { get: jest.fn(async (_k: string) => String(Date.now())), set: jest.fn() };
    rescan.createVulnRescanScheduler(() => r as any);
    await mockCreateScheduler.mock.calls[0]![0].run();
    expect(r.get).toHaveBeenCalledWith(rescan.LAST_COMPLETED_KEY);
    expect(mockRefreshVulnDb).not.toHaveBeenCalled(); // not due
  });
});
