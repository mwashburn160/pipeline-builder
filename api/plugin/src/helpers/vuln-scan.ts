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
 * the DB to the operator (air-gapped installs); grype's own age check still
 * refuses a stale one.
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { envInt, createLogger, errorMessage } from '@pipeline-builder/api-core';
import { incCounter, observe } from '@pipeline-builder/api-server';
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

export type ScanTrigger = 'build' | 'rescan';

export interface VulnCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** One critical/high finding — what a advisory draft is built from. */
export interface VulnFinding {
  id: string;
  severity: 'critical' | 'high';
  packageName: string;
  packageVersion: string;
}

export interface VulnScanResult extends VulnCounts {
  scannedAt: Date;
  /** Critical and high findings only (medium/low are counted, not itemized). */
  findings: VulnFinding[];
}

/** What a scan of one image produced. Every field is independently nullable. */
export interface ImageScanOutcome {
  /** `null` = unscanned (fail-closed). */
  scan: VulnScanResult | null;
  /** Package names from the signed SBOM; `null` when the SBOM could not be read. */
  packages: string[] | null;
}

/** The `plugins` columns a scan writes. */
export interface ScanColumns {
  vulnCritical: number | null;
  vulnHigh: number | null;
  vulnMedium: number | null;
  vulnLow: number | null;
  scannedAt: Date | null;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const envMs = (name: string, def: number): number => envInt(name, def, { min: 1 });

const SCAN_TIMEOUT_MS = envMs('PLUGIN_VULN_SCAN_TIMEOUT_MS', 300_000);
const DB_UPDATE_TIMEOUT_MS = envMs('PLUGIN_GRYPE_DB_UPDATE_TIMEOUT_MS', 600_000);
const DB_UPDATE_INTERVAL_MS = envMs('PLUGIN_GRYPE_DB_UPDATE_INTERVAL_MS', 3_600_000);

function dbAutoUpdate(): boolean {
  return (process.env.PLUGIN_GRYPE_DB_AUTO_UPDATE ?? 'true').toLowerCase() !== 'false';
}

/** Env for every grype run: no self-update checks, DB where the deploy mounted it. */
function grypeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    GRYPE_CHECK_FOR_APP_UPDATE: 'false',
    GRYPE_DB_CACHE_DIR: process.env.GRYPE_DB_CACHE_DIR || path.join(os.tmpdir(), 'grype-db'),
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
  dbRefresh = run('grype', ['db', 'update'], DB_UPDATE_TIMEOUT_MS, grypeEnv())
    .then(() => {
      dbRefreshedAt = Date.now();
      incCounter('plugin_vuln_db_updates_total', { outcome: 'success' });
      logger.info('Vulnerability DB updated', { durationMs: Date.now() - started });
    }, (err: unknown) => {
      incCounter('plugin_vuln_db_updates_total', { outcome: 'failed' });
      throw err;
    })
    .finally(() => { dbRefresh = null; });
  return dbRefresh;
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

const COUNTED = ['critical', 'high', 'medium', 'low'] as const;

interface GrypeMatch {
  vulnerability?: { id?: unknown; severity?: unknown };
  artifact?: { name?: unknown; version?: unknown };
}

/**
 * Count grype's `-o json` report by severity. A finding is one
 * (vulnerability, package, version) — grype can report the same one through
 * several matchers, which must not inflate the counts. `Negligible` and
 * `Unknown` severities are not counted. Throws on anything that is not a grype
 * report: an unparseable report is a scan that did not run, never a clean one.
 */
export function parseGrypeReport(stdout: string): VulnCounts & { findings: VulnFinding[] } {
  let report: { matches?: unknown };
  try {
    report = JSON.parse(stdout) as { matches?: unknown };
  } catch (err) {
    throw new Error(`grype report is not JSON: ${errorMessage(err)}`);
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.matches)) {
    throw new Error('grype report has no matches array');
  }
  const counts: VulnCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  const findings: VulnFinding[] = [];
  const seen = new Set<string>();
  for (const match of report.matches as GrypeMatch[]) {
    const id = typeof match?.vulnerability?.id === 'string' ? match.vulnerability.id : '';
    const severity = typeof match?.vulnerability?.severity === 'string' ? match.vulnerability.severity.toLowerCase() : '';
    const packageName = typeof match?.artifact?.name === 'string' ? match.artifact.name : '';
    const packageVersion = typeof match?.artifact?.version === 'string' ? match.artifact.version : '';
    if (!id || !(COUNTED as readonly string[]).includes(severity)) continue;
    const key = `${id}|${packageName}|${packageVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[severity as keyof VulnCounts]++;
    if (severity === 'critical' || severity === 'high') {
      findings.push({ id, severity, packageName, packageVersion });
    }
  }
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

/** Image config USER → runs as root? Empty (the default), `0`, or `root`, with or without a group. */
export function isRootUser(user: unknown): boolean {
  const name = typeof user === 'string' ? user.trim().split(':')[0]! : '';
  return name === '' || name === '0' || name === 'root';
}

// -----------------------------------------------------------------------------
// Scanning
// -----------------------------------------------------------------------------

/** Run grype over one SBOM. Throws when the scan could not run. */
export async function scanSbom(sbom: Record<string, unknown>, trigger: ScanTrigger): Promise<VulnScanResult> {
  const started = Date.now();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-vulnscan-'));
  try {
    const sbomFile = path.join(workDir, 'sbom.spdx.json');
    fs.writeFileSync(sbomFile, JSON.stringify(sbom));
    const stdout = await run('grype', [`sbom:${sbomFile}`, '-o', 'json', '-q'], SCAN_TIMEOUT_MS,
      grypeEnv({ GRYPE_DB_AUTO_UPDATE: 'false', TMPDIR: workDir }), { captureStdout: true });
    const result: VulnScanResult = { ...parseGrypeReport(stdout), scannedAt: new Date() };
    incCounter('plugin_vuln_scans_total', { trigger, outcome: 'scanned' });
    for (const severity of COUNTED) {
      if (result[severity] > 0) incCounter('plugin_vuln_findings_total', { trigger, severity }, result[severity]);
    }
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
 * that is missing or too old, which lands as unscanned).
 */
export async function scanPluginImage(
  plugin: PluginImageRef,
  registry: RegistryInfo,
  trigger: ScanTrigger,
  opts: { refreshDb?: boolean } = {},
): Promise<ImageScanOutcome> {
  let sbom: Record<string, unknown>;
  try {
    sbom = await fetchImageSbom(plugin, registry);
  } catch (err) {
    incCounter('plugin_vuln_scans_total', { trigger, outcome: 'failed' });
    logger.warn('Plugin SBOM unavailable; image left unscanned', { orgId: plugin.orgId, name: plugin.name, digest: plugin.imageDigest, trigger, error: errorMessage(err) });
    return { scan: null, packages: null };
  }
  const packages = sbomPackageNames(sbom);
  if (opts.refreshDb) {
    await refreshVulnDb().catch((err) => {
      logger.warn('Vulnerability DB update failed; scanning with the DB present', { error: errorMessage(err) });
    });
  }
  try {
    return { scan: await scanSbom(sbom, trigger), packages };
  } catch (err) {
    logger.warn('Vulnerability scan failed; image left unscanned', { orgId: plugin.orgId, name: plugin.name, digest: plugin.imageDigest, trigger, error: errorMessage(err) });
    return { scan: null, packages };
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
    ? { vulnCritical: scan.critical, vulnHigh: scan.high, vulnMedium: scan.medium, vulnLow: scan.low, scannedAt: scan.scannedAt }
    : { vulnCritical: null, vulnHigh: null, vulnMedium: null, vulnLow: null, scannedAt: null };
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
 * Whether `after` has more critical or high findings than `before`. An
 * unscanned `before` counts as none known: every critical/high is new.
 */
export function hasNewCriticalOrHigh(before: Pick<VulnCounts, 'critical' | 'high'> | null, after: VulnCounts): boolean {
  return after.critical > (before?.critical ?? 0) || after.high > (before?.high ?? 0);
}

/**
 * Called by the nightly rescan when a fresh vulnerability DB finds new
 * critical/high vulnerabilities in a plugin version. Emits
 * `plugin_vuln_new_findings_total{severity,listed}` and a structured warning
 * carrying the findings. The advisory draft for a LISTED version is opened
 * by the rescan itself (`openRescanDraft`), against the listing version's own
 * stored facts.
 */
export function onNewCriticalOrHigh(
  plugin: RescannedPlugin,
  before: Pick<VulnCounts, 'critical' | 'high'> | null,
  after: VulnScanResult,
): void {
  const listed = plugin.listingVersionIds.length > 0 ? 'true' : 'false';
  const newCritical = Math.max(0, after.critical - (before?.critical ?? 0));
  const newHigh = Math.max(0, after.high - (before?.high ?? 0));
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
    before: before ? { critical: before.critical, high: before.high } : null,
    after: { critical: after.critical, high: after.high },
    findings: after.findings.slice(0, 100),
  });
}
