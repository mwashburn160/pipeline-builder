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
 *  (a) every non-deleted image plugin (`plugins` rows) — ACTIVE OR NOT: an
 *      inactive version is hidden from new resolution, but pipelines already
 *      synthesized against it keep running its pinned digest, so its exposure
 *      is as real as an active one's. Scanned from its own org's namespace; its
 *      `vuln*` / `scannedAt` / summary / flag are updated (and `runAsRoot`
 *      filled where unknown);
 *  (b) every LISTED version (`plugin_listing_versions`) that is not yanked, or
 *      is yanked but whose `public/*` image has not been collected yet — from
 *      ITS OWN public image (`public/<publisher>/<name>@<digest>`, the signed
 *      SBOM read with the plugin service's pull credential), independent of the
 *      source plugin row: a force-deleted or purged source must not leave the
 *      published copy (which installers keep running) unscanned. Its own facts
 *      are updated from its own scan, and its advisory drafts (N20,
 *      `openRescanDraft`) compare against its own stored facts.
 *
 * Every scanned version gets a fresh `scan_summary` — all Critical/High
 * findings, counts, the DB build time, the binaries the scanner cannot see —
 * and that summary is the next pass's BASELINE: "new" means a finding identity
 * (advisory × package × version) the previous summary did not carry, never "a
 * bigger count" (one CVE fixed and another published leaves the count flat).
 * A version with NO previous summary (scanned before summaries existed) has no
 * baseline: its first rescan only ESTABLISHES one, and reports nothing as new
 * unless that rescan newly flags it — then the flag's findings are the news.
 * Otherwise the first pass after an upgrade would notify every finding of every
 * old version at once.
 *
 * The fresh summary is then fanned out to the pipelines on the version
 * (`syncVersionExposures`): exposures opened / refreshed for every pipeline
 * declaring or running that image, or closed when it came back clean.
 *
 * Scan gates on the result (docs/plugin-publishing.md "Scan gates"):
 *  - a version whose GATED criticals (fixable, or KEV-listed under
 *    `PLUGIN_VULN_GATE_KEV`) exceed `PLUGIN_VULN_MAX_FINDINGS` is FLAGGED
 *    (`scan_flagged_at` + `scan_flag`), and unflagged once a rescan finds them
 *    resolved — each transition audited (`plugin.vuln.flagged` /
 *    `plugin.vuln.cleared`), as is a waiver newly applied by a rescan
 *    (`plugin.vuln.waived`). Lookup grades a flagged version `error`
 *    (`VULN_FLAGGED`) — it never skips or refuses it;
 *  - a version with NEW critical/high findings goes to
 *    {@link onNewCriticalOrHigh} (metrics) and N31 — to the owning org for a
 *    tenant row, to every installing org for a listed version (yanked ones
 *    included: installs pinned to them still run them) — per each org's
 *    plugin security notification settings, deduplicated per (version, CVE).
 *
 * Every tick (due or not) also sweeps expired kept setup images
 * (services/kept-setup-images.ts).
 *
 * Waivers: every active `PLUGIN_VULN_WAIVERS` entry that exempted NOTHING in a
 * completed pass is exported as `plugin_vuln_waiver_unmatched{plugin,targets}`
 * = 1 — an exemption nobody needs any more is one nobody is reviewing either.
 *
 * Scheduling: every pod ticks hourly (or at the interval, if shorter); one pod
 * wins the Redis leader lock per tick, and runs a pass only when the last
 * COMPLETED pass (a timestamp in Redis) is older than the interval — so N
 * replicas still rescan once per interval, not N times. The same timestamp is
 * exported by every pod as `plugin_vuln_rescan_last_completed_timestamp_seconds`,
 * which the `PluginVulnRescanStale` alert watches (36 h).
 *
 * A pass does not run, and does not count as completed, when the DB refresh
 * fails OR when the DB — however it is refreshed — is older than
 * `PLUGIN_VULN_DB_MAX_AGE_HOURS`: rescanning with last week's DB would stamp a
 * fresh `scannedAt` on stale data. On EKS the DB is refreshed by a CronJob
 * (`PLUGIN_GRYPE_DB_AUTO_UPDATE=false`), so the refresh here is a no-op and the
 * age check is the ONLY thing that notices the CronJob has stopped.
 * A single image that fails to rescan keeps its previous scan (its `scannedAt`
 * still says when that was) and is counted in the progress metrics.
 */

import { randomUUID } from 'crypto';

import {
  envInt, createLogger, createScheduler, errorMessage, newScanFindings, parseVulnWaivers, recordAudit, runWithAuditContext, scanFindingKey, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID,
  vulnWaiverLabels, leaderLockKey, DEFAULT_LEADER_LOCK_TTL_MS,
  type PluginScanFinding, type RemoteAuditEvent, type PluginScanFlag, type PluginScanSummary, type Scheduler, type VulnWaiver,
} from '@pipeline-builder/api-core';
import { incCounter, resetGauge, setGauge } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';
import {
  compareSemver, pipelinesOnVersion, reopenLapsedAcceptances, runWithTenantContext, schema, syncVersionExposures, versionReferencedPredicate, withTenantTx,
} from '@pipeline-builder/pipeline-data';
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { getHealthRedisConnection } from './connections.js';
import type { RegistryInfo } from '../helpers/registry-auth.js';
import { matchedWaiversFor, scanFlagFor, waivedFor, type FloorInput } from '../helpers/scan-gates.js';
import type { PluginImageRef } from '../helpers/supply-chain.js';
import {
  assertVulnDbFresh,
  inspectRunAsRoot,
  onNewCriticalOrHigh,
  refreshVulnDb,
  scanColumns,
  scanPluginImage,
  scanSummary,
  VulnDbStaleError,
  vulnDbBuiltAt,
  type VulnCounts,
  type VulnScanResult,
} from '../helpers/vuln-scan.js';
import { reportVulnWaivers } from '../helpers/waiver-report.js';
import { openRescanDraft } from '../services/ecosystem/advisories.js';
import { installingOrgs } from '../services/ecosystem/install-notify.js';
import { listings, publishers } from '../services/ecosystem/store.js';
import { isActiveListing } from '../services/ecosystem/util.js';
import { sweepKeptSetupImages } from '../services/kept-setup-images.js';
import { notifyAcceptancesLapsed, notifyRescanFindings } from '../services/plugin-security-notifications.js';

const logger = createLogger('vuln-rescan');

const LOCK_KEY = leaderLockKey('plugin', 'vuln-rescan');
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
  scannedAt: Date | null;
  scanFlaggedAt: Date | null;
  scanSummary: PluginScanSummary | null;
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
  scannedAt: Date | null;
  scanFlaggedAt: Date | null;
  scanSummary: PluginScanSummary | null;
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
  /** Versions flagged after this pass (gated criticals over the floor). */
  flagged: number;
  /** Findings across the DISTINCT images scanned this pass. */
  catalog: VulnCounts;
}

function publishLastCompleted(epochMs: number | null): void {
  if (epochMs !== null) setGauge('plugin_vuln_rescan_last_completed_timestamp_seconds', {}, Math.floor(epochMs / 1000));
}

/**
 * Progress of the CURRENT pass, published after every image — and the final
 * values of the last one, which is what PluginVulnRescanFailingImages reads:
 * a failed image keeps its previous scan, so a pass where many images fail
 * still "completes" and nothing else would say most of the catalog went
 * unrescanned.
 */
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

/** One image's scan, as the pass caches it by digest. */
interface ImageScan {
  scan: VulnScanResult;
  uncataloguedBinaries: string[] | null;
}

/** One pass's state: the DISTINCT images already scanned, by digest. */
interface PassContext {
  registry: RegistryInfo;
  scans: Map<string, ImageScan>;
  result: RescanPassResult;
  now: Date;
  /** The DB build time this pass established (and refused to run without). */
  dbBuiltAt: Date;
  /** `vulnWaiverLabels` keys of the waiver entries that exempted something this pass. */
  matchedWaivers: Set<string>;
}

/**
 * The scan of one image, scanned at most once per pass (by digest). Only a
 * completed scan is remembered: a failure (e.g. one namespace's pull) is
 * retried when the other set reaches the same digest from its own ref.
 */
async function scanOnce(ctx: PassContext, ref: PluginImageRef & { imageDigest: string }): Promise<ImageScan | null> {
  const cached = ctx.scans.get(ref.imageDigest);
  if (cached) return cached;
  const { scan, uncataloguedBinaries } = await scanPluginImage(ref, ctx.registry, 'rescan', { dbBuiltAt: ctx.dbBuiltAt });
  if (!scan) return null;
  const entry = { scan, uncataloguedBinaries };
  ctx.scans.set(ref.imageDigest, entry);
  for (const severity of ['critical', 'high', 'medium', 'low'] as const) ctx.result.catalog[severity] += scan[severity];
  return entry;
}

/** Which kind of row a version is (the audit record's `targetType`), and the org it belongs to. */
interface VersionKind { kind: 'plugin' | 'listing-version'; orgId: string }

/** A waiver entry's identity across separate parses of the env. */
const waiverKey = (w: VulnWaiver): string => JSON.stringify(vulnWaiverLabels(w));

/**
 * Everything the gates decide about one rescanned version: its new flag
 * columns, its new summary, and the side effects — audit of a flag transition
 * and of a waiver this rescan newly applied, the waiver entries still in use.
 */
function evaluate(
  ctx: PassContext,
  image: ImageScan,
  row: { id: string; version: string; imageDigest: string; scanFlaggedAt: Date | null; scanSummary: PluginScanSummary | null },
  pluginName: string,
  who: VersionKind,
): { scanFlaggedAt: Date | null; scanFlag: PluginScanFlag | null; scanSummary: PluginScanSummary; newFindings: PluginScanFinding[]; audits: RemoteAuditEvent[] } {
  const { scan } = image;
  // Name AND org are what a PLUGIN_VULN_WAIVERS entry matches on. Without them
  // the rescan would keep flagging a version whose findings the build gate
  // waived, so the two would disagree about the same image — and the org bound
  // is what stops a tenant's same-named plugin inheriting the exemption.
  const input: FloorInput = {
    vulnCriticalFixable: scan.criticalFixable,
    vulnHighFixable: scan.highFixable,
    findings: scan.findings,
    pluginName,
    orgId: who.orgId,
    pluginVersion: row.version,
  };
  const flag = scanFlagFor(input);
  const waived = waivedFor(input);
  for (const w of matchedWaiversFor(input)) ctx.matchedWaivers.add(waiverKey(w));
  const summary = scanSummary(scan, { imageDigest: row.imageDigest, trigger: 'rescan', waived, uncataloguedBinaries: image.uncataloguedBinaries });
  const auditBase = { actorId: SYSTEM_ACTOR_ID, orgId: who.orgId, targetType: who.kind, targetId: row.id };
  const subject = { pluginName, pluginVersion: row.version, imageDigest: row.imageDigest, trigger: 'rescan' as const };
  // RETURNED, not recorded: the caller emits them only once the row update
  // that makes them true has committed — a failed write must not leave a
  // "flagged" on the trail for a version whose column still says otherwise.
  const audits: RemoteAuditEvent[] = [];

  if (flag && !row.scanFlaggedAt) {
    audits.push({ ...auditBase, action: 'plugin.vuln.flagged', details: { ...subject, gated: flag.gated, high: flag.high, kev: flag.kev ?? 0, maxFindings: flag.maxFindings, findings: flag.findings.map((f) => f.id) } });
  } else if (!flag && row.scanFlaggedAt) {
    audits.push({ ...auditBase, action: 'plugin.vuln.cleared', details: { ...subject, critical: scan.critical, criticalFixable: scan.criticalFixable, flaggedSince: row.scanFlaggedAt.toISOString() } });
  }

  // A waiver the rescan applies changes a verdict exactly as one applied at
  // build does, so it is audited the same way — but only when it covers
  // something the previous scan's waiver did not, or every version carrying a
  // standing waiver would write the same record every night and bury the one
  // that matters.
  const before = new Set(row.scanSummary?.waived ?? []);
  const newlyWaived = waived.filter((f) => !before.has(scanFindingKey(f)));
  for (const f of waived) incCounter('plugin_vuln_waived_total', { plugin: pluginName, advisory: f.id, trigger: 'rescan' });
  if (newlyWaived.length > 0) {
    audits.push({
      ...auditBase,
      action: 'plugin.vuln.waived',
      details: { ...subject, waived: newlyWaived.length, packages: [...new Set(newlyWaived.map((f) => f.packageName))], findings: newlyWaived.map((f) => f.id) },
    });
  }

  return {
    scanFlaggedAt: flag ? (row.scanFlaggedAt ?? ctx.now) : null,
    scanFlag: flag,
    scanSummary: summary,
    newFindings: newFindingsOf(row, scan.findings, flag),
    audits,
  };
}

/**
 * The findings this rescan reports as NEW. Against the previous summary when
 * there is one; without one (a version scanned before summaries existed) the
 * rescan only establishes the baseline, and the news is the version NEWLY
 * flagged — its gated findings — or nothing.
 */
function newFindingsOf(
  row: { scanFlaggedAt: Date | null; scanSummary: PluginScanSummary | null },
  findings: readonly PluginScanFinding[],
  flag: PluginScanFlag | null,
): PluginScanFinding[] {
  if (row.scanSummary) return [...newScanFindings(row.scanSummary, findings), ...kevNewlyListed(row.scanSummary, findings)];
  return flag && !row.scanFlaggedAt ? [...flag.findings] : [];
}

/**
 * Findings the previous summary ALREADY carried that CISA has since added to
 * KEV: not new by identity, but a different emergency — the N31 dedupe keys on
 * KEV status too, so these re-notify.
 */
function kevNewlyListed(before: PluginScanSummary, findings: readonly PluginScanFinding[]): PluginScanFinding[] {
  const was = new Map((before.findings ?? []).map((f) => [scanFindingKey(f), f.kev === true]));
  return findings.filter((f) => f.kev === true && was.get(scanFindingKey(f)) === false);
}

/** Rescan one image plugin (set a): update it, report new findings to its org. */
async function rescanTenantRow(ctx: PassContext, row: TenantRow): Promise<'rescanned' | 'failed'> {
  const ref = { orgId: row.orgId, name: row.name, imageDigest: row.imageDigest! };
  const image = await scanOnce(ctx, ref);
  if (!image) return 'failed';
  const { scan } = image;

  let runAsRoot = row.runAsRoot;
  if (runAsRoot === null) {
    runAsRoot = await inspectRunAsRoot(ref, ctx.registry).catch((err) => {
      logger.warn('Image config unreadable; runAsRoot stays unknown', { pluginId: row.id, error: errorMessage(err) });
      return null;
    });
  }

  const { newFindings, audits, ...cols } = evaluate(ctx, image, { ...row, imageDigest: row.imageDigest! }, row.name, { kind: 'plugin', orgId: row.orgId });
  await withTenantTx((tx) => tx
    .update(schema.plugin)
    .set({ ...scanColumns(scan), ...cols, ...(runAsRoot !== null ? { runAsRoot } : {}) })
    .where(eq(schema.plugin.id, row.id)));
  for (const a of audits) recordAudit(a);
  if (cols.scanFlag) ctx.result.flagged++;
  await syncVersionExposures(
    { pluginName: row.name, pluginVersion: row.version, pluginPublisher: null, imageDigest: row.imageDigest! },
    { scanSummary: cols.scanSummary, scanFlag: cols.scanFlag, scanFlaggedAt: cols.scanFlaggedAt },
  );

  if (newFindings.length > 0) {
    ctx.result.newCriticalOrHigh++;
    onNewCriticalOrHigh({ id: row.id, orgId: row.orgId, name: row.name, version: row.version, imageDigest: row.imageDigest!, listingVersionIds: [] }, newFindings, scan);
    await notifyRescanFindings({
      versionKey: `plugin:${row.id}`,
      plugin: row.name,
      version: row.version,
      critical: scan.critical,
      high: scan.high,
      findings: newFindings,
      flagged: cols.scanFlag !== null,
      imageDigest: row.imageDigest,
      orgs: [{ orgId: row.orgId, uploaderId: row.createdBy }],
      ...(cols.scanFlag ? { suggestedVersion: await newestUnflaggedOrgVersion(row.orgId, row.name, row.version) } : {}),
    });
  }
  return 'rescanned';
}

/** `public/<handle>/<name>` → `<name>`. */
const nameOfRepository = (repo: string): string => repo.split('/').pop() ?? repo;
/** `public/<handle>/<name>` → `<handle>` — the publisher a listed version's pipelines record. */
const publisherOfRepository = (repo: string): string | null => {
  const parts = repo.split('/');
  return parts.length >= 3 ? parts[parts.length - 2]! : null;
};

/**
 * Rescan one listed version (set b) from its OWN public image: update its own
 * facts, summary and flag, open an advisory draft (N20) and tell the installing
 * orgs (N31) when it carries findings its own previous summary did not.
 */
async function rescanListedVersion(ctx: PassContext, lv: ListedRow): Promise<'rescanned' | 'failed'> {
  const repo = lv.imageRepository!;
  const name = nameOfRepository(repo);
  // THE PUBLISHER'S OWN ORG, never a blanket SYSTEM_ORG_ID.
  //
  // This pass used to pass `SYSTEM_ORG_ID` for every listed version, while the
  // plugin name came from the tenant's public repo path (`public/<handle>/<name>`
  // -> `<name>`). Together those are exactly the inheritance `applyVulnWaivers`
  // exists to refuse: "Matching on the name alone would hand every one of them
  // the operator's exemption, so a tenant could inherit a waiver simply by
  // choosing the name." A waiver like `lint:<date>:openssl` silently suppressed
  // the scan flag on any tenant's `lint` — and with the flag went the resolution
  // warning, the N31 notice, the advisory draft and the exposure sync.
  //
  // `?? ''` and NOT `?? SYSTEM_ORG_ID` for the community publisher: an unknown
  // owner must fall AWAY from the exemption, not into it. `applyVulnWaivers`
  // returns everything counted for any org that is not the system org.
  // Resolved BEFORE the scan because the waiver decision depends on it. The
  // same two reads this function already made further down for the N31
  // notification, hoisted rather than duplicated.
  const listing = await listings.byId(lv.listingId);
  const publisher = listing ? await publishers.byId(listing.publisherId) : null;
  const orgId = publisher?.ownerOrgId ?? '';
  const image = await scanOnce(ctx, { orgId, name, imageDigest: lv.imageDigest!, imageRepository: repo });
  if (!image) return 'failed';
  const { scan } = image;

  const cols = scanColumns(scan);
  const { newFindings, audits, ...gate } = evaluate(ctx, image, { ...lv, imageDigest: lv.imageDigest! }, name, { kind: 'listing-version', orgId });
  await withTenantTx((tx) => tx
    .update(schema.pluginListingVersion)
    .set({
      // No vuln_medium / vuln_low columns on a listing version: the summary
      // carries those counts.
      vulnCritical: cols.vulnCritical,
      vulnHigh: cols.vulnHigh,
      vulnCriticalFixable: cols.vulnCriticalFixable,
      vulnHighFixable: cols.vulnHighFixable,
      scannedAt: cols.scannedAt,
      ...gate,
    })
    .where(eq(schema.pluginListingVersion.id, lv.id)));
  for (const a of audits) recordAudit(a);
  if (gate.scanFlag) ctx.result.flagged++;
  await syncVersionExposures(
    { pluginName: name, pluginVersion: lv.version, pluginPublisher: publisherOfRepository(repo), imageDigest: lv.imageDigest! },
    { scanSummary: gate.scanSummary, scanFlag: gate.scanFlag, scanFlaggedAt: gate.scanFlaggedAt },
  );

  if (newFindings.length === 0) return 'rescanned';
  ctx.result.newCriticalOrHigh++;
  onNewCriticalOrHigh({ id: lv.id, orgId: SYSTEM_ORG_ID, name, version: lv.version, imageDigest: lv.imageDigest!, listingVersionIds: [lv.id] }, newFindings, scan);
  if (await openRescanDraft({ listingVersion: lv, findings: newFindings })) ctx.result.advisoryDrafts++;

  // The orgs whose installs reach this version hear it, under their own
  // settings. A YANKED version too: yanking stops NEW installs, but every
  // install already pinned to it keeps running it until it is moved — those
  // orgs are exactly the ones a new Critical in it concerns.
  try {
    if (listing && publisher) {
      // Installing orgs (active listings only), PLUS every org whose pipelines
      // reference this image — a suspended listing, an uninstalled one, a team
      // on its root's install: the pipelines still run it, so their owners hear it.
      const installed = isActiveListing(listing) ? await installingOrgs(publisher, listing, lv.version) : [];
      const referencing = await pipelinesOnVersion({ pluginName: listing.name, pluginVersion: lv.version, imageDigest: lv.imageDigest });
      const orgs = [...new Map([...installed.map((o) => o.orgId), ...referencing.map((r) => r.orgId)].map((o) => [o.toLowerCase(), { orgId: o }])).values()];
      await notifyRescanFindings({
        versionKey: `listing-version:${lv.id}`,
        plugin: `${publisher.handle}/${listing.name}`,
        version: lv.version,
        critical: scan.critical,
        high: scan.high,
        findings: newFindings,
        flagged: gate.scanFlag !== null,
        imageDigest: lv.imageDigest,
        orgs,
        ...(gate.scanFlag ? { suggestedVersion: await newestUnflaggedListedVersion(lv.listingId, lv.version) } : {}),
      });
    }
  } catch (err) {
    logger.warn('Installing orgs of a rescanned version unreadable; N31 not sent', { listingVersionId: lv.id, error: errorMessage(err) });
  }
  return 'rescanned';
}

/** The newest live, unflagged, non-yanked version of an org plugin above `than` — what its pipelines' owners are told to move to. */
async function newestUnflaggedOrgVersion(orgId: string, name: string, than: string): Promise<string | null> {
  const p = schema.plugin;
  const rows = await withTenantTx((tx) => tx.select({ version: p.version }).from(p)
    .where(and(eq(p.orgId, orgId), eq(p.name, name), eq(p.isActive, true), isNull(p.deletedAt), isNull(p.yankedAt), isNull(p.scanFlaggedAt)))) as Array<{ version: string }>;
  return newestAbove(rows.map((r) => r.version), than);
}

/** The newest unyanked, unflagged version of a listing above `than`. */
async function newestUnflaggedListedVersion(listingId: string, than: string): Promise<string | null> {
  const v = schema.pluginListingVersion;
  const rows = await withTenantTx((tx) => tx.select({ version: v.version }).from(v)
    .where(and(eq(v.listingId, listingId), isNull(v.yankedAt), isNull(v.scanFlaggedAt)))) as Array<{ version: string }>;
  return newestAbove(rows.map((r) => r.version), than);
}

function newestAbove(versions: readonly string[], than: string): string | null {
  const above = versions.filter((x) => compareSemver(x, than) > 0);
  return above.reduce<string | null>((best, x) => (best === null || compareSemver(x, best) > 0 ? x : best), null);
}

/**
 * Reopen the pipeline risk acceptances whose deadline passed and tell their
 * pipelines' owners (N33). Runs at the end of every pass; never fails the pass.
 */
async function sweepLapsedAcceptances(now: Date): Promise<number> {
  try {
    const lapsed = await reopenLapsedAcceptances(now);
    if (lapsed.length === 0) return 0;
    // Each auto-reopen changes what that pipeline's lookups and runtime checks
    // refuse, on nobody's request — the same `pipeline.vuln.reopened` a person's
    // reopen writes, marked `trigger: 'lapsed'`, after the reopen committed.
    for (const l of lapsed) {
      recordAudit({
        action: 'pipeline.vuln.reopened',
        actorId: SYSTEM_ACTOR_ID,
        orgId: l.orgId,
        targetType: 'pipeline',
        targetId: l.pipelineId,
        details: {
          exposureId: l.id,
          pluginName: l.pluginName,
          pluginVersion: l.pluginVersion,
          imageDigest: l.imageDigest,
          acceptedUntil: l.acceptedUntil?.toISOString() ?? null,
          triagedBy: l.triagedBy,
          trigger: 'lapsed',
        },
      });
    }
    await notifyAcceptancesLapsed(lapsed.map((l) => ({
      exposureId: l.id,
      orgId: l.orgId,
      pipelineId: l.pipelineId,
      plugin: l.pluginPublisher ? `${l.pluginPublisher}/${l.pluginName}` : l.pluginName,
      version: l.pluginVersion,
      imageDigest: l.imageDigest,
      acceptedUntil: l.acceptedUntil,
      triagedBy: l.triagedBy,
      reason: l.triageReason,
    })));
    return lapsed.length;
  } catch (err) {
    logger.warn('Lapsed acceptance sweep failed', { error: errorMessage(err) });
    return 0;
  }
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

/** Page through (a): non-deleted image plugins, active or not, across all orgs. */
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
        scannedAt: p.scannedAt,
        scanFlaggedAt: p.scanFlaggedAt,
        scanSummary: p.scanSummary,
        runAsRoot: p.runAsRoot,
        createdBy: p.createdBy,
      })
      .from(p)
      .where(and(
        // NOT filtered on isActive: deactivation hides a version from new
        // resolution, it does not stop the pipelines pinned to its digest. A
        // soft-deleted row is rescanned too while any pipeline still references
        // its image — a safety net for rows deleted before references were
        // recorded (a referenced version can no longer be deleted): its
        // exposures must not freeze, and N31 must still reach those pipelines.
        or(isNull(p.deletedAt), versionReferencedPredicate({ digest: sql`${p.imageDigest}`, name: sql`${p.name}`, version: sql`${p.version}`, orgId: sql`${p.orgId}` })),
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
        scannedAt: v.scannedAt,
        scanFlaggedAt: v.scanFlaggedAt,
        scanSummary: v.scanSummary,
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
 * `plugin_vuln_waiver_unmatched{plugin,targets}`: 1 for each ACTIVE (unexpired)
 * waiver entry that exempted nothing in this completed pass, 0 for one still
 * in use. The series set is reset first, so an entry deleted from the env stops
 * reporting instead of alerting forever on its last value.
 */
function publishUnmatchedWaivers(ctx: PassContext): void {
  resetGauge('plugin_vuln_waiver_unmatched');
  for (const w of parseVulnWaivers()) {
    if (w.expires.getTime() < ctx.now.getTime()) continue; // expiry has its own gauge
    setGauge('plugin_vuln_waiver_unmatched', vulnWaiverLabels(w), ctx.matchedWaivers.has(waiverKey(w)) ? 0 : 1);
  }
}

/**
 * One full pass: every image plugin (a), then every listed version from its own
 * public image (b). Throws when the vulnerability DB can't be refreshed, or is
 * older than `PLUGIN_VULN_DB_MAX_AGE_HOURS` ({@link VulnDbStaleError}) — the
 * pass did not run.
 */
export async function rescanAllPlugins(): Promise<RescanPassResult> {
  await refreshVulnDb({ force: true });
  const dbBuiltAt = await assertVulnDbFresh();
  const ctx: PassContext = {
    registry: Config.get('registry') as RegistryInfo,
    scans: new Map(),
    now: new Date(),
    dbBuiltAt,
    matchedWaivers: new Set(),
    result: { total: 0, rescanned: 0, failed: 0, listed: 0, newCriticalOrHigh: 0, advisoryDrafts: 0, flagged: 0, catalog: { critical: 0, high: 0, medium: 0, low: 0 } },
  };

  // One run id for every audit row this pass writes, so a reviewer can pull
  // the whole night's flag/clear/waive/reopen set together.
  await runWithAuditContext({ job: { jobId: 'vuln-rescan', runId: randomUUID(), trigger: 'schedule' } }, () =>
    runWithTenantContext({ isSuperAdmin: true }, async () => {
      await rescanTenantRows(ctx);
      await rescanListedVersions(ctx);
      await sweepLapsedAcceptances(ctx.now);
    }));

  for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
    setGauge('plugin_vuln_catalog_findings', { severity }, ctx.result.catalog[severity]);
  }
  setGauge('plugin_vuln_flagged_versions', {}, ctx.result.flagged);
  publishUnmatchedWaivers(ctx);
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
  // Read the DB's build time on EVERY tick, due or not: it is what keeps
  // plugin_vuln_db_built_timestamp_seconds live between passes (and after a
  // restart), so PluginVulnDbStale can see an operator-refreshed DB going stale
  // hours before the next pass would trip over it.
  await vulnDbBuiltAt();
  if (last !== null && now() - last < rescanIntervalMs()) return 'skipped';

  const started = now();
  let pass: RescanPassResult;
  try {
    pass = await rescanAllPlugins();
  } catch (err) {
    // A stale DB is its own outcome: the pass was REFUSED, deliberately, and
    // the fix (the DB refresh — on EKS the grype-db CronJob) is somewhere else
    // than for a pass that broke.
    const stale = err instanceof VulnDbStaleError;
    incCounter('plugin_vuln_rescan_runs_total', { outcome: stale ? 'stale_db' : 'failed' });
    logger.error(stale ? 'Vulnerability rescan REFUSED: the vulnerability DB is too old' : 'Vulnerability rescan did not run', { error: errorMessage(err) });
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
    lock: { redis, key: LOCK_KEY, ttlMs: envInt('PLUGIN_RESCAN_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1 }) },
    run: async () => {
      // Refresh the waiver expiry gauge on the same cadence. Set only at boot it
      // would go stale on a long-lived pod and quietly stop counting down,
      // which defeats the point of alerting before an expiry bites.
      reportVulnWaivers();
      // Kept setup images past PLUGIN_KEPT_SETUP_IMAGE_TTL_DAYS are discarded
      // on every tick (never throws) — this is the leader-locked job already
      // running hourly, and a kept image is a signed image of a refused build.
      await sweepKeptSetupImages();
      await runRescanTick(redis());
    },
  });
}
