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
 * count fixable Critical findings only, because an unfixable one can't be
 * acted on by rebuilding or upgrading.
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
}

/**
 * `scan_flag` on a version the nightly rescan flagged: its fixable
 * Critical/High counts at that rescan and the top fixable findings. Set while
 * fixable Criticals exceed `PLUGIN_VULN_MAX_CRITICAL`, cleared when a rescan
 * finds them resolved.
 */
export interface PluginScanFlag {
  /** Fixable Critical findings. */
  critical: number;
  /** Fixable High findings. */
  high: number;
  /** The floor it was compared against (`PLUGIN_VULN_MAX_CRITICAL`). */
  maxCritical: number;
  /** At most {@link SCAN_FLAG_TOP_FINDINGS} fixable findings, Criticals first. */
  findings: PluginScanFinding[];
}

/**
 * `scan_summary` on every in-use version: the LAST rescan's findings, written
 * whether or not the gate tripped.
 *
 * Distinct from {@link PluginScanFlag}, which exists only while a version is over
 * the floor. A version carrying nothing but High findings is never flagged — so a
 * report whose job is to show Critical AND High exposure had no source to read.
 * What a report SHOWS and what a build REFUSES are different questions, and
 * conflating them meant the answer to the first was "nothing".
 */
export interface PluginScanSummary {
  /** Fixable Critical findings at the last rescan. */
  criticalFixable: number;
  /** Fixable High findings at the last rescan. */
  highFixable: number;
  /** Totals including unfixable findings, for context. */
  critical: number;
  high: number;
  /** At most {@link SCAN_FLAG_TOP_FINDINGS} findings, Criticals first. */
  findings: PluginScanFinding[];
  /** When the rescan that produced this ran (ISO). */
  scannedAt: string;
  /** The image this describes. A version rebuilt on a patched base is a
   *  different artifact, so a summary without its digest cannot be trusted. */
  imageDigest?: string;
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
 *   SCOPED    to one plugin, to named packages, AND to the system org. A new
 *             Critical in any other package still fails the gate, so a waiver
 *             cannot grow silently into "this plugin is exempt". The org bound
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
 * Format — entries `;`-separated, fields `:`-separated, packages `,`-separated:
 *
 *   PLUGIN_VULN_WAIVERS=artillery:2026-12-31:chromium,chrome;playwright:2026-12-31:firefox
 *
 * A malformed entry is DROPPED, never treated as a wildcard: the failure mode
 * of a typo must be "the gate still blocks", not "everything is waived".
 */
export interface VulnWaiver {
  /** Plugin name the waiver applies to (exact match). */
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
  /** Package names whose findings are exempt. Never empty — see parseVulnWaivers. */
  packages: string[];
}

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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) { reject(entry, `expiry '${expires}' is not YYYY-MM-DD`); continue; }
    const when = new Date(`${expires}T23:59:59.999Z`);
    if (Number.isNaN(when.getTime())) { reject(entry, `expiry '${expires}' is not a real date`); continue; }
    const names = packages.split(',').map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) { reject(entry, 'no package names'); continue; }
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
}

/**
 * Split findings into what still counts and what an unexpired waiver exempts.
 *
 * Matching is on the package name a waiver names, case-insensitively, and only
 * for findings that are FIXABLE — an unfixable finding never counted toward the
 * floor, so "waiving" it would overstate what the waiver does.
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
  if (orgId === undefined || orgId.toLowerCase() !== SYSTEM_ORG_ID) return { counted: [...findings], waived: [] };
  const active = waivers.filter((w) => w.plugin === pluginName
    && w.expires.getTime() >= now.getTime()
    // A version-pinned waiver covers that version only. An unpinned one covers
    // every version, which is why the pin is worth writing.
    && (w.version === null || w.version === pluginVersion));
  if (active.length === 0) return { counted: [...findings], waived: [] };
  const exempt = new Set(active.flatMap((w) => w.packages.map((n) => n.toLowerCase())));
  const counted: PluginScanFinding[] = [];
  const waived: PluginScanFinding[] = [];
  for (const f of findings) {
    if (f.fixedIn.length > 0 && exempt.has(f.packageName.toLowerCase())) waived.push(f);
    else counted.push(f);
  }
  return { counted, waived };
}

/** Whether `fixableCritical` breaks the platform floor (never, when disabled). */
export function exceedsVulnFloor(fixableCritical: number | null | undefined, max: number = pluginVulnMaxCritical()): boolean {
  return max >= 0 && (fixableCritical ?? 0) > max;
}

/**
 * `PLUGIN_BLOCK_ON_NEW_CRITICAL` (default false): resolution SKIPS flagged
 * versions for ranges and the default (falling back to the newest unflagged
 * one), and an exact pin to a flagged version is refused 409
 * `PLUGIN_VERSION_VULN_BLOCKED`. Off: flagged versions resolve with a
 * `VULN_FLAGGED` warning.
 */
export function blockOnNewCritical(): boolean {
  return envBool('PLUGIN_BLOCK_ON_NEW_CRITICAL', false);
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

/** The warning text for a flagged version: `x@v has N fixable Critical findings — rebuild or upgrade`. */
export function vulnFlaggedMessage(ref: string, flag: Pick<PluginScanFlag, 'critical'>): string {
  return `${ref} has ${flag.critical} fixable Critical finding${flag.critical === 1 ? '' : 's'} — rebuild or upgrade`;
}

/** A `VULN_FLAGGED` lookup warning (the lookup envelope's `warnings[]` entry). */
export interface VulnFlaggedWarning {
  code: typeof VULN_FLAGGED_WARNING;
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
    plugin,
    version,
    critical: flag.critical,
    high: flag.high,
    message: vulnFlaggedMessage(`${plugin}@${version}`, flag),
    findings: flag.findings.slice(0, SCAN_FLAG_TOP_FINDINGS),
  };
}

/** The 409 message for an exact pin to a flagged version while blocking. */
export function vulnBlockedMessage(plugin: string, version: string, flag: PluginScanFlag): string {
  const fixes = flag.findings.length > 0 ? ` Fix: ${describeFindings(flag.findings)}.` : '';
  return `${plugin}@${version} is blocked: a rescan found ${flag.critical} fixable Critical finding${flag.critical === 1 ? '' : 's'} `
    + `(PLUGIN_BLOCK_ON_NEW_CRITICAL). Rebuild it on patched packages or move to a newer version.${fixes}`;
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
    findings: findings.map((f) => ({ ...f, fixedIn: Array.isArray(f.fixedIn) ? f.fixedIn : [] })),
  };
}
