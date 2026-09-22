// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for queue/vuln-rescan: the nightly pass over every image plugin
 * (DB refresh, per-row rescan + persistence, listing-version sync, new
 * critical/high detection, failure isolation), the tick's stale detection off
 * the last-completed timestamp in Redis, and the leader-locked scheduler.
 * The database is a fake drizzle transaction; the scanner is mocked.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

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
  scanColumns: (scan: any) => ({ vulnCritical: scan.critical, vulnHigh: scan.high, vulnMedium: scan.medium, vulnLow: scan.low, scannedAt: scan.scannedAt }),
}));

// -- advisory drafts --------------------------------------------------------
const mockOpenRescanDraft = jest.fn<(...a: any[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/services/ecosystem/advisories.js', () => ({ openRescanDraft: mockOpenRescanDraft }));

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
interface Row {
  id: string;
  orgId: string;
  name: string;
  version: string;
  imageDigest: string | null;
  vulnCritical: number | null;
  vulnHigh: number | null;
  scannedAt: Date | null;
  runAsRoot: boolean | null;
}
let rows: Row[] = [];
let pageLimits: number[] = [];
const pluginUpdates: Array<{ set: Record<string, unknown>; where: unknown }> = [];
const listingUpdates: Array<{ set: Record<string, unknown>; where: unknown }> = [];
const tenantContexts: unknown[] = [];

const T = { plugin: { __t: 'plugin', id: 'id' }, pluginListingVersion: { __t: 'listing', id: 'lvid', sourcePluginId: 'src', imageDigest: 'dig' } };
jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
  or: (...parts: unknown[]) => ({ op: 'or', parts }),
  eq: (c: unknown, v: unknown) => ({ op: 'eq', c, v }),
  gt: (c: unknown, v: unknown) => ({ op: 'gt', c, v }),
  isNull: (c: unknown) => ({ op: 'isNull', c }),
  isNotNull: (c: unknown) => ({ op: 'isNotNull', c }),
  asc: (c: unknown) => c,
}));
function cursorOf(cond: any): string | undefined {
  return cond?.parts?.find((p: any) => p?.op === 'gt')?.v;
}
/** Listing versions by source plugin id, as stored BEFORE the pass. */
let listedPriors: Record<string, Array<Record<string, unknown>>> = {};
const tx = {
  select: () => ({
    from: (table: { __t: string }) => ({
      where: (cond: any) => ({
        // listing-version priors: `select … where(or(source = id, digest = …))`, awaited directly.
        then: (resolve: (v: unknown) => unknown) => resolve(table.__t === 'listing' ? listedPriors[cond?.parts?.[0]?.v] ?? [] : []),
        orderBy: () => ({
          limit: async (n: number) => {
            pageLimits.push(n);
            const after = cursorOf(cond);
            return rows.filter((r) => after === undefined || r.id > after).sort((a, b) => a.id.localeCompare(b.id)).slice(0, n);
          },
        }),
      }),
    }),
  }),
  update: (table: { __t: string }) => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: unknown) => {
        (table.__t === 'plugin' ? pluginUpdates : listingUpdates).push({ set, where });
        const done = Promise.resolve(undefined);
        return Object.assign(done, { returning: async () => (table.__t === 'listing' ? listingIdsFor(where) : []) });
      },
    }),
  }),
};
let listingIds: Record<string, string[]> = {};
function listingIdsFor(where: any): Array<{ id: string }> {
  const pluginId = where?.parts?.[0]?.v as string;
  return (listingIds[pluginId] ?? []).map((id) => ({ id }));
}
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: T,
  withTenantTx: async (fn: (t: typeof tx) => unknown) => fn(tx),
  runWithTenantContext: async (ctx: unknown, fn: () => unknown) => { tenantContexts.push(ctx); return fn(); },
}));

const rescan = await import('../src/queue/vuln-rescan.js');

const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  orgId: 'org-1',
  name: `p-${id}`,
  version: '1.0.0',
  imageDigest: DIGEST('a'),
  vulnCritical: 0,
  vulnHigh: 0,
  scannedAt: new Date('2026-09-01'),
  runAsRoot: false,
  ...over,
});
const scan = (c: number, h: number, m = 0, l = 0) => ({ critical: c, high: h, medium: m, low: l, scannedAt: new Date('2026-09-21'), findings: [] });

beforeEach(() => {
  jest.clearAllMocks();
  rows = [];
  pageLimits = [];
  pluginUpdates.length = 0;
  listingUpdates.length = 0;
  tenantContexts.length = 0;
  listingIds = {};
  listedPriors = {};
  mockOpenRescanDraft.mockResolvedValue({ id: 'adv-1' });
  mockRefreshVulnDb.mockResolvedValue(undefined);
  mockScanPluginImage.mockResolvedValue({ scan: scan(0, 0), packages: [] });
});
afterEach(() => {
  delete process.env.PLUGIN_RESCAN_ENABLED;
  delete process.env.PLUGIN_RESCAN_INTERVAL_MS;
  delete process.env.PLUGIN_RESCAN_LOCK_TTL_MS;
  delete process.env.PLUGIN_RESCAN_STARTUP_DELAY_MS;
});

describe('rescanAllPlugins', () => {
  it('forces a DB refresh, then rescans every image plugin across orgs as superadmin', async () => {
    rows = [row('1'), row('2', { orgId: 'org-2' })];
    mockScanPluginImage.mockResolvedValueOnce({ scan: scan(0, 1, 2, 3), packages: [] }).mockResolvedValueOnce({ scan: scan(1, 0), packages: [] });

    const r = await rescan.rescanAllPlugins();

    expect(mockRefreshVulnDb).toHaveBeenCalledWith({ force: true });
    expect(mockRefreshVulnDb.mock.invocationCallOrder[0]!).toBeLessThan(mockScanPluginImage.mock.invocationCallOrder[0]!);
    expect(tenantContexts).toEqual([{ isSuperAdmin: true }]);
    expect(mockScanPluginImage).toHaveBeenCalledWith({ orgId: 'org-1', name: 'p-1', imageDigest: DIGEST('a') }, expect.objectContaining({ host: 'registry' }), 'rescan');
    expect(r).toEqual({ total: 2, rescanned: 2, failed: 0, newCriticalOrHigh: 2, advisoryDrafts: 0, catalog: { critical: 1, high: 1, medium: 2, low: 3 } });
    expect(pluginUpdates[0]!.set).toEqual({ vulnCritical: 0, vulnHigh: 1, vulnMedium: 2, vulnLow: 3, scannedAt: expect.any(Date), runAsRoot: false });
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_catalog_findings', { severity: 'critical' }, 1);
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_rescan_plugins', { state: 'total' }, 2);
  });

  it('pages through the catalog by id', async () => {
    rows = Array.from({ length: 205 }, (_, i) => row(String(i).padStart(4, '0')));
    const r = await rescan.rescanAllPlugins();
    expect(r.total).toBe(205);
    expect(pageLimits).toEqual([100, 100, 100]);
  });

  it('syncs listing versions published from the row and reports new findings with them', async () => {
    rows = [row('1', { vulnCritical: 1, vulnHigh: 0 })];
    listingIds = { 1: ['lv-1'] };
    mockScanPluginImage.mockResolvedValue({ scan: scan(2, 0), packages: [] });

    const r = await rescan.rescanAllPlugins();

    expect(listingUpdates[0]!.set).toEqual({ vulnCritical: 2, vulnHigh: 0, scannedAt: expect.any(Date) });
    expect(r.newCriticalOrHigh).toBe(1);
    expect(mockOnNewCriticalOrHigh).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', listingVersionIds: ['lv-1'], imageDigest: DIGEST('a') }),
      { critical: 1, high: 0 },
      expect.objectContaining({ critical: 2 }),
    );
  });

  it('opens a private advisory draft for a LISTED version whose counts grew past its own stored facts', async () => {
    const findings = [{ id: 'CVE-2026-1', severity: 'critical', packageName: 'openssl', packageVersion: '3.0.0' }];
    rows = [row('1', { vulnCritical: 1, vulnHigh: 0 })];
    listingIds = { 1: ['lv-1', 'lv-2', 'lv-3'] };
    listedPriors = {
      1: [
        // Stored facts already at 2 critical: nothing new for this copy.
        { id: 'lv-1', listingId: 'l-1', version: '1.0.0', yankedAt: null, vulnCritical: 2, vulnHigh: 0, scannedAt: new Date('2026-09-01') },
        // Stored facts lag at 0 critical: new.
        { id: 'lv-2', listingId: 'l-2', version: '1.0.0', yankedAt: null, vulnCritical: 0, vulnHigh: 0, scannedAt: new Date('2026-09-01') },
        // Never scanned: every finding is new.
        { id: 'lv-3', listingId: 'l-3', version: '1.0.0', yankedAt: null, vulnCritical: null, vulnHigh: null, scannedAt: null },
      ],
    };
    mockScanPluginImage.mockResolvedValue({ scan: { ...scan(2, 0), findings }, packages: [] });
    mockOpenRescanDraft.mockResolvedValueOnce({ id: 'adv-1' }).mockResolvedValueOnce(null); // the second was deduplicated

    const r = await rescan.rescanAllPlugins();

    expect(mockOpenRescanDraft.mock.calls.map((c) => (c[0] as any).listingVersion.id)).toEqual(['lv-2', 'lv-3']);
    expect(mockOpenRescanDraft).toHaveBeenCalledWith({ listingVersion: expect.objectContaining({ id: 'lv-2', version: '1.0.0' }), findings });
    expect(r.advisoryDrafts).toBe(1);
    // The listing versions' facts are updated regardless.
    expect(listingUpdates[0]!.set).toEqual({ vulnCritical: 2, vulnHigh: 0, scannedAt: expect.any(Date) });
  });

  it('does not flag unchanged counts; an unscanned row\'s findings are all new', async () => {
    rows = [row('1', { vulnCritical: 1, vulnHigh: 1 }), row('2', { scannedAt: null, vulnCritical: null, vulnHigh: null })];
    mockScanPluginImage.mockResolvedValue({ scan: scan(1, 1), packages: [] });
    const r = await rescan.rescanAllPlugins();
    expect(r.newCriticalOrHigh).toBe(1);
    expect(mockOnNewCriticalOrHigh).toHaveBeenCalledTimes(1);
    expect(mockOnNewCriticalOrHigh.mock.calls[0]![1]).toBeNull();
  });

  it('fills runAsRoot only where unknown, and leaves it unknown when the config is unreadable', async () => {
    rows = [row('1', { runAsRoot: null }), row('2', { runAsRoot: null }), row('3', { runAsRoot: true })];
    mockInspectRunAsRoot.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('crane 401'));
    await rescan.rescanAllPlugins();
    expect(mockInspectRunAsRoot).toHaveBeenCalledTimes(2);
    expect(pluginUpdates[0]!.set).toMatchObject({ runAsRoot: true });
    expect(pluginUpdates[1]!.set).not.toHaveProperty('runAsRoot');
    expect(pluginUpdates[2]!.set).toMatchObject({ runAsRoot: true });
  });

  it('an image that fails to rescan keeps its previous scan and is counted failed; the pass continues', async () => {
    rows = [row('1'), row('2'), row('3')];
    mockScanPluginImage
      .mockResolvedValueOnce({ scan: null, packages: null })
      .mockRejectedValueOnce(new Error('unexpected'))
      .mockResolvedValueOnce({ scan: scan(0, 0), packages: [] });
    const r = await rescan.rescanAllPlugins();
    expect(r).toMatchObject({ total: 3, rescanned: 1, failed: 2 });
    expect(pluginUpdates).toHaveLength(1);
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_rescan_plugins', { state: 'failed' }, 2);
  });

  it('does not run at all when the DB refresh fails', async () => {
    rows = [row('1')];
    mockRefreshVulnDb.mockRejectedValue(new Error('db offline'));
    await expect(rescan.rescanAllPlugins()).rejects.toThrow('db offline');
    expect(mockScanPluginImage).not.toHaveBeenCalled();
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
    // Nothing published before the pass; only its own completion afterwards.
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
