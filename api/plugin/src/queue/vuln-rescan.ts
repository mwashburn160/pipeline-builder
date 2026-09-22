// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly vulnerability rescan (W0.6).
 *
 * New CVEs are published against packages that were clean when the image was
 * built, so a build-time scan goes stale. Once per `PLUGIN_RESCAN_INTERVAL_MS`
 * (default 24 h) this job refreshes grype's vulnerability DB and re-scans the
 * signed SBOM of every active, non-deleted image plugin, updating its
 * `vuln*`/`scannedAt` (and filling `runAsRoot` where unknown), plus the
 * `plugin_listing_versions` rows published from it. A version whose critical or
 * high count grows goes to {@link onNewCriticalOrHigh}; a LISTED version whose
 * count grows past its own stored facts gets a private advisory draft (W8,
 * `openRescanDraft`: deduplicated per listing version and CVE set, N20).
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

import { createLogger, createScheduler, errorMessage, type Scheduler } from '@pipeline-builder/api-core';
import { incCounter, setGauge } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import { runWithTenantContext, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, asc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';

import { getHealthRedisConnection } from './connections.js';
import { intFromEnv } from './env-int.js';
import type { RegistryInfo } from '../helpers/registry-auth.js';
import {
  hasNewCriticalOrHigh,
  inspectRunAsRoot,
  onNewCriticalOrHigh,
  refreshVulnDb,
  scanColumns,
  scanPluginImage,
  type VulnCounts,
} from '../helpers/vuln-scan.js';
import { openRescanDraft } from '../services/ecosystem/advisories.js';

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
  return intFromEnv('PLUGIN_RESCAN_INTERVAL_MS', 24 * 60 * 60 * 1000);
}

/** The Redis surface the rescan's bookkeeping needs (ioredis satisfies it). */
export interface RescanRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

/** One image plugin as the rescan reads it. */
interface RescanRow {
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

export interface RescanPassResult {
  total: number;
  rescanned: number;
  failed: number;
  newCriticalOrHigh: number;
  /** Private advisory drafts opened for listed versions (W8). */
  advisoryDrafts: number;
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
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A listing version published from a rescanned image, with its facts BEFORE this pass. */
interface ListedPrior {
  id: string;
  listingId: string;
  version: string;
  yankedAt: Date | null;
  vulnCritical: number | null;
  vulnHigh: number | null;
  scannedAt: Date | null;
}

/** The listing versions published from this plugin row's image, as stored before the update. */
async function listedPriors(row: RescanRow): Promise<ListedPrior[]> {
  const v = schema.pluginListingVersion;
  return withTenantTx((tx) => tx
    .select({ id: v.id, listingId: v.listingId, version: v.version, yankedAt: v.yankedAt, vulnCritical: v.vulnCritical, vulnHigh: v.vulnHigh, scannedAt: v.scannedAt })
    .from(v)
    .where(or(eq(v.sourcePluginId, row.id), eq(v.imageDigest, row.imageDigest!))));
}

/** The listing versions published from this plugin row's image; updates their scan. */
async function updateListingVersions(row: RescanRow, cols: ReturnType<typeof scanColumns>): Promise<string[]> {
  const v = schema.pluginListingVersion;
  const updated = await withTenantTx((tx) => tx
    .update(v)
    .set({ vulnCritical: cols.vulnCritical, vulnHigh: cols.vulnHigh, scannedAt: cols.scannedAt })
    .where(or(eq(v.sourcePluginId, row.id), eq(v.imageDigest, row.imageDigest!)))
    .returning({ id: v.id }));
  return updated.map((r: { id: string }) => r.id);
}

/** Rescan one image plugin. Returns whether it was rescanned, whether it gained critical/high findings, and the advisory drafts opened. */
async function rescanOne(row: RescanRow, registry: RegistryInfo, catalog: VulnCounts): Promise<{ rescanned: boolean; newFindings: boolean; drafts: number }> {
  const ref = { orgId: row.orgId, name: row.name, imageDigest: row.imageDigest };
  const { scan } = await scanPluginImage(ref, registry, 'rescan');
  if (!scan) return { rescanned: false, newFindings: false, drafts: 0 };

  let runAsRoot = row.runAsRoot;
  if (runAsRoot === null) {
    runAsRoot = await inspectRunAsRoot(ref, registry).catch((err) => {
      logger.warn('Image config unreadable; runAsRoot stays unknown', { pluginId: row.id, error: errorMessage(err) });
      return null;
    });
  }

  const cols = scanColumns(scan);
  const priors = await listedPriors(row);
  await withTenantTx((tx) => tx
    .update(schema.plugin)
    .set({ ...cols, ...(runAsRoot !== null ? { runAsRoot } : {}) })
    .where(eq(schema.plugin.id, row.id)));
  const listingVersionIds = await updateListingVersions(row, cols);

  catalog.critical += scan.critical;
  catalog.high += scan.high;
  catalog.medium += scan.medium;
  catalog.low += scan.low;

  const before = row.scannedAt ? { critical: row.vulnCritical ?? 0, high: row.vulnHigh ?? 0 } : null;
  const newFindings = hasNewCriticalOrHigh(before, scan);
  if (newFindings) {
    onNewCriticalOrHigh({
      id: row.id,
      orgId: row.orgId,
      name: row.name,
      version: row.version,
      imageDigest: row.imageDigest!,
      listingVersionIds,
    }, before, scan);
  }

  // W8: a LISTED version compared against ITS OWN stored facts (the listing
  // copy can lag the org row, e.g. after an earlier failed sync).
  let drafts = 0;
  for (const lv of priors) {
    const lvBefore = lv.scannedAt ? { critical: lv.vulnCritical ?? 0, high: lv.vulnHigh ?? 0 } : null;
    if (!hasNewCriticalOrHigh(lvBefore, scan)) continue;
    if (await openRescanDraft({ listingVersion: lv, findings: scan.findings })) drafts++;
  }
  return { rescanned: true, newFindings, drafts };
}

/**
 * One full pass over every active, non-deleted image plugin, across all orgs.
 * Throws when the vulnerability DB can't be refreshed (the pass did not run).
 */
export async function rescanAllPlugins(): Promise<RescanPassResult> {
  await refreshVulnDb({ force: true });
  const registry = Config.get('registry') as RegistryInfo;
  const result: RescanPassResult = { total: 0, rescanned: 0, failed: 0, newCriticalOrHigh: 0, advisoryDrafts: 0, catalog: { critical: 0, high: 0, medium: 0, low: 0 } };

  await runWithTenantContext({ isSuperAdmin: true }, async () => {
    const p = schema.plugin;
    let cursor: string | undefined;
    for (;;) {
      const page: RescanRow[] = await withTenantTx((tx) => tx
        .select({
          id: p.id,
          orgId: p.orgId,
          name: p.name,
          version: p.version,
          imageDigest: p.imageDigest,
          vulnCritical: p.vulnCritical,
          vulnHigh: p.vulnHigh,
          scannedAt: p.scannedAt,
          runAsRoot: p.runAsRoot,
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

      for (const row of page) {
        result.total++;
        try {
          const one = await rescanOne(row, registry, result.catalog);
          if (one.rescanned) result.rescanned++; else result.failed++;
          if (one.newFindings) result.newCriticalOrHigh++;
          result.advisoryDrafts += one.drafts;
        } catch (err) {
          result.failed++;
          logger.error('Plugin rescan failed', { pluginId: row.id, orgId: row.orgId, error: errorMessage(err) });
        }
        publishProgress(result);
      }

      if (page.length < PAGE_SIZE) break;
      cursor = page[page.length - 1]!.id;
    }
  });

  for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
    setGauge('plugin_vuln_catalog_findings', { severity }, result.catalog[severity]);
  }
  return result;
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
    newCriticalOrHigh: pass.newCriticalOrHigh,
    advisoryDrafts: pass.advisoryDrafts,
  });
  return 'completed';
}

/**
 * Build (not start) the leader-locked rescan scheduler, or `null` when
 * `PLUGIN_RESCAN_ENABLED=false`. Env:
 *   PLUGIN_RESCAN_INTERVAL_MS        (default 86400000 — 24 h between passes)
 *   PLUGIN_RESCAN_LOCK_TTL_MS        (default 21600000 — 6 h; must outlast a pass)
 *   PLUGIN_RESCAN_STARTUP_DELAY_MS   (default 120000)
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
    startupDelayMs: intFromEnv('PLUGIN_RESCAN_STARTUP_DELAY_MS', 120_000),
    lock: { redis, key: LOCK_KEY, ttlMs: intFromEnv('PLUGIN_RESCAN_LOCK_TTL_MS', 6 * 60 * 60 * 1000) },
    run: async () => { await runRescanTick(redis()); },
  });
}
