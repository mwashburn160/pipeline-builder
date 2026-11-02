// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin image scan gates (docs/plugin-publishing.md "Scan gates"): the shared
 * vocabulary of the build-time gate, the nightly rescan's flag, and the
 * resolution warning / block — used by the plugin service (which stores and
 * enforces them), the resolver in pipeline-data (which skips or warns), and the
 * dashboard (which shows them).
 *
 * A finding is FIXABLE when grype reports a fixed version for it
 * (`vulnerability.fix.state == "fixed"` with at least one version): the gates
 * count fixable Critical findings, because an unfixable one can't be acted on
 * by rebuilding or upgrading — with ONE exception. A Critical that CISA lists
 * as KNOWN EXPLOITED (KEV) is gated even with no fix (`PLUGIN_VULN_GATE_KEV`):
 * "nothing to upgrade to" is a reason to not ship the image, not a reason to
 * ship it, when the vulnerability is being exploited in the wild.
 */

import { SYSTEM_ORG_ID } from '../middleware/system-org.js';
import { envBool, envInt } from '../utils/env.js';

/** One Critical/High finding as the flag and the gate messages carry it. */
export interface PluginScanFinding {
  /** The vulnerability id (CVE-…, GHSA-…). */
  id: string;
  severity: 'critical' | 'high';
  packageName: string;
  packageVersion: string;
  /** Versions that fix it; empty = no fix available (not fixable). */
  fixedIn: string[];
  /**
   * CISA lists it as KNOWN EXPLOITED (grype's `knownExploited`). Absent =
   * not listed. A KEV Critical is gated even when unfixable, and only an
   * ADVISORY-ID waiver can exempt it — see {@link applyVulnWaivers}.
   */
  kev?: boolean;
  /**
   * EPSS probability (0–1) that it is exploited in the next 30 days, as grype
   * reports it; absent when the DB carries no score. Context for a reader
   * ranking findings, never a gate input — a probability is not a verdict.
   */
  epss?: number;
}

/**
 * `scan_flag` on a version the nightly rescan flagged: its GATED Critical
 * count and fixable High count at that rescan, and the top gated findings. Set
 * while gated Criticals exceed `PLUGIN_VULN_MAX_CRITICAL`, cleared when a
 * rescan finds them resolved.
 */
export interface PluginScanFlag {
  /** Gated Critical findings: fixable ones, plus unfixable KEV-listed ones under `PLUGIN_VULN_GATE_KEV`. */
  critical: number;
  /** Of `critical`, the KEV-listed ones (CISA known exploited). Absent = none. */
  kev?: number;
  /** Fixable High findings. */
  high: number;
  /** The floor it was compared against (`PLUGIN_VULN_MAX_CRITICAL`). */
  maxCritical: number;
  /** At most {@link SCAN_FLAG_TOP_FINDINGS} fixable findings, Criticals first. */
  findings: PluginScanFinding[];
}

/**
 * `scan_summary` on every scanned version: the LATEST scan's findings — written
 * by the build that established the version and rewritten by every rescan —
 * whether or not the gate tripped.
 *
 * Distinct from {@link PluginScanFlag}, which exists only while a version is over
 * the floor. A version carrying nothing but High findings is never flagged — so a
 * report whose job is to show Critical AND High exposure had no source to read.
 * What a report SHOWS and what a build REFUSES are different questions, and
 * conflating them meant the answer to the first was "nothing".
 *
 * It is also the rescan's BASELINE. "Is anything new?" is answered by diffing
 * finding identities against the previous summary ({@link newScanFindings}),
 * not by comparing counts: one CVE fixed and a different one published leaves
 * the count unchanged and hides a brand-new Critical.
 *
 * CONTRACT — read by the reporting / exposure code in pipeline-data. Fields are
 * only ever added; every field below is present on every summary written.
 */
export interface PluginScanSummary {
  /** Fixable Critical findings. */
  criticalFixable: number;
  /** Fixable High findings. */
  highFixable: number;
  /** Totals including unfixable findings. */
  critical: number;
  high: number;
  medium: number;
  low: number;
  /** KEV-listed (CISA known exploited) Critical + High findings. */
  kev: number;
  /**
   * EVERY Critical and High finding — fixable AND unfixable — Criticals first,
   * capped at {@link SCAN_SUMMARY_MAX_FINDINGS}. `truncated` says whether the
   * cap cut it; the counts above are never capped.
   */
  findings: PluginScanFinding[];
  truncated: boolean;
  /**
   * Keys ({@link scanFindingKey}) of the findings a `PLUGIN_VULN_WAIVERS` entry
   * exempted from the floor at this scan. They are still in `findings` — a
   * waiver changes the verdict, not what the image contains.
   */
  waived: string[];
  /** When this scan ran (ISO). */
  scannedAt: string;
  /** Which path wrote it. */
  trigger: 'build' | 'rescan' | 'promote';
  /** The image this describes. A version rebuilt on a patched base is a
   *  different artifact, so a summary without its digest cannot be trusted. */
  imageDigest: string;
  /**
   * When the vulnerability DB the scan matched against was BUILT (ISO), or null
   * when it could not be read. A scan is only as current as its DB: a clean
   * result from a week-old DB says nothing about this week's CVEs.
   */
  dbBuiltAt: string | null;
  /**
   * Executables in the image that NO SBOM package accounts for — UPX-packed or
   * stripped Go, Haskell, GraalVM native images, Node SEA bundles, vendored
   * browsers. The scanner cannot see inside them, so their CVEs are invisible to
   * every count above. Paths, sorted, capped at {@link SCAN_SUMMARY_MAX_BINARIES}.
   * Informational: never a gate.
   */
  uncataloguedBinaries: string[];
}

/** Findings a summary itemizes. Counts are never capped; this bounds the jsonb. */
export const SCAN_SUMMARY_MAX_FINDINGS = 500;

/** Uncatalogued binaries a summary lists. */
export const SCAN_SUMMARY_MAX_BINARIES = 200;

/**
 * A finding's identity: the advisory in a specific package version. The same
 * CVE in two packages is two findings; the same CVE reported again after a
 * rescan is the same one.
 */
export function scanFindingKey(f: Pick<PluginScanFinding, 'id' | 'packageName' | 'packageVersion'>): string {
  return `${f.id}|${f.packageName}|${f.packageVersion}`;
}

/**
 * The Critical/High findings in `after` that the previous summary did not
 * carry — what N31 and an advisory draft are about.
 *
 * No previous summary means no baseline: every finding is new. A TRUNCATED
 * baseline knows only its first {@link SCAN_SUMMARY_MAX_FINDINGS} findings
 * (Criticals first), so a finding missing from it is new only if the baseline
 * provably listed every finding of that severity — otherwise it may simply have
 * been cut, and reporting it as new would be a false alarm on every pass.
 */
export function newScanFindings(
  before: Pick<PluginScanSummary, 'findings' | 'truncated' | 'critical'> | null | undefined,
  after: readonly PluginScanFinding[],
): PluginScanFinding[] {
  if (!before) return [...after];
  const known = new Set(before.findings.map(scanFindingKey));
  const listedCritical = before.findings.filter((f) => f.severity === 'critical').length;
  const complete = {
    critical: !before.truncated || listedCritical >= before.critical,
    high: !before.truncated,
  };
  return after.filter((f) => complete[f.severity] && !known.has(scanFindingKey(f)));
}

/** Findings a flag / gate message carries. */
export const SCAN_FLAG_TOP_FINDINGS = 10;

/** Lookup / resolution warning code for a flagged version. */
export const VULN_FLAGGED_WARNING = 'VULN_FLAGGED';

/**
 * `PLUGIN_VULN_MAX_CRITICAL`: the platform floor — a version with MORE fixable
 * Critical findings than this fails its build (`PLUGIN_VULN_GATE`) and is
 * flagged by the rescan. Default `0`; `-1` disables the floor (and the flag).
 */
export function pluginVulnMaxCritical(): number {
  return envInt('PLUGIN_VULN_MAX_CRITICAL', 0, { min: -1 });
}

/**
 * `PLUGIN_VULN_GATE_KEV` (default true): a Critical CISA lists as known
 * exploited counts against the floor even when it has NO fix. Off, KEV findings
 * are gated exactly like any other Critical (fixable only).
 */
export function pluginVulnGateKev(): boolean {
  return envBool('PLUGIN_VULN_GATE_KEV', true);
}

/**
 * Whether a finding counts against the floor: a fixable Critical, or — under
 * `PLUGIN_VULN_GATE_KEV` — a KEV-listed Critical with or without a fix.
 */
export function isGatedFinding(f: Pick<PluginScanFinding, 'severity' | 'fixedIn' | 'kev'>, kevGate: boolean = pluginVulnGateKev()): boolean {
  return f.severity === 'critical' && (f.fixedIn.length > 0 || (kevGate && f.kev === true));
}

/**
 * A scoped, EXPIRING exemption from the vulnerability floor for one plugin.
 *
 * `PLUGIN_VULN_MAX_CRITICAL` is the only other lever and it is far too blunt:
 * raising it above 0 exempts every plugin from every Critical. Some images
 * genuinely cannot reach zero — a browser-bundling test runner (artillery ships
 * Chromium through its own @playwright/browser-chromium dependency, playwright
 * downloads Firefox) is at upstream's latest and still carries fixable findings,
 * because browsers ship CVE fixes weekly while pinned builds lag by design.
 * Without a narrow exemption the only options are "block the plugin forever" or
 * "disable the floor for everything".
 *
 * Three properties make this an exemption rather than a hole, and all three are
 * enforced below rather than documented and hoped for:
 *
 *   SCOPED    to one plugin (or, fleet-wide, to named advisories only), to
 *             named packages/advisories, AND to the system org. A new Critical
 *             in anything not named still fails the gate, so a waiver cannot
 *             grow silently into "this plugin is exempt". The org bound
 *             matters because plugin names are unique per (name, version,
 *             orgId) and NOT globally: without it, any tenant could inherit an
 *             exemption by naming their plugin `artillery`.
 *   EXPIRING  every entry carries a date and stops applying after it. A waiver
 *             nobody revisits becomes permanent; this one lapses on its own and
 *             the plugin starts failing again, which is the intended prompt.
 *   VISIBLE   what was waived is returned to the caller, so it reaches the
 *             metric, the audit record and the build message instead of
 *             vanishing from the count.
 *
 * Format — entries `;`-separated, fields `:`-separated, targets `,`-separated.
 * A target is a package name (`chromium`) or an advisory id (`GO-2026-6612`),
 * matched against the finding's package or id respectively:
 *
 *   PLUGIN_VULN_WAIVERS=artillery:2026-12-31:chromium,chrome;playwright:2026-12-31:firefox
 *
 * FLEET-WIDE (`*` as the plugin) is for one advisory that every bundler of a
 * toolchain inherits — a Go stdlib CVE reaches every prebuilt Go binary at once,
 * and listing each plugin hides that it is one decision. It may name ADVISORY
 * IDS ONLY: `*:2026-12-31:stdlib` would waive every present and future stdlib
 * Critical in every plugin, including ones a rebuild could clear, so a package
 * name under `*` is rejected. `*` takes no `@version` (versions are per plugin)
 * and keeps the system-org bound and the expiry:
 *
 *   PLUGIN_VULN_WAIVERS=*:2026-12-31:GO-2026-6612,GO-2026-6604
 *
 * A malformed entry is DROPPED, never treated as a wildcard: the failure mode
 * of a typo must be "the gate still blocks", not "everything is waived".
 */
export interface VulnWaiver {
  /** Plugin name the waiver applies to (exact match), or {@link WAIVE_ALL_PLUGINS}. */
  plugin: string;
  /**
   * Plugin version the waiver is limited to, or null for every version.
   *
   * A waiver is a judgement about a SPECIFIC image — "this release of artillery
   * bundles a Chromium we cannot patch". Left unpinned it silently carries to
   * every future version, including ones whose findings nobody has looked at,
   * which is how a narrow exemption becomes a standing one.
   */
  version: string | null;
  /** Inclusive expiry (UTC date). After it the entry has no effect. */
  expires: Date;
  /**
   * Package names and/or advisory ids whose findings are exempt. Never empty —
   * see parseVulnWaivers. Advisory ids only when `plugin` is `*`.
   */
  packages: string[];
}

/** The `plugin` of a fleet-wide waiver. Advisory ids only — see VulnWaiver. */
export const WAIVE_ALL_PLUGINS = '*';

/**
 * An advisory id as scanners report it (CVE, GHSA, Go vulndb, PyPA, RustSec).
 * Anything else is a package name, which a fleet-wide waiver may not use.
 */
const ADVISORY_ID = /^(CVE-\d{4}-\d{4,}|GHSA(-[0-9a-z]{4}){3}|GO-\d{4}-\d{4,}|PYSEC-\d{4}-\d+|RUSTSEC-\d{4}-\d{4,})$/i;

/** A dropped entry and why, so the operator can be told instead of guessing. */
export interface VulnWaiverProblem {
  entry: string;
  reason: string;
}

/** Parsed waivers plus the entries that were rejected. */
export interface VulnWaiverParse {
  waivers: VulnWaiver[];
  problems: VulnWaiverProblem[];
}

/**
 * Parse `PLUGIN_VULN_WAIVERS`, REPORTING what was dropped.
 *
 * Dropping a malformed entry is the safe direction — a typo must not become a
 * wildcard — but silently dropping it is a usability trap: the operator sets a
 * waiver, the gate keeps blocking, and nothing anywhere says why. Callers that
 * can surface it (service boot) use this; `parseVulnWaivers` is the shorthand
 * for the ones that cannot.
 *
 * Entry grammar: `<plugin>[@<version>]:<YYYY-MM-DD>:<pkg>[,<pkg>…]`
 */
export function parseVulnWaiversVerbose(raw: string | undefined = process.env.PLUGIN_VULN_WAIVERS): VulnWaiverParse {
  const waivers: VulnWaiver[] = [];
  const problems: VulnWaiverProblem[] = [];
  if (!raw?.trim()) return { waivers, problems };
  const reject = (entry: string, reason: string) => { problems.push({ entry: entry.trim(), reason }); };

  for (const entry of raw.split(';')) {
    if (!entry.trim()) continue;
    const [target, expires, packages] = entry.split(':').map((f) => f?.trim() ?? '');
    // Every field is REQUIRED. An entry missing its package list would
    // otherwise read as "waive this plugin entirely", which is the one thing
    // this must not be able to express.
    if (!target || !expires || !packages) {
      reject(entry, 'expected <plugin>[@<version>]:<YYYY-MM-DD>:<package>[,<package>…]');
      continue;
    }
    const at = target.indexOf('@');
    const plugin = at === -1 ? target : target.slice(0, at).trim();
    const version = at === -1 ? null : target.slice(at + 1).trim();
    if (!plugin) { reject(entry, 'no plugin name'); continue; }
    if (at !== -1 && !version) { reject(entry, "'@' with no version — omit it to cover every version"); continue; }
    if (plugin === WAIVE_ALL_PLUGINS && version !== null) { reject(entry, "'*' covers every plugin, so it cannot pin a version"); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) { reject(entry, `expiry '${expires}' is not YYYY-MM-DD`); continue; }
    const when = new Date(`${expires}T23:59:59.999Z`);
    if (Number.isNaN(when.getTime())) { reject(entry, `expiry '${expires}' is not a real date`); continue; }
    const names = packages.split(',').map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) { reject(entry, 'no package names'); continue; }
    if (plugin === WAIVE_ALL_PLUGINS) {
      const packageNames = names.filter((n) => !ADVISORY_ID.test(n));
      if (packageNames.length > 0) {
        reject(entry, `'*' takes advisory ids only (CVE-…, GHSA-…, GO-…); '${packageNames.join(', ')}' would waive a package in every plugin`);
        continue;
      }
    }
    waivers.push({ plugin, version, expires: when, packages: names });
  }
  return { waivers, problems };
}

/** Parse `PLUGIN_VULN_WAIVERS`. Malformed or incomplete entries are dropped. */
export function parseVulnWaivers(raw: string | undefined = process.env.PLUGIN_VULN_WAIVERS): VulnWaiver[] {
  return parseVulnWaiversVerbose(raw).waivers;
}

/** What a waiver removed from the count, and what still counts. */
export interface WaiverOutcome {
  /** Findings the floor still counts. */
  counted: PluginScanFinding[];
  /** Findings an unexpired waiver exempted (empty when none applied). */
  waived: PluginScanFinding[];
  /** The entries that exempted at least one finding — what "this waiver is still doing something" is measured by. */
  matched: VulnWaiver[];
}

/** One waiver entry's identity: the plugin it names (with its pin) and its targets. */
export function vulnWaiverLabels(w: Pick<VulnWaiver, 'plugin' | 'version' | 'packages'>): { plugin: string; targets: string } {
  return { plugin: w.version ? `${w.plugin}@${w.version}` : w.plugin, targets: w.packages.join(',') };
}

/**
 * Split findings into what still counts and what an unexpired waiver exempts.
 *
 * Matching is on the package name or advisory id a waiver names,
 * case-insensitively, and only for findings that are GATED
 * ({@link isGatedFinding}) — an ungated finding never counted toward the floor,
 * so "waiving" it would overstate what the waiver does.
 *
 * A KEV-listed finding is exempted by an ADVISORY-ID target only, never by a
 * package name. `artillery:…:chromium` is a judgement about Chromium's ordinary
 * churn; it was not written about, and must not silently cover, the one
 * Chromium CVE that is being exploited today. Naming that CVE is the deliberate
 * act an exemption for it requires.
 */
export function applyVulnWaivers(
  pluginName: string,
  findings: readonly PluginScanFinding[],
  waivers: readonly VulnWaiver[] = parseVulnWaivers(),
  now: Date = new Date(),
  orgId?: string,
  pluginVersion?: string,
): WaiverOutcome {
  // SYSTEM ORG ONLY. Plugin names are unique per (name, version, orgId), NOT
  // globally — any tenant can create a plugin called `artillery`. Matching on
  // the name alone would hand every one of them the operator's exemption, so a
  // tenant could inherit a waiver simply by choosing the name, and ship an
  // image whose Criticals the gate then waved through. The waivers exist for the
  // Official catalog the operator curates, which lives in the system org; a
  // caller that cannot say which org this build belongs to gets no waiver.
  if (orgId === undefined || orgId.toLowerCase() !== SYSTEM_ORG_ID) return { counted: [...findings], waived: [], matched: [] };
  const active = waivers.filter((w) => (w.plugin === pluginName || w.plugin === WAIVE_ALL_PLUGINS)
    && w.expires.getTime() >= now.getTime()
    // A version-pinned waiver covers that version only. An unpinned one covers
    // every version, which is why the pin is worth writing.
    && (w.version === null || w.version === pluginVersion));
  if (active.length === 0) return { counted: [...findings], waived: [], matched: [] };
  const kevGate = pluginVulnGateKev();
  const targets = active.map((w) => ({ w, names: new Set(w.packages.map((n) => n.toLowerCase())) }));
  const counted: PluginScanFinding[] = [];
  const waived: PluginScanFinding[] = [];
  const matched = new Set<VulnWaiver>();
  for (const f of findings) {
    const id = f.id.toLowerCase();
    const pkg = f.packageName.toLowerCase();
    const by = isGatedFinding(f, kevGate)
      ? targets.filter((t) => t.names.has(id) || (f.kev !== true && t.names.has(pkg)))
      : [];
    if (by.length === 0) { counted.push(f); continue; }
    waived.push(f);
    for (const t of by) matched.add(t.w);
  }
  return { counted, waived, matched: [...matched] };
}

/** Whether `gatedCritical` breaks the platform floor (never, when disabled). */
export function exceedsVulnFloor(gatedCritical: number | null | undefined, max: number = pluginVulnMaxCritical()): boolean {
  return max >= 0 && (gatedCritical ?? 0) > max;
}

/** `pkg@1.2.3 → 1.2.4` / `pkg@1.2.3 (no fix)`. */
export function describeFix(f: Pick<PluginScanFinding, 'packageName' | 'packageVersion' | 'fixedIn'>): string {
  const at = `${f.packageName}${f.packageVersion ? `@${f.packageVersion}` : ''}`;
  return f.fixedIn.length > 0 ? `${at} → ${f.fixedIn.join(', ')}` : `${at} (no fix)`;
}

/** `CVE-1 (openssl@3.0.1 → 3.0.2); CVE-2 (…)` for the first `limit` findings. */
export function describeFindings(findings: readonly PluginScanFinding[], limit = 5): string {
  const shown = findings.slice(0, limit).map((f) => `${f.id} (${describeFix(f)})`).join('; ');
  const more = findings.length > limit ? `; +${findings.length - limit} more` : '';
  return `${shown}${more}`;
}

/**
 * `N fixable Critical findings`, or — when any gated finding is KEV-listed, so
 * "fixable" alone would misdescribe the count — `N Critical findings that are
 * fixable or known exploited (M on CISA KEV)`.
 */
function gatedCriticalPhrase(flag: Pick<PluginScanFlag, 'critical' | 'kev'>): string {
  const s = flag.critical === 1 ? '' : 's';
  return flag.kev
    ? `${flag.critical} Critical finding${s} that ${flag.critical === 1 ? 'is' : 'are'} fixable or known exploited (${flag.kev} on CISA KEV)`
    : `${flag.critical} fixable Critical finding${s}`;
}

/** The warning text for a flagged version: `x@v has N fixable Critical findings — rebuild or upgrade`. */
export function vulnFlaggedMessage(ref: string, flag: Pick<PluginScanFlag, 'critical' | 'kev'>): string {
  return `${ref} has ${gatedCriticalPhrase(flag)} — rebuild or upgrade`;
}

/** A `VULN_FLAGGED` lookup warning (the lookup envelope's `warnings[]` entry). */
export interface VulnFlaggedWarning {
  code: typeof VULN_FLAGGED_WARNING;
  /** `critical` when a gated finding is on CISA KEV, else `error` (a flag never refuses anything). */
  severity: 'error' | 'critical';
  plugin: string;
  version: string;
  critical: number;
  high: number;
  message: string;
  /** Top fixable findings with their fixed versions. */
  findings: PluginScanFinding[];
}

/** Build the `VULN_FLAGGED` warning for `plugin@version`. */
export function vulnFlaggedWarning(plugin: string, version: string, flag: PluginScanFlag): VulnFlaggedWarning {
  return {
    code: VULN_FLAGGED_WARNING,
    severity: flag.kev ? 'critical' : 'error',
    plugin,
    version,
    critical: flag.critical,
    high: flag.high,
    message: vulnFlaggedMessage(`${plugin}@${version}`, flag),
    findings: flag.findings.slice(0, SCAN_FLAG_TOP_FINDINGS),
  };
}

/** Narrow an unknown `scan_flag` jsonb value. */
export function asScanFlag(value: unknown): PluginScanFlag | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.critical !== 'number' || typeof v.high !== 'number') return null;
  const findings = Array.isArray(v.findings) ? (v.findings as PluginScanFinding[]).filter((f) => f && typeof f.id === 'string') : [];
  return {
    critical: v.critical,
    high: v.high,
    maxCritical: typeof v.maxCritical === 'number' ? v.maxCritical : 0,
    ...(typeof v.kev === 'number' && v.kev > 0 ? { kev: v.kev } : {}),
    findings: findings.map((f) => ({ ...f, fixedIn: Array.isArray(f.fixedIn) ? f.fixedIn : [] })),
  };
}
