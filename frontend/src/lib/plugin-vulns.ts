// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Vulnerability-scan facts of a plugin version, as the plugin service reports
 * them, and the build refusals the scan gates produce.
 *
 * A finding is FIXABLE when the scanner knows a fixed version of the affected
 * package. The platform floor (`PLUGIN_VULN_MAX_CRITICAL`) and the ecosystem
 * gate compare the FIXABLE Critical count: a Critical with no fix yet is shown,
 * but it does not fail a build. NULL counts mean the image was never scanned.
 *
 * Those gates apply to plugin BUILDS only. A pipeline is never refused for a
 * plugin's vulnerabilities: lookups, saves and runtime checks answer
 * severity-graded warnings (`info|warning|error|critical`) instead.
 */

import type { VulnSeverity } from '@pipeline-builder/api-core';

export type { VulnSeverity };

/** One scanner finding: the vulnerability id and the versions that fix it. */
export interface VulnFinding {
  id: string;
  severity: string;
  /** Affected package, when the server names it. */
  package: string | null;
  /** The installed (vulnerable) version of `package`. */
  packageVersion: string | null;
  /** Versions of `package` that fix it (empty = no fix known). */
  fixedIn: string[];
}

/** What a rescan found on a version that was clean when it was built. */
export interface ScanFlag {
  critical: number;
  high: number;
  findings: VulnFinding[];
}

/** The scan columns a plugin version carries (every one optional on the wire). */
export interface VulnFacts {
  vulnCritical?: number | null;
  vulnHigh?: number | null;
  vulnCriticalFixable?: number | null;
  vulnHighFixable?: number | null;
  scannedAt?: string | null;
  scanFlaggedAt?: string | null;
  scanFlag?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Fixed versions from `fixedIn` / `fixVersions` / `fix.versions`, as a string or a list. */
function fixedVersions(o: Record<string, unknown>): string[] {
  const raw = o.fixedIn ?? o.fixVersions ?? o.fixedVersions ?? (o.fix as { versions?: unknown } | undefined)?.versions;
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(raw)) return raw.map(str).filter((s): s is string => s !== null);
  return [];
}

/** Normalize a findings list (tolerant of the id living under `id`, `cve` or `vulnerability`). */
export function normalizeVulnFindings(raw: unknown): VulnFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: VulnFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id) ?? str(o.cve) ?? str(o.vulnerability) ?? str(o.vulnerabilityId);
    if (!id) continue;
    out.push({
      id,
      severity: str(o.severity) ?? 'Unknown',
      package: str(o.packageName) ?? str(o.package) ?? str(o.artifact),
      packageVersion: str(o.packageVersion) ?? str(o.installedVersion),
      fixedIn: fixedVersions(o),
    });
  }
  return out;
}

/** The stored rescan flag, or null when the version is not flagged. */
export function normalizeScanFlag(raw: unknown): ScanFlag | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    critical: num(o.critical) ?? 0,
    high: num(o.high) ?? 0,
    findings: normalizeVulnFindings(o.findings ?? o.top ?? o.topFindings),
  };
}

/**
 * `CVE-2026-1 (openssl@3.0.1 → 3.0.2)` — one finding as a line of text, in the
 * same words the server's gate messages use (api-core `describeFix`).
 */
export function describeFinding(f: VulnFinding): string {
  const at = f.package ? `${f.package}${f.packageVersion ? `@${f.packageVersion}` : ''}` : null;
  const fix = f.fixedIn.length > 0 ? `→ ${f.fixedIn.join(', ')}` : '(no fix)';
  return `${f.id} (${at ? `${at} ` : ''}${fix})`;
}

// ---------------------------------------------------------------------------
// Build refusals
// ---------------------------------------------------------------------------

/** The scan-gate failure codes a plugin build can end with. */
export type ScanGateCode = 'IMAGE_SCAN_UNAVAILABLE' | 'PLUGIN_VULN_GATE';

const SCAN_GATE_CODES: readonly ScanGateCode[] = ['IMAGE_SCAN_UNAVAILABLE', 'PLUGIN_VULN_GATE'];

/** A build failure explained for a person. */
export interface BuildFailureInfo {
  /** The scan-gate code, or null for any other failure. */
  code: ScanGateCode | null;
  title: string;
  /** What happened and what to do next. */
  message: string;
  /** The findings behind a PLUGIN_VULN_GATE refusal (may be empty). */
  findings: VulnFinding[];
  /** The server's own text — the build log tail for an ordinary failure. */
  detail: string;
}

/**
 * Explain a failed build from its terminal event. The scan gates carry their
 * code in the event data (`code`, falling back to the message text) and the
 * refused findings in `findings`; every other failure is shown as the server
 * wrote it.
 */
export function buildFailureInfo(event: { message: string; data?: Record<string, unknown> }): BuildFailureInfo {
  const data = event.data ?? {};
  const declared = str(data.code) ?? str(data.errorCode) ?? str(data.reason);
  const code = SCAN_GATE_CODES.find((c) => c === declared) ?? SCAN_GATE_CODES.find((c) => event.message.includes(c)) ?? null;
  const findings = normalizeVulnFindings(data.findings ?? (data.details as Record<string, unknown> | undefined)?.findings);
  if (code === 'IMAGE_SCAN_UNAVAILABLE') {
    return {
      code,
      title: 'The image could not be scanned',
      message: 'Every plugin image is scanned for vulnerabilities before it is stored, and the scanner could not be reached '
        + 'after several attempts. Nothing was saved and your plugin quota was not used. Try the build again later.',
      findings,
      detail: event.message,
    };
  }
  if (code === 'PLUGIN_VULN_GATE') {
    return {
      code,
      title: 'Blocked by Critical vulnerabilities',
      message: 'The image has Critical vulnerabilities that already have a fix, more than this platform allows. '
        + 'Upgrade the affected packages (or the base image) to the fixed versions and build again.',
      findings,
      detail: event.message,
    };
  }
  return { code: null, title: 'Build failed', message: event.message, findings: [], detail: event.message };
}

// ---------------------------------------------------------------------------
// Lookup warnings
// ---------------------------------------------------------------------------

/**
 * How loud a vulnerability warning is, quietest first (api-core
 * `VULN_SEVERITIES`). Vulnerability state NEVER refuses a pipeline — not its
 * save, synth, deploy or run; it is graded, and the pipeline's owners are told.
 */
export const VULN_SEVERITIES: readonly VulnSeverity[] = ['info', 'warning', 'error', 'critical'];
/** A step's grade: a severity, or `ok` when nothing is worth saying. */
export type VulnGrade = 'ok' | VulnSeverity;

/** Narrow an unknown value to a severity (unknown → `info`, never louder than the server said). */
export function asVulnSeverity(v: unknown): VulnSeverity {
  return typeof v === 'string' && (VULN_SEVERITIES as readonly string[]).includes(v) ? (v as VulnSeverity) : 'info';
}

/** Rank of a grade, `ok` lowest. */
export function gradeRank(g: VulnGrade): number {
  return g === 'ok' ? -1 : VULN_SEVERITIES.indexOf(g);
}

/** The louder of two grades. */
export function louderGrade(a: VulnGrade, b: VulnGrade): VulnGrade {
  return gradeRank(a) >= gradeRank(b) ? a : b;
}

/** A warning a plugin lookup answers with (`POST /plugins/lookup` → `warnings[]`). */
export interface LookupWarning {
  code: string;
  message: string;
  /** Graded by the server; absent on the non-vulnerability warnings (deprecated, advisory, …). */
  severity?: VulnSeverity;
  plugin?: string;
  version?: string;
  critical?: number;
  high?: number;
  /** The top findings with their fixed versions (VULN_* codes). */
  findings?: unknown;
  /** `VULN_UPGRADE_AVAILABLE` / VULN_* — the version that clears it. */
  suggestedVersion?: string;
  /** `VULN_ACCEPTED`: when the pipeline's acceptance lapses. */
  acceptedUntil?: string | null;
}

/** The lookup warning for a version a rescan flagged (gated Criticals over the platform floor). */
export const VULN_FLAGGED = 'VULN_FLAGGED';
/** A finding on the CISA Known Exploited Vulnerabilities list. */
export const VULN_KEV = 'VULN_KEV';
/** Critical findings that already have a fix. */
export const VULN_CRITICAL_FIXABLE = 'VULN_CRITICAL_FIXABLE';
/** Fixable High findings (a `warning` over the org's `warnFixableHigh`, else `info`). */
export const VULN_HIGH_FIXABLE = 'VULN_HIGH_FIXABLE';
/** The pipeline accepted these findings until a date (downgraded to info). */
export const VULN_ACCEPTED = 'VULN_ACCEPTED';
/** The pin keeps the pipeline on a flagged version; `suggestedVersion` is the way out. */
export const VULN_UPGRADE_AVAILABLE = 'VULN_UPGRADE_AVAILABLE';

// ---------------------------------------------------------------------------
// Scan freshness and the new lookup outcomes
// ---------------------------------------------------------------------------

/**
 * Hours after which a stored scan counts as STALE — the plugin service's
 * default (`PLUGIN_SCAN_STALE_HOURS`). The fleet posture reports the deployed
 * value as `staleAfterHours`; surfaces that have it pass it instead.
 */
export const SCAN_STALE_AFTER_HOURS = 72;

/** Whole hours since `scannedAt`, or null when there is no (valid) scan time. */
export function scanAgeHours(scannedAt: string | null | undefined, now: number = Date.now()): number | null {
  if (!scannedAt) return null;
  const t = Date.parse(scannedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 3_600_000));
}

/** The lookup warning for a version that was stored without any scan. */
export const UNSCANNED = 'UNSCANNED';
/** The lookup warning for a version whose last scan is older than the stale window. */
export const SCAN_STALE = 'SCAN_STALE';
/** The lookup warning for a version an org compliance vulnerability rule objects to. */
export const COMPLIANCE_VULN_RULE = 'COMPLIANCE_VULN_RULE';
/** The lookup warning when the compliance check could not be reached. */
export const COMPLIANCE_UNAVAILABLE = 'COMPLIANCE_UNAVAILABLE';

/** Every vulnerability warning code the editor previews (tie-break order within a severity). */
export const VULN_LOOKUP_WARNING_CODES: readonly string[] = [
  VULN_KEV, VULN_FLAGGED, VULN_CRITICAL_FIXABLE, COMPLIANCE_VULN_RULE, VULN_HIGH_FIXABLE,
  UNSCANNED, SCAN_STALE, VULN_UPGRADE_AVAILABLE, VULN_ACCEPTED, COMPLIANCE_UNAVAILABLE,
];

/** A short heading per warning code (the server's `message` follows it). */
export const LOOKUP_WARNING_TITLES: Record<string, string> = {
  [VULN_KEV]: 'Known exploited',
  [VULN_FLAGGED]: 'Flagged by rescan',
  [VULN_CRITICAL_FIXABLE]: 'Fixable Critical findings',
  [VULN_HIGH_FIXABLE]: 'Fixable High findings',
  [VULN_ACCEPTED]: 'Risk accepted',
  [VULN_UPGRADE_AVAILABLE]: 'Upgrade available',
  [COMPLIANCE_VULN_RULE]: 'Compliance rule',
  [UNSCANNED]: 'Never scanned',
  [SCAN_STALE]: 'Scan out of date',
  [COMPLIANCE_UNAVAILABLE]: 'Compliance check unavailable',
};

/** Human label per severity. */
export const SEVERITY_LABELS: Record<VulnGrade, string> = {
  ok: 'OK', info: 'Info', warning: 'Warning', error: 'Error', critical: 'Critical',
};

/**
 * Order warnings loudest first, then by {@link VULN_LOOKUP_WARNING_CODES}
 * (unknown codes last). A warning without a severity counts as `info`.
 */
export function sortBySeverity<T extends { code: string; severity?: string }>(warnings: readonly T[]): T[] {
  const codeRank = (c: string) => {
    const i = VULN_LOOKUP_WARNING_CODES.indexOf(c);
    return i < 0 ? VULN_LOOKUP_WARNING_CODES.length : i;
  };
  return [...warnings].sort((a, b) =>
    gradeRank(asVulnSeverity(b.severity)) - gradeRank(asVulnSeverity(a.severity)) || codeRank(a.code) - codeRank(b.code));
}
