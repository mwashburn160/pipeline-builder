// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly vulnerability rescan.
 *
 * New CVEs are published against packages that were clean when the image was
 * built, so a build-time scan goes stale. Once per `PLUGIN_RESCAN_INTERVAL_MS`
 * (default 24 h) this job refreshes grype's vulnerability DB and re-scans two
 * sets of images, each image (by digest) scanned at most once per pass:
 *
 *  (a) every ACTIVE, non-deleted image plugin (`plugins` rows) — from its own
 *      org's namespace; its `vuln*` / `scannedAt` / flag are updated (and
 *      `runAsRoot` filled where unknown);
 *  (b) every LISTED version (`plugin_listing_versions`) that is not yanked, or
 *      is yanked but whose `public/*` image has not been collected yet — from
 *      ITS OWN public image (`public/<publisher>/<name>@<digest>`, the signed
 *      SBOM read with the plugin service's pull credential), independent of the
 *      source plugin row: a force-deleted or purged source must not leave the
 *      published copy (which installers keep running) unscanned. Its own facts
 *      are updated from its own scan, and its advisory drafts (N20,
 *      `openRescanDraft`) compare against its own stored facts.
 *
 * Scan gates on the result (docs/plugin-publishing.md "Scan gates"):
 *  - a version whose FIXABLE criticals exceed `PLUGIN_VULN_MAX_CRITICAL` is
 *    FLAGGED (`scan_flagged_at` + `scan_flag` = counts + top findings with
 *    fixed versions), and unflagged once a rescan finds them resolved. Lookup
 *    warns on a flagged version (`VULN_FLAGGED`), or skips / refuses it with
 *    `PLUGIN_BLOCK_ON_NEW_CRITICAL`;
 *  - a version whose critical or high count grows goes to
 *    {@link onNewCriticalOrHigh} (metrics) and N31 — to the owning org for a
 *    tenant row, to every installing org for a listed version — per each org's
 *    plugin security notification settings, deduplicated per (version, CVE).
 *
 * Scheduling: every pod ticks hourly (or at the interval, if shorter); one pod
 * wins the Redis leader lock per tick, and runs a pass only when the last
 * COMPLETED pass (a timestamp in Redis) is older than the interval — so N
 * replicas still rescan once per interval, not N times. The same timestamp is
 * exported by every pod as `plugin_vuln_rescan_last_completed_timestamp_seconds`,
 * which the `PluginVulnRescanStale` alert watches (36 h).
 *
 * A pass whose DB refresh fails does not run and does not count as completed:
 * rescanning with yesterday's DB would stamp a fresh `scannedAt` on stale data.
 * A single image that fails to rescan keeps its previous scan (its `scannedAt`
 * still says when that was) and is counted in the progress metrics.
 */

import { envInt, createLogger, createScheduler, errorMessage, SYSTEM_ORG_ID, type PluginScanFlag, type Scheduler } from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, asc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';

import { getHealthRedisConnection } from './connections.js';
import type { RegistryInfo } from '../helpers/registry-auth.js';
import { scanFlagFor } from '../helpers/scan-gates.js';
import type { PluginImageRef } from '../helpers/supply-chain.js';
import {
  hasNewCriticalOrHigh,
  inspectRunAsRoot,
  onNewCriticalOrHigh,
  refreshVulnDb,
  scanColumns,
  scanPluginImage,
  type VulnCounts,
  type VulnScanResult,
} from '../helpers/vuln-scan.js';
import { openRescanDraft } from '../services/ecosystem/advisories.js';
import { installingOrgs } from '../services/ecosystem/install-notify.js';
import { listings, publishers } from '../services/ecosystem/store.js';
import { isActiveListing } from '../services/ecosystem/util.js';
import { notifyRescanFindings } from '../services/plugin-security-notifications.js';

const logger = createLogger('vuln-rescan');

const LOCK_KEY = 'plugin:vuln-rescan:leader';
/** Epoch ms of the last completed pass. */
export const LAST_COMPLETED_KEY = 'plugin:vuln-rescan:last-completed';
const PAGE_SIZE = 100;

/** `PLUGIN_RESCAN_ENABLED=false` switches the nightly rescan off (default on). */
export function isRescanEnabled(): boolean {
  return (process.env.PLUGIN_RESCAN_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function rescanIntervalMs(): number {
  return envInt('PLUGIN_RESCAN_INTERVAL_MS', 24 * 60 * 60 * 1000, { min: 1 });
}

/** The Redis surface the rescan's bookkeeping needs (ioredis satisfies it). */
export interface RescanRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

/** One image plugin (set a) as the rescan reads it. */
interface TenantRow {
  id: string;
  orgId: string;
  name: string;
  version: string;
  imageDigest: string | null;
  vulnCritical: number | null;
  vulnHigh: number | null;
  scannedAt: Date | null;
  scanFlaggedAt: Date | null;
  runAsRoot: boolean | null;
  createdBy: string | null;
}

/** One listed version (set b) as the rescan reads it. */
interface ListedRow {
  id: string;
  listingId: string;
  version: string;
  imageDigest: string | null;
  imageRepository: string | null;
  yankedAt: Date | null;
  vulnCritical: number | null;
  vulnHigh: number | null;
  scannedAt: Date | null;
  scanFlaggedAt: Date | null;
}

export interface RescanPassResult {
  /** Plugin rows + listed versions visited. */
  total: number;
  rescanned: number;
  failed: number;
  /** Of `total`, the listed versions (set b). */
  listed: number;
  newCriticalOrHigh: number;
  /** Private advisory drafts opened for listed versions. */
  advisoryDrafts: number;
  /** Versions flagged after this pass (fixable criticals over the floor). */
  flagged: number;
  /** Findings across the DISTINCT images scanned this pass. */
  catalog: VulnCounts;
}

function publishLastCompleted(epochMs: number | null): void {
  if (epochMs !== null) setGauge('plugin_vuln_rescan_last_completed_timestamp_seconds', {}, Math.floor(epochMs / 1000));
}

function publishProgress(p: Pick<RescanPassResult, 'total' | 'rescanned' | 'failed'>): void {
  setGauge('plugin_vuln_rescan_plugins', { state: 'total' }, p.total);
  setGauge('plugin_vuln_rescan_plugins', { state: 'rescanned' }, p.rescanned);
  setGauge('plugin_vuln_rescan_plugins', { state: 'failed' }, p.failed);
}

async function readLastCompleted(redis: RescanRedis): Promise<number | null> {
  const raw = await redis.get(LAST_COMPLETED_KEY);
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 ? n : null;
}

/** One pass's state: the DISTINCT images already scanned, by digest. */
interface PassContext {
  registry: RegistryInfo;
  scans: Map<string, VulnScanResult>;
  result: RescanPassResult;
  now: Date;
}

/**
 * The scan of one image, scanned at most once per pass (by digest). Only a
 * completed scan is remembered: a failure (e.g. one namespace's pull) is
 * retried when the other set reaches the same digest from its own ref.
 */
async function scanOnce(ctx: PassContext, ref: PluginImageRef & { imageDigest: string }): Promise<VulnScanResult | null> {
  const cached = ctx.scans.get(ref.imageDigest);
  if (cached) return cached;
  const { scan } = await scanPluginImage(ref, ctx.registry, 'rescan');
  if (!scan) return null;
  ctx.scans.set(ref.imageDigest, scan);
  for (const severity of ['critical', 'high', 'medium', 'low'] as const) ctx.result.catalog[severity] += scan[severity];
  return scan;
}

/** The flag columns for a scan: kept since the first flagging rescan, cleared when resolved. */
function flagColumns(scan: VulnScanResult, flaggedBefore: Date | null, now: Date): { scanFlaggedAt: Date | null; scanFlag: PluginScanFlag | null } {
  const flag = scanFlagFor({ vulnCriticalFixable: scan.criticalFixable, vulnHighFixable: scan.highFixable, findings: scan.findings });
  return { scanFlaggedAt: flag ? (flaggedBefore ?? now) : null, scanFlag: flag };
}

const priorCounts = (r: { scannedAt: Date | null; vulnCritical: number | null; vulnHigh: number | null }) =>
  (r.scannedAt ? { critical: r.vulnCritical ?? 0, high: r.vulnHigh ?? 0 } : null);

/** Rescan one image plugin (set a): update it, report new findings to its org. */
async function rescanTenantRow(ctx: PassContext, row: TenantRow): Promise<'rescanned' | 'failed'> {
  const ref = { orgId: row.orgId, name: row.name, imageDigest: row.imageDigest! };
  const scan = await scanOnce(ctx, ref);
  if (!scan) return 'failed';

  let runAsRoot = row.runAsRoot;
  if (runAsRoot === null) {
    runAsRoot = await inspectRunAsRoot(ref, ctx.registry).catch((err) => {
      logger.warn('Image config unreadable; runAsRoot stays unknown', { pluginId: row.id, error: errorMessage(err) });
      return null;
    });
  }

  const flag = flagColumns(scan, row.scanFlaggedAt, ctx.now);
  await withTenantTx((tx) => tx
    .update(schema.plugin)
    .set({ ...scanColumns(scan), ...flag, ...(runAsRoot !== null ? { runAsRoot } : {}) })
    .where(eq(schema.plugin.id, row.id)));
  if (flag.scanFlag) ctx.result.flagged++;

  const before = priorCounts(row);
  if (hasNewCriticalOrHigh(before, scan)) {
    ctx.result.newCriticalOrHigh++;
    onNewCriticalOrHigh({ id: row.id, orgId: row.orgId, name: row.name, version: row.version, imageDigest: row.imageDigest!, listingVersionIds: [] }, before, scan);
    await notifyRescanFindings({
      versionKey: `plugin:${row.id}`,
      plugin: row.name,
      version: row.version,
      critical: scan.critical,
      high: scan.high,
      findings: scan.findings,
      flagged: flag.scanFlag !== null,
      orgs: [{ orgId: row.orgId, uploaderId: row.createdBy }],
    });
  }
  return 'rescanned';
}

/** `public/<handle>/<name>` → `<name>`. */
const nameOfRepository = (repo: string): string => repo.split('/').pop() ?? repo;

/**
 * Rescan one listed version (set b) from its OWN public image: update its own
 * facts and flag, open an advisory draft (N20) and tell the installing orgs
 * (N31) when its counts grew past its own stored facts.
 */
async function rescanListedVersion(ctx: PassContext, lv: ListedRow): Promise<'rescanned' | 'failed'> {
  const repo = lv.imageRepository!;
  const name = nameOfRepository(repo);
  const scan = await scanOnce(ctx, { orgId: SYSTEM_ORG_ID, name, imageDigest: lv.imageDigest!, imageRepository: repo });
  if (!scan) return 'failed';

  const cols = scanColumns(scan);
  const flag = flagColumns(scan, lv.scanFlaggedAt, ctx.now);
  await withTenantTx((tx) => tx
    .update(schema.pluginListingVersion)
    .set({
      vulnCritical: cols.vulnCritical,
      vulnHigh: cols.vulnHigh,
      vulnCriticalFixable: cols.vulnCriticalFixable,
      vulnHighFixable: cols.vulnHighFixable,
      scannedAt: cols.scannedAt,
      ...flag,
    })
    .where(eq(schema.pluginListingVersion.id, lv.id)));
  if (flag.scanFlag) ctx.result.flagged++;

  const before = priorCounts(lv);
  if (!hasNewCriticalOrHigh(before, scan)) return 'rescanned';
  ctx.result.newCriticalOrHigh++;
  onNewCriticalOrHigh({ id: lv.id, orgId: SYSTEM_ORG_ID, name, version: lv.version, imageDigest: lv.imageDigest!, listingVersionIds: [lv.id] }, before, scan);
  if (await openRescanDraft({ listingVersion: lv, findings: scan.findings })) ctx.result.advisoryDrafts++;

  // The orgs whose installs reach this version hear it, under their own settings.
  if (!lv.yankedAt) {
    try {
      const listing = await listings.byId(lv.listingId);
      const publisher = listing ? await publishers.byId(listing.publisherId) : null;
      if (listing && publisher && isActiveListing(listing)) {
        const orgs = await installingOrgs(publisher, listing, lv.version);
        await notifyRescanFindings({
          versionKey: `listing-version:${lv.id}`,
          plugin: `${publisher.handle}/${listing.name}`,
          version: lv.version,
          critical: scan.critical,
          high: scan.high,
          findings: scan.findings,
          flagged: flag.scanFlag !== null,
          orgs: orgs.map((o) => ({ orgId: o.orgId })),
        });
      }
    } catch (err) {
      logger.warn('Installing orgs of a rescanned version unreadable; N31 not sent', { listingVersionId: lv.id, error: errorMessage(err) });
    }
  }
  return 'rescanned';
}

/** Visit one row, isolating its failure from the rest of the pass. */
async function visit(ctx: PassContext, what: Record<string, unknown>, fn: () => Promise<'rescanned' | 'failed'>): Promise<void> {
  ctx.result.total++;
  try {
    if (await fn() === 'rescanned') ctx.result.rescanned++;
    else ctx.result.failed++;
  } catch (err) {
    ctx.result.failed++;
    logger.error('Rescan of one image failed', { ...what, error: errorMessage(err) });
  }
  publishProgress(ctx.result);
}

/** Page through (a): active, non-deleted image plugins, across all orgs. */
async function rescanTenantRows(ctx: PassContext): Promise<void> {
  const p = schema.plugin;
  let cursor: string | undefined;
  for (;;) {
    const page: TenantRow[] = await withTenantTx((tx) => tx
      .select({
        id: p.id,
        orgId: p.orgId,
        name: p.name,
        version: p.version,
        imageDigest: p.imageDigest,
        vulnCritical: p.vulnCritical,
        vulnHigh: p.vulnHigh,
        scannedAt: p.scannedAt,
        scanFlaggedAt: p.scanFlaggedAt,
        runAsRoot: p.runAsRoot,
        createdBy: p.createdBy,
      })
      .from(p)
      .where(and(
        isNull(p.deletedAt),
        eq(p.isActive, true),
        isNotNull(p.imageDigest),
        ...(cursor === undefined ? [] : [gt(p.id, cursor)]),
      ))
      .orderBy(asc(p.id))
      .limit(PAGE_SIZE));
    for (const row of page) await visit(ctx, { pluginId: row.id, orgId: row.orgId }, () => rescanTenantRow(ctx, row));
    if (page.length < PAGE_SIZE) break;
    cursor = page[page.length - 1]!.id;
  }
}

/**
 * Page through (b): every listed version with a public image that is not
 * yanked — or is yanked but whose image is still stored (installs pinned to it
 * keep running it until maintenance collects it).
 */
async function rescanListedVersions(ctx: PassContext): Promise<void> {
  const v = schema.pluginListingVersion;
  let cursor: string | undefined;
  for (;;) {
    const page: ListedRow[] = await withTenantTx((tx) => tx
      .select({
        id: v.id,
        listingId: v.listingId,
        version: v.version,
        imageDigest: v.imageDigest,
        imageRepository: v.imageRepository,
        yankedAt: v.yankedAt,
        vulnCritical: v.vulnCritical,
        vulnHigh: v.vulnHigh,
        scannedAt: v.scannedAt,
        scanFlaggedAt: v.scanFlaggedAt,
      })
      .from(v)
      .where(and(
        isNotNull(v.imageDigest),
        isNotNull(v.imageRepository),
        or(isNull(v.yankedAt), isNull(v.imageCollectedAt)),
        ...(cursor === undefined ? [] : [gt(v.id, cursor)]),
      ))
      .orderBy(asc(v.id))
      .limit(PAGE_SIZE));
    for (const lv of page) {
      ctx.result.listed++;
      await visit(ctx, { listingVersionId: lv.id }, () => rescanListedVersion(ctx, lv));
    }
    if (page.length < PAGE_SIZE) break;
    cursor = page[page.length - 1]!.id;
  }
}

/**
 * One full pass: every active image plugin (a), then every listed version from
 * its own public image (b). Throws when the vulnerability DB can't be
 * refreshed (the pass did not run).
 */
export async function rescanAllPlugins(): Promise<RescanPassResult> {
  await refreshVulnDb({ force: true });
  const ctx: PassContext = {
    registry: Config.get('registry') as RegistryInfo,
    scans: new Map(),
    now: new Date(),
    result: { total: 0, rescanned: 0, failed: 0, listed: 0, newCriticalOrHigh: 0, advisoryDrafts: 0, flagged: 0, catalog: { critical: 0, high: 0, medium: 0, low: 0 } },
  };

  await runWithTenantContext({ isSuperAdmin: true }, async () => {
    await rescanTenantRows(ctx);
    await rescanListedVersions(ctx);
  });

  for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
    setGauge('plugin_vuln_catalog_findings', { severity }, ctx.result.catalog[severity]);
  }
  setGauge('plugin_vuln_flagged_versions', {}, ctx.result.flagged);
  return ctx.result;
}

/**
 * One scheduler tick (runs under the leader lock): publish the last-completed
 * timestamp, and run a pass when it is due. Returns what happened.
 */
export async function runRescanTick(
  redis: RescanRedis,
  now: () => number = Date.now,
): Promise<'skipped' | 'completed' | 'failed'> {
  const last = await readLastCompleted(redis);
  publishLastCompleted(last);
  if (last !== null && now() - last < rescanIntervalMs()) return 'skipped';

  const started = now();
  let pass: RescanPassResult;
  try {
    pass = await rescanAllPlugins();
  } catch (err) {
    incCounter('plugin_vuln_rescan_runs_total', { outcome: 'failed' });
    logger.error('Vulnerability rescan did not run', { error: errorMessage(err) });
    return 'failed';
  }
  const finished = now();
  await redis.set(LAST_COMPLETED_KEY, String(finished));
  publishLastCompleted(finished);
  incCounter('plugin_vuln_rescan_runs_total', { outcome: 'completed' });
  logger.info('Vulnerability rescan completed', {
    durationMs: finished - started,
    total: pass.total,
    rescanned: pass.rescanned,
    failed: pass.failed,
    listed: pass.listed,
    newCriticalOrHigh: pass.newCriticalOrHigh,
    advisoryDrafts: pass.advisoryDrafts,
    flagged: pass.flagged,
  });
  return 'completed';
}

/**
 * Build (not start) the leader-locked rescan scheduler, or `null` when
 * `PLUGIN_RESCAN_ENABLED=false`. Env:
 *   PLUGIN_RESCAN_INTERVAL_MS (default 86400000 — 24 h between passes)
 *   PLUGIN_RESCAN_LOCK_TTL_MS (default 21600000 — 6 h; must outlast a pass)
 *   PLUGIN_RESCAN_STARTUP_DELAY_MS (default 120000)
 */
export function createVulnRescanScheduler(redis: () => ReturnType<typeof getHealthRedisConnection> = getHealthRedisConnection): Scheduler | null {
  if (!isRescanEnabled()) {
    logger.info('Vulnerability rescan disabled (PLUGIN_RESCAN_ENABLED=false)');
    return null;
  }
  const intervalMs = rescanIntervalMs();
  return createScheduler({
    name: 'vuln-rescan',
    intervalMs: Math.min(intervalMs, 60 * 60 * 1000),
    startupDelayMs: envInt('PLUGIN_RESCAN_STARTUP_DELAY_MS', 120_000, { min: 1 }),
    lock: { redis, key: LOCK_KEY, ttlMs: envInt('PLUGIN_RESCAN_LOCK_TTL_MS', 6 * 60 * 60 * 1000, { min: 1 }) },
    run: async () => { await runRescanTick(redis()); },
  });
}
