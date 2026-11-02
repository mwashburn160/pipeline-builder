// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin image vulnerability scanning and the image's effective USER.
 *
 * The scan reads the image's SIGNED SBOM ({@link fetchImageSbom}: the SPDX
 * document image-registry attested at build) and runs `grype sbom:<file>` over
 * it — no layer pulls, and the build-time scan and the nightly rescan see the
 * exact same package list. Only the vulnerability DB changes between them.
 *
 * Fail-closed: a scan that cannot run (no DB, a DB older than grype's 5-day
 * limit, a grype failure, an SBOM that won't verify) yields `null`, stored as
 * `scannedAt = NULL` — the version is UNSCANNED, and compliance sees
 * `scanned: false` with no counts. Nothing ever records a scan that did not
 * complete.
 *
 * The vulnerability DB lives in `GRYPE_DB_CACHE_DIR` (a per-pod volume in every
 * deploy). Scans never update it themselves (`GRYPE_DB_AUTO_UPDATE=false` on
 * the scan): concurrent builds would race grype's in-place DB swap. Instead
 * {@link refreshVulnDb} runs `grype db update` serialized in-process — before a
 * build scan at most every `PLUGIN_GRYPE_DB_UPDATE_INTERVAL_MS`, and forced at
 * the start of every nightly rescan. `PLUGIN_GRYPE_DB_AUTO_UPDATE=false` hands
 * the DB to the operator (air-gapped installs, and EKS, where a CronJob
 * refreshes one shared copy).
 *
 * DB AGE is checked independently of who refreshes it ({@link vulnDbBuiltAt},
 * `PLUGIN_VULN_DB_MAX_AGE_HOURS`). grype's own limit is five days, far too long
 * to stamp "scanned today" on a result — and with auto-update off nothing in
 * this process ever looked at the DB at all, so an operator CronJob that had
 * quietly stopped left every scan matching against an ever-older DB while
 * reporting fresh `scannedAt`s. The DB's build time is exported as a gauge, the
 * nightly rescan refuses to run on a DB past the limit, and a build streams a
 * warning and records the DB's age in its scan summary.
 *
 * Operator VEX (`PLUGIN_VULN_VEX_DIR`): every `*.json` OpenVEX document there
 * is passed to grype as `--vex`, so a `not_affected` statement the operator has
 * made about a finding is honoured by build scans and rescans alike.
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import {
  envInt, createLogger, errorMessage, scanFindingKey, SCAN_SUMMARY_MAX_BINARIES, SCAN_SUMMARY_MAX_FINDINGS,
  type PluginScanFinding, type PluginScanSummary,
} from '@pipeline-builder/api-core';
import { incCounter, observe, setGauge } from '@pipeline-builder/api-server';
import { Config } from '@pipeline-builder/pipeline-core';

import { run } from './build-process.js';
import { PUBLISH_PLATFORM } from './docker-build.js';
import { imageRepository, writeAuthConfig } from './registry-auth.js';
import type { RegistryInfo } from './registry-auth.js';
import { DIGEST_RE, fetchImageSbom } from './supply-chain.js';
import type { PluginImageRef } from './supply-chain.js';

const logger = createLogger('vuln-scan');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ScanTrigger = 'build' | 'rescan' | 'promote';

export interface VulnCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * One critical/high finding — what an advisory draft, a gate message and a
 * rescan flag are built from. `fixedIn` lists the versions grype reports fix it
 * (empty = no fix available: the finding is not FIXABLE).
 */
export type VulnFinding = PluginScanFinding;

/** The FIXABLE subset of the critical/high counts (grype reports a fixed version). */
export interface FixableCounts {
  criticalFixable: number;
  highFixable: number;
}

export interface VulnScanResult extends VulnCounts, FixableCounts {
  scannedAt: Date;
  /** Critical and high findings only (medium/low are counted, not itemized). */
  findings: VulnFinding[];
  /** When the vulnerability DB this scan matched against was built; null = unreadable. */
  dbBuiltAt: Date | null;
}

/** What a scan of one image produced. Every field is independently nullable. */
export interface ImageScanOutcome {
  /** `null` = unscanned (fail-closed). */
  scan: VulnScanResult | null;
  /** Package names from the signed SBOM; `null` when the SBOM could not be read. */
  packages: string[] | null;
  /** Executables no SBOM package owns ({@link uncataloguedBinaries}); `null` when the SBOM could not be read. */
  uncataloguedBinaries: string[] | null;
}

/** The `plugins` columns a scan writes. */
export interface ScanColumns {
  vulnCritical: number | null;
  vulnHigh: number | null;
  vulnMedium: number | null;
  vulnLow: number | null;
  vulnCriticalFixable: number | null;
  vulnHighFixable: number | null;
  scannedAt: Date | null;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const envMs = (name: string, def: number): number => envInt(name, def, { min: 1 });

const SCAN_TIMEOUT_MS = envMs('PLUGIN_VULN_SCAN_TIMEOUT_MS', 300_000);
const DB_UPDATE_TIMEOUT_MS = envMs('PLUGIN_GRYPE_DB_UPDATE_TIMEOUT_MS', 600_000);
const DB_UPDATE_INTERVAL_MS = envMs('PLUGIN_GRYPE_DB_UPDATE_INTERVAL_MS', 3_600_000);
/** `grype db status` only reads the DB's metadata file. */
const DB_STATUS_TIMEOUT_MS = 30_000;

function dbAutoUpdate(): boolean {
  return (process.env.PLUGIN_GRYPE_DB_AUTO_UPDATE ?? 'true').toLowerCase() !== 'false';
}

/**
 * `PLUGIN_VULN_DB_MAX_AGE_HOURS` (default 36): the oldest DB a scan's result is
 * trusted from. 36 h is a daily upstream build plus a missed refresh's slack —
 * the same budget PluginVulnRescanStale gives the rescan itself.
 */
export function vulnDbMaxAgeMs(): number {
  return envInt('PLUGIN_VULN_DB_MAX_AGE_HOURS', 36, { min: 1 }) * 3_600_000;
}

/** Where grype keeps its DB: the deploy's mount, else a temp dir. */
function dbCacheDir(): string {
  return process.env.GRYPE_DB_CACHE_DIR || path.join(os.tmpdir(), 'grype-db');
}

/** Env for every grype run: no self-update checks, DB where the deploy mounted it. */
function grypeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    GRYPE_CHECK_FOR_APP_UPDATE: 'false',
    GRYPE_DB_CACHE_DIR: dbCacheDir(),
    ...extra,
  };
}

// -----------------------------------------------------------------------------
// Vulnerability DB
// -----------------------------------------------------------------------------

let dbRefresh: Promise<void> | null = null;
let dbRefreshedAt = 0;

/** @internal Reset DB refresh state (tests only). */
export function _resetVulnDbState(): void {
  dbRefresh = null;
  dbRefreshedAt = 0;
}

/**
 * Bring the vulnerability DB up to date. Concurrent callers share one
 * `grype db update`. Without `force`, a refresh within the last
 * `PLUGIN_GRYPE_DB_UPDATE_INTERVAL_MS` is reused. Throws when the update fails
 * — the caller decides whether a stale-but-valid DB is good enough (a build
 * scan: yes, grype's age check still guards it; the nightly rescan: no).
 */
export async function refreshVulnDb(opts: { force?: boolean } = {}): Promise<void> {
  if (!dbAutoUpdate()) return;
  if (dbRefresh) return dbRefresh;
  if (!opts.force && Date.now() - dbRefreshedAt < DB_UPDATE_INTERVAL_MS) return;
  const started = Date.now();
  removeOrphanDownloads(dbCacheDir());
  dbRefresh = run('grype', ['db', 'update'], DB_UPDATE_TIMEOUT_MS, grypeEnv())
    .then(() => {
      dbRefreshedAt = Date.now();
      incCounter('plugin_vuln_db_updates_total', { outcome: 'success' });
      logger.info('Vulnerability DB updated', { durationMs: Date.now() - started });
    }, (err: unknown) => {
      incCounter('plugin_vuln_db_updates_total', { outcome: 'failed' });
      throw err;
    })
    .finally(() => {
      dbRefresh = null;
      recordDbCacheSize(dbCacheDir());
    });
  return dbRefresh;
}

/**
 * When the installed vulnerability DB was BUILT, from `grype db status -o json`
 * (`built`, RFC 3339 — grype 0.121 / schema v6), or null when there is no valid
 * DB or the status can't be read (grype exits non-zero for a missing or corrupt
 * DB). Publishes `plugin_vuln_db_built_timestamp_seconds` on every successful
 * read, so the DB's age is visible whichever process refreshes it. Never throws.
 */
export async function vulnDbBuiltAt(): Promise<Date | null> {
  try {
    const stdout = await run('grype', ['db', 'status', '-o', 'json'], DB_STATUS_TIMEOUT_MS, grypeEnv(), { captureStdout: true });
    const status = JSON.parse(stdout) as { built?: unknown; valid?: unknown };
    if (status.valid === false || typeof status.built !== 'string') return null;
    const built = new Date(status.built);
    if (Number.isNaN(built.getTime())) return null;
    setGauge('plugin_vuln_db_built_timestamp_seconds', {}, Math.floor(built.getTime() / 1000));
    return built;
  } catch (err) {
    logger.warn('Vulnerability DB status unreadable', { error: errorMessage(err) });
    return null;
  }
}

/** The vulnerability DB is missing or older than `PLUGIN_VULN_DB_MAX_AGE_HOURS`. */
export class VulnDbStaleError extends Error {
  constructor(readonly builtAt: Date | null, readonly maxAgeMs: number) {
    super(builtAt
      ? `vulnerability DB was built ${builtAt.toISOString()}, older than PLUGIN_VULN_DB_MAX_AGE_HOURS (${Math.round(maxAgeMs / 3_600_000)}h)`
      : 'vulnerability DB build time unreadable (no valid DB installed?)');
    this.name = 'VulnDbStaleError';
  }
}

/**
 * The DB's build time, or {@link VulnDbStaleError} when it is unknown or past
 * `PLUGIN_VULN_DB_MAX_AGE_HOURS` — REGARDLESS of `PLUGIN_GRYPE_DB_AUTO_UPDATE`.
 * What decides whether a result is current is the DB's age, not which process
 * was supposed to keep it fresh.
 */
export async function assertVulnDbFresh(now: number = Date.now()): Promise<Date> {
  const builtAt = await vulnDbBuiltAt();
  const maxAgeMs = vulnDbMaxAgeMs();
  if (!builtAt || now - builtAt.getTime() > maxAgeMs) throw new VulnDbStaleError(builtAt, maxAgeMs);
  return builtAt;
}

/** The temp dirs `grype db update` downloads and extracts into, inside the cache dir. */
const DOWNLOAD_DIR_PREFIX = 'grype-db-download';

/**
 * Delete download dirs an earlier `grype db update` left behind.
 *
 * grype downloads and extracts into `<cache>/grype-db-download*` and only then
 * imports the DB into place, so an update killed mid-way — the container
 * restarted, the update timed out — strands a ~3 GiB dir that grype never
 * cleans up. The cache volume outlives container restarts, so these pile up
 * next to the installed DB until the kubelet evicts the pod for exceeding the
 * volume's sizeLimit. Safe because refreshes are serialized in-process (one
 * `dbRefresh` at a time) and no other process writes this per-pod dir, so any
 * download dir present here belongs to no running update.
 *
 * @internal exported for tests.
 */
export function removeOrphanDownloads(cacheDir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return 0; // no cache dir yet: nothing to clean
  }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(DOWNLOAD_DIR_PREFIX)) continue;
    try {
      fs.rmSync(path.join(cacheDir, e.name), { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.warn('Could not remove an orphaned grype download dir', { dir: e.name, error: errorMessage(err) });
    }
  }
  if (removed > 0) {
    incCounter('plugin_vuln_db_orphans_removed_total', {}, removed);
    logger.warn('Removed orphaned grype download dirs left by an interrupted DB update', { removed });
  }
  return removed;
}

/**
 * Bytes the cache dir occupies ON DISK (allocated blocks, not file length) —
 * what the kubelet counts against an emptyDir sizeLimit. On XFS a freshly
 * written DB can occupy noticeably more than its length (speculative
 * preallocation), which is exactly the margin a length-based figure would hide.
 *
 * @internal exported for tests.
 */
export function dirAllocatedBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        total += dirAllocatedBytes(p);
      } else {
        const st = fs.lstatSync(p);
        total += typeof st.blocks === 'number' && st.blocks > 0 ? st.blocks * 512 : st.size;
      }
    } catch {
      // vanished mid-walk: grype swapped it — skip
    }
  }
  return total;
}

/**
 * Publish the cache's on-disk size, and the volume limit the deploy declared,
 * so an alert can fire while there is still headroom. Sampled after each
 * refresh, i.e. at the steady state; the alert projects the next refresh's
 * peak from it (see PluginVulnDbCacheNearLimit in the alert rules).
 */
function recordDbCacheSize(cacheDir: string): void {
  setGauge('plugin_vuln_db_cache_bytes', {}, dirAllocatedBytes(cacheDir));
  const limit = Number(process.env.PLUGIN_GRYPE_DB_CACHE_LIMIT_BYTES);
  if (Number.isFinite(limit) && limit > 0) setGauge('plugin_vuln_db_cache_limit_bytes', {}, limit);
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

const COUNTED = ['critical', 'high', 'medium', 'low'] as const;

/** grype's per-record exploitability enrichment (0.121: `knownExploited` = CISA KEV, `epss` = FIRST EPSS). */
interface GrypeExploitability {
  knownExploited?: unknown;
  epss?: unknown;
}

interface GrypeMatch {
  vulnerability?: GrypeExploitability & { id?: unknown; severity?: unknown; fix?: { state?: unknown; versions?: unknown } };
  relatedVulnerabilities?: unknown;
  artifact?: { name?: unknown; version?: unknown };
}

/**
 * The match's exploitability, read from the primary record AND its related ones.
 * Both matter: KEV and EPSS are keyed by CVE, and a GHSA-primary match (most
 * language ecosystems) carries the CVE — and so the KEV entry — on a related
 * record, not on the primary.
 */
function exploitability(match: GrypeMatch): { kev: boolean; epss: number | undefined } {
  const records: GrypeExploitability[] = [
    match?.vulnerability ?? {},
    ...(Array.isArray(match?.relatedVulnerabilities) ? match.relatedVulnerabilities as GrypeExploitability[] : []),
  ];
  let kev = false;
  let epss: number | undefined;
  for (const r of records) {
    if (Array.isArray(r?.knownExploited) && r.knownExploited.length > 0) kev = true;
    for (const e of Array.isArray(r?.epss) ? r.epss as Array<{ epss?: unknown }> : []) {
      if (typeof e?.epss === 'number' && Number.isFinite(e.epss)) epss = Math.max(epss ?? 0, e.epss);
    }
  }
  return { kev, epss };
}

/** Attach exploitability to a finding, leaving the fields ABSENT (not false / undefined) when unknown. */
function withExploitability(f: VulnFinding, x: { kev: boolean; epss: number | undefined }): VulnFinding {
  if (x.kev) f.kev = true;
  if (x.epss !== undefined) f.epss = Math.max(f.epss ?? 0, x.epss);
  return f;
}

/** The fixed versions grype reports for a match: non-empty only when `fix.state` is `fixed`. */
function fixedVersions(match: GrypeMatch): string[] {
  const fix = match?.vulnerability?.fix;
  if (!fix || typeof fix.state !== 'string' || fix.state.toLowerCase() !== 'fixed' || !Array.isArray(fix.versions)) return [];
  return [...new Set(fix.versions.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))];
}

/**
 * Count grype's `-o json` report by severity. A finding is one
 * (vulnerability, package, version) — grype can report the same one through
 * several matchers, which must not inflate the counts. `Negligible` and
 * `Unknown` severities are not counted. A critical/high finding is FIXABLE when
 * grype reports `vulnerability.fix.state == "fixed"` with at least one fixed
 * version; the fixable counts are what the platform floor gates on. Throws on
 * anything that is not a grype report: an unparseable report is a scan that
 * did not run, never a clean one.
 */
export function parseGrypeReport(stdout: string): VulnCounts & FixableCounts & { findings: VulnFinding[] } {
  let report: { matches?: unknown };
  try {
    report = JSON.parse(stdout) as { matches?: unknown };
  } catch (err) {
    throw new Error(`grype report is not JSON: ${errorMessage(err)}`);
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.matches)) {
    throw new Error('grype report has no matches array');
  }
  const counts: VulnCounts & FixableCounts = { critical: 0, high: 0, medium: 0, low: 0, criticalFixable: 0, highFixable: 0 };
  const findings: VulnFinding[] = [];
  const seen = new Set<string>();
  for (const match of report.matches as GrypeMatch[]) {
    const id = typeof match?.vulnerability?.id === 'string' ? match.vulnerability.id : '';
    const severity = typeof match?.vulnerability?.severity === 'string' ? match.vulnerability.severity.toLowerCase() : '';
    const packageName = typeof match?.artifact?.name === 'string' ? match.artifact.name : '';
    const packageVersion = typeof match?.artifact?.version === 'string' ? match.artifact.version : '';
    if (!id || !(COUNTED as readonly string[]).includes(severity)) continue;
    const key = `${id}|${packageName}|${packageVersion}`;
    if (seen.has(key)) {
      // A second matcher for the same finding may be the one that knows the
      // fix, or carry the CVE alias the KEV / EPSS enrichment is keyed by.
      const earlier = findings.find((f) => f.id === id && f.packageName === packageName && f.packageVersion === packageVersion);
      const fixedIn = fixedVersions(match);
      if (earlier && earlier.fixedIn.length === 0 && fixedIn.length > 0) {
        earlier.fixedIn = fixedIn;
        counts[earlier.severity === 'critical' ? 'criticalFixable' : 'highFixable']++;
      }
      if (earlier) withExploitability(earlier, exploitability(match));
      continue;
    }
    seen.add(key);
    counts[severity as keyof VulnCounts]++;
    if (severity === 'critical' || severity === 'high') {
      const fixedIn = fixedVersions(match);
      if (fixedIn.length > 0) counts[severity === 'critical' ? 'criticalFixable' : 'highFixable']++;
      findings.push(withExploitability({ id, severity, packageName, packageVersion, fixedIn }, exploitability(match)));
    }
  }
  // Criticals first; within a severity known-exploited first, then fixable
  // before unfixable — what a flag / gate message shows first.
  const rank = (b: boolean) => (b ? 0 : 1);
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1)
    || rank(a.kev === true) - rank(b.kev === true)
    || rank(a.fixedIn.length > 0) - rank(b.fixedIn.length > 0));
  return { ...counts, findings };
}

/**
 * Package names in a syft SPDX SBOM, deduplicated. The document-root package
 * (the image itself, `SPDXRef-DocumentRoot-…`) is not a package the image
 * installs and is left out.
 */
export function sbomPackageNames(sbom: Record<string, unknown>): string[] {
  const packages = Array.isArray(sbom.packages) ? sbom.packages as Array<Record<string, unknown>> : [];
  const names = new Set<string>();
  for (const pkg of packages) {
    if (typeof pkg?.SPDXID === 'string' && pkg.SPDXID.startsWith('SPDXRef-DocumentRoot')) continue;
    if (typeof pkg?.name === 'string' && pkg.name) names.add(pkg.name);
  }
  return [...names].sort();
}

/**
 * Archive-like file names. syft's unknowns also cover an archive it did not
 * expand; that is a different blind spot (and usually a test fixture or a
 * cached download), not an executable the image RUNS, so it is left out.
 */
const ARCHIVE_NAME = /\.(?:jar|war|ear|zip|tar|tgz|gz|bz2|xz|zst|7z|whl|egg|nupkg|gem|apk|deb|rpm)$/i;

/**
 * Executables in the image that no SBOM package accounts for.
 *
 * syft (1.55, default config) writes every executable it finds into the SPDX
 * `files[]`, and relates each one to the package(s) it evidences or contains:
 * a dpkg file by `CONTAINS`, a Go binary's modules by `OTHER` "evident-by". An
 * executable syft could not attribute to ANY package — its
 * `unknowns.executables-without-packages` set: UPX-packed or stripped Go,
 * Haskell (hadolint, shellcheck), GraalVM native images, Node SEA bundles,
 * vendored browsers — is in `files[]` with no package relationship at all.
 * Verified against syft 1.55 on hadolint (its one binary), ubuntu:26.10 and
 * k6 (none).
 *
 * Read from the SIGNED SBOM, so the build and every rescan see the same list
 * with no second syft pass and no extra layer pull. Paths are absolute, sorted,
 * capped at {@link SCAN_SUMMARY_MAX_BINARIES}.
 */
export function uncataloguedBinaries(sbom: Record<string, unknown>): string[] {
  const files = Array.isArray(sbom.files) ? sbom.files as Array<Record<string, unknown>> : [];
  const relationships = Array.isArray(sbom.relationships) ? sbom.relationships as Array<Record<string, unknown>> : [];
  const isPackage = (id: unknown) => typeof id === 'string' && id.startsWith('SPDXRef-Package-');
  const owned = new Set<string>();
  for (const r of relationships) {
    const a = r?.spdxElementId;
    const b = r?.relatedSpdxElement;
    if (isPackage(a) && typeof b === 'string') owned.add(b);
    if (isPackage(b) && typeof a === 'string') owned.add(a);
  }
  const paths = new Set<string>();
  for (const f of files) {
    if (typeof f?.SPDXID !== 'string' || owned.has(f.SPDXID)) continue;
    if (typeof f.fileName !== 'string' || !f.fileName || ARCHIVE_NAME.test(f.fileName)) continue;
    paths.add(f.fileName.startsWith('/') ? f.fileName : `/${f.fileName}`);
  }
  return [...paths].sort().slice(0, SCAN_SUMMARY_MAX_BINARIES);
}

/** Image config USER → runs as root? Empty (the default), `0`, or `root`, with or without a group. */
export function isRootUser(user: unknown): boolean {
  const name = typeof user === 'string' ? user.trim().split(':')[0]! : '';
  return name === '' || name === '0' || name === 'root';
}

// -----------------------------------------------------------------------------
// Scanning
// -----------------------------------------------------------------------------

/**
 * `--vex <file>` for every `*.json` document in `PLUGIN_VULN_VEX_DIR` (sorted,
 * so the argument list is stable). Unset → none. An unreadable directory is
 * logged and scanned WITHOUT VEX: VEX can only suppress findings, so its absence
 * errs toward reporting more, never less.
 *
 * @internal exported for tests.
 */
export function vexArgs(dir: string | undefined = process.env.PLUGIN_VULN_VEX_DIR): string[] {
  if (!dir?.trim()) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')).sort();
  } catch (err) {
    logger.error('PLUGIN_VULN_VEX_DIR unreadable — scanning WITHOUT operator VEX', { dir, error: errorMessage(err) });
    setGauge('plugin_vuln_vex_documents', {}, 0);
    return [];
  }
  setGauge('plugin_vuln_vex_documents', {}, names.length);
  return names.flatMap((n) => ['--vex', path.join(dir, n)]);
}

/** Run grype over one SBOM. Throws when the scan could not run. */
export async function scanSbom(sbom: Record<string, unknown>, trigger: ScanTrigger, dbBuiltAt: Date | null = null): Promise<VulnScanResult> {
  const started = Date.now();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-vulnscan-'));
  try {
    const sbomFile = path.join(workDir, 'sbom.spdx.json');
    fs.writeFileSync(sbomFile, JSON.stringify(sbom));
    const stdout = await run('grype', [`sbom:${sbomFile}`, '-o', 'json', '-q', ...vexArgs()], SCAN_TIMEOUT_MS,
      grypeEnv({ GRYPE_DB_AUTO_UPDATE: 'false', TMPDIR: workDir }), { captureStdout: true });
    const result: VulnScanResult = { ...parseGrypeReport(stdout), scannedAt: new Date(), dbBuiltAt };
    incCounter('plugin_vuln_scans_total', { trigger, outcome: 'scanned' });
    for (const severity of COUNTED) {
      if (result[severity] > 0) incCounter('plugin_vuln_findings_total', { trigger, severity }, result[severity]);
    }
    const kev = result.findings.filter((f) => f.kev === true).length;
    if (kev > 0) incCounter('plugin_vuln_kev_findings_total', { trigger }, kev);
    return result;
  } catch (err) {
    incCounter('plugin_vuln_scans_total', { trigger, outcome: 'failed' });
    throw err;
  } finally {
    observe('plugin_vuln_scan_duration_seconds', { trigger }, (Date.now() - started) / 1000);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Scan one pushed, signed image: read its signed SBOM, then grype it. Never
 * throws — every failure degrades to `null` (unscanned / unknown packages) and
 * is logged. `refreshDb` makes the scan wait for a DB refresh first; a failed
 * refresh is logged and the scan proceeds on the DB present (grype refuses one
 * that is missing or too old, which lands as unscanned). `dbBuiltAt` is the DB
 * build time when the caller already established it (the rescan does, once per
 * pass); otherwise it is read here.
 */
export async function scanPluginImage(
  plugin: PluginImageRef,
  registry: RegistryInfo,
  trigger: ScanTrigger,
  opts: { refreshDb?: boolean; dbBuiltAt?: Date | null } = {},
): Promise<ImageScanOutcome> {
  let sbom: Record<string, unknown>;
  try {
    sbom = await fetchImageSbom(plugin, registry);
  } catch (err) {
    incCounter('plugin_vuln_scans_total', { trigger, outcome: 'failed' });
    logger.warn('Plugin SBOM unavailable; image left unscanned', { orgId: plugin.orgId, name: plugin.name, digest: plugin.imageDigest, trigger, error: errorMessage(err) });
    return { scan: null, packages: null, uncataloguedBinaries: null };
  }
  const packages = sbomPackageNames(sbom);
  const uncatalogued = uncataloguedBinaries(sbom);
  if (opts.refreshDb) {
    await refreshVulnDb().catch((err) => {
      logger.warn('Vulnerability DB update failed; scanning with the DB present', { error: errorMessage(err) });
    });
  }
  const dbBuiltAt = opts.dbBuiltAt !== undefined ? opts.dbBuiltAt : await vulnDbBuiltAt();
  try {
    return { scan: await scanSbom(sbom, trigger, dbBuiltAt), packages, uncataloguedBinaries: uncatalogued };
  } catch (err) {
    logger.warn('Vulnerability scan failed; image left unscanned', { orgId: plugin.orgId, name: plugin.name, digest: plugin.imageDigest, trigger, error: errorMessage(err) });
    return { scan: null, packages, uncataloguedBinaries: uncatalogued };
  }
}

/**
 * Whether the image runs as root, from its config's `User` (`crane config`).
 * For a multi-platform index (BuildKit builds) the published platform's config
 * is read. Throws when the config can't be read — the caller decides.
 */
export async function inspectRunAsRoot(plugin: PluginImageRef, registry: RegistryInfo): Promise<boolean> {
  if (!plugin.imageDigest || !DIGEST_RE.test(plugin.imageDigest)) {
    throw new Error(`Plugin "${plugin.name}" has no image digest to inspect`);
  }
  const cfg = Config.get('dockerConfig');
  // A resolved repository (a quarantined submission's `quarantine/<id>`) wins over the owner's namespace.
  const repository = plugin.imageRepository
    ? `${registry.host}:${registry.port}/${plugin.imageRepository}`
    : imageRepository(plugin.name, registry, plugin.orgId);
  const ref = `${repository}@${plugin.imageDigest}`;
  const dockerConfigDir = writeAuthConfig(registry, plugin.orgId, Math.ceil(cfg.pushTimeoutMs / 1000), 'pull');
  try {
    const stdout = await run('crane', [
      ...(registry.http ? ['--insecure'] : []),
      'config', '--platform', PUBLISH_PLATFORM, ref,
    ], cfg.pushTimeoutMs, { DOCKER_CONFIG: dockerConfigDir }, { captureStdout: true });
    const imageConfig = JSON.parse(stdout) as { config?: { User?: unknown } };
    return isRootUser(imageConfig.config?.User);
  } finally {
    fs.rmSync(dockerConfigDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Scan columns
// -----------------------------------------------------------------------------

/** The scan columns for a result — all NULL when unscanned. */
export function scanColumns(scan: VulnScanResult | null): ScanColumns {
  return scan
    ? {
      vulnCritical: scan.critical,
      vulnHigh: scan.high,
      vulnMedium: scan.medium,
      vulnLow: scan.low,
      vulnCriticalFixable: scan.criticalFixable,
      vulnHighFixable: scan.highFixable,
      scannedAt: scan.scannedAt,
    }
    : { vulnCritical: null, vulnHigh: null, vulnMedium: null, vulnLow: null, vulnCriticalFixable: null, vulnHighFixable: null, scannedAt: null };
}

// -----------------------------------------------------------------------------
// Scan summary
// -----------------------------------------------------------------------------

/**
 * The `scan_summary` for a completed scan: every count, EVERY Critical/High
 * finding up to {@link SCAN_SUMMARY_MAX_FINDINGS} (the findings are already
 * Criticals-first, so a cut drops Highs before any Critical), what a waiver
 * exempted, the DB the scan matched against, and the binaries it could not see
 * into.
 */
export function scanSummary(
  scan: VulnScanResult,
  input: { imageDigest: string; trigger: ScanTrigger; waived: readonly VulnFinding[]; uncataloguedBinaries: readonly string[] | null },
): PluginScanSummary {
  return {
    criticalFixable: scan.criticalFixable,
    highFixable: scan.highFixable,
    critical: scan.critical,
    high: scan.high,
    medium: scan.medium,
    low: scan.low,
    kev: scan.findings.filter((f) => f.kev === true).length,
    findings: scan.findings.slice(0, SCAN_SUMMARY_MAX_FINDINGS),
    truncated: scan.findings.length > SCAN_SUMMARY_MAX_FINDINGS,
    waived: input.waived.map(scanFindingKey),
    scannedAt: scan.scannedAt.toISOString(),
    trigger: input.trigger,
    imageDigest: input.imageDigest,
    dbBuiltAt: scan.dbBuiltAt ? scan.dbBuiltAt.toISOString() : null,
    uncataloguedBinaries: [...(input.uncataloguedBinaries ?? [])],
  };
}

// -----------------------------------------------------------------------------
// New critical/high findings (the advisory entry point)
// -----------------------------------------------------------------------------

/** A rescanned plugin version, with the listing versions it was published as. */
export interface RescannedPlugin {
  id: string;
  orgId: string;
  name: string;
  version: string;
  imageDigest: string;
  /** `plugin_listing_versions.id`s carrying this image — non-empty = a listed version. */
  listingVersionIds: string[];
}

/**
 * Called by the nightly rescan when a fresh vulnerability DB finds critical/high
 * findings in a plugin version that its previous scan summary did not carry
 * (`newScanFindings` — by identity, not by count). Emits
 * `plugin_vuln_new_findings_total{severity,listed}` and a structured warning
 * carrying the new findings. The advisory draft for a LISTED version is opened
 * by the rescan itself (`openRescanDraft`), against the listing version's own
 * stored facts.
 */
export function onNewCriticalOrHigh(
  plugin: RescannedPlugin,
  newFindings: readonly VulnFinding[],
  after: VulnScanResult,
): void {
  const listed = plugin.listingVersionIds.length > 0 ? 'true' : 'false';
  const newCritical = newFindings.filter((f) => f.severity === 'critical').length;
  const newHigh = newFindings.length - newCritical;
  if (newCritical > 0) incCounter('plugin_vuln_new_findings_total', { severity: 'critical', listed }, newCritical);
  if (newHigh > 0) incCounter('plugin_vuln_new_findings_total', { severity: 'high', listed }, newHigh);
  logger.warn('Rescan found new critical/high vulnerabilities', {
    event: 'plugin.vuln.new_critical_high',
    pluginId: plugin.id,
    orgId: plugin.orgId,
    pluginName: plugin.name,
    pluginVersion: plugin.version,
    imageDigest: plugin.imageDigest,
    listingVersionIds: plugin.listingVersionIds,
    after: { critical: after.critical, high: after.high },
    newFindings: newFindings.slice(0, 100),
  });
}
