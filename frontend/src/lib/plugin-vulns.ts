// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Vulnerability-scan facts of a plugin version, as the plugin service reports
 * them, and the build refusals the scan gates produce.
 *
 * A finding is FIXABLE when the scanner knows a fixed version of the affected
 * package. The platform floor (`PLUGIN_VULN_MAX_FINDINGS`) and the ecosystem
 * gate count the GATED findings — fixable, or KEV-listed, at or above
 * `PLUGIN_VULN_FAIL_ON` — so which severities gate is a DEPLOYMENT CHOICE, not
 * a constant: `critical` (the default) gates Criticals, `high` gates Critical
 * AND High. A finding below the threshold, or with no fix yet, is shown but does
 * not fail a build. NULL counts mean the image was never scanned.
 *
 * Nothing here re-derives that rule. `gatedFixableCount` / `failOnLabel` /
 * `atOrAboveFailOn` / `exceedsVulnFloor` come from api-core, which is where the
 * gate itself reads them, so the badge cannot disagree with the build. It did:
 * this file hardcoded "fixable Criticals" and named `PLUGIN_VULN_MAX_CRITICAL`,
 * an env var the platform no longer has — so under `PLUGIN_VULN_FAIL_ON=high` a
 * version with no Criticals and eight fixable Highs showed a yellow badge beside
 * a build that refused it.
 *
 * Those gates apply to plugin BUILDS only. A pipeline is never refused for a
 * plugin's vulnerabilities: lookups, saves and runtime checks answer
 * severity-graded warnings (`info|warning|error|critical`) instead.
 */

// Runtime helpers come from the browser-safe `./plugin-scan` subpath (its only
// imports are two dependency-free leaves), never the root barrel — that pulls
// the server graph into the bundle. The severity ladder comes from the
// dependency-free `./wire-vocabulary` subpath.
import {
  failOnLabel,
  gatedFixableCount,
  type PluginVulnFailOn,
} from '@pipeline-builder/api-core/plugin-scan';
import { VULN_SEVERITIES, type VulnSeverity } from '@pipeline-builder/api-core/wire-vocabulary';

export type { VulnSeverity };

/** Which severities a deployment gates on: `critical` (default) or `high`. */
export type VulnFailOn = PluginVulnFailOn;

/**
 * The gated finding count for a version under `failOn` — Criticals, plus Highs
 * when the deployment gates on `high`. THE number the badge's severity and the
 * fleet ranking must use; the fixable-Critical count alone is what made a
 * gating version look clean.
 */
export function gatedCount(facts: VulnFacts, failOn: VulnFailOn = 'critical'): number | null {
  if (facts.vulnCriticalFixable == null && facts.vulnHighFixable == null) return null;
  return gatedFixableCount(
    { vulnCriticalFixable: facts.vulnCriticalFixable ?? 0, vulnHighFixable: facts.vulnHighFixable ?? 0 },
    failOn,
  );
}

/** `Critical` / `Critical or High` — what this deployment gates on, in words. */
export function gateThresholdLabel(failOn: VulnFailOn = 'critical'): string {
  return failOnLabel(failOn);
}

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
  /** Gated findings: at or above `failOn` and fixable (or KEV-listed). */
  gated: number;
  high: number;
  findings: VulnFinding[];
  /**
   * The `PLUGIN_VULN_FAIL_ON` the flag was raised at; absent = `critical`.
   *
   * On the wire BECAUSE of this surface — the plugin service put it on the flag
   * so the services that render it (the resolver, this dashboard) need not share
   * its environment. It was then parsed away here, which is why the console
   * could not say which threshold applied.
   */
  failOn?: VulnFailOn;
  /** The floor the gated count was compared against (`PLUGIN_VULN_MAX_FINDINGS`). */
  maxFindings?: number | null;
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
  // `failOn` is only ever sent as `'high'` (absent means the default), so an
  // unrecognized value falls back to the default rather than being trusted.
  const failOn: VulnFailOn = o.failOn === 'high' ? 'high' : 'critical';
  return {
    gated: num(o.gated) ?? 0,
    high: num(o.high) ?? 0,
    findings: normalizeVulnFindings(o.findings ?? o.top ?? o.topFindings),
    failOn,
    maxFindings: num(o.maxFindings),
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

/**
 * A CAPACITY refusal, which is a different kind of answer from a scan gate.
 *
 * Its own code because its REMEDY is its own, and that is the whole point: a
 * build can be refused several ways and only some of them are a purchase. One
 * shared message would send all of them to the billing page, where this one has
 * nothing to buy — the org sat at its per-class concurrency cap for the whole
 * wait budget, so the answer is to wait or to use the other class.
 *
 * The MONTHLY-budget refusal is deliberately NOT here: it is refused at
 * submission with a 429, which `core.ts` already turns into the `quota-exceeded`
 * window event that `QuotaBanner` renders, and `BuildCostHint` says it before
 * the submit. A build never fails mid-flight for want of credits — the charge
 * is best-effort after the fact — so a branch for it here would be dead code
 * pretending to be a disposition.
 */
export type BuildCapacityCode = 'BUILD_SLOT_TIMEOUT';

/** A build failure explained for a person. */
export interface BuildFailureInfo {
  /** The scan-gate or capacity code, or null for any other failure. */
  code: ScanGateCode | BuildCapacityCode | null;
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

  // CAPACITY first, because a capacity refusal is not a build defect and must
  // not be read as one. Both are recognised from the terminal event's typed
  // details rather than its prose: the slot timeout carries `maxBuildsPerOrg`
  // (the processor's UnrecoverableError details), and the credit refusal is a
  // quota denial naming `cpuCredits`.
  const typedDetails = (data.details ?? {}) as Record<string, unknown>;
  const slotCap = num(typedDetails.maxBuildsPerOrg) ?? num(data.maxBuildsPerOrg);
  if (declared === 'SERVICE_UNAVAILABLE' && slotCap != null) {
    const cls = str(typedDetails.buildClass) ?? str(data.buildClass) ?? 'standard';
    return {
      code: 'BUILD_SLOT_TIMEOUT',
      title: 'No build slot was free in time',
      // The remedy is a WAIT. Saying so explicitly is the point: this refusal
      // used to arrive with no reason at all, and once a credit budget sits on
      // the same page a silent wait gets blamed on the quota.
      message: `This organization already had ${slotCap} ${cls} build${slotCap === 1 ? '' : 's'} running for the whole wait window, `
        + 'so this one was never started. There is nothing to buy and nothing to fix — submit it again once one finishes'
        + (cls === 'flexible' ? ', or run it in the standard class.' : ', or defer it to the flexible class, which has more room.'),
      findings: [],
      detail: event.message,
    };
  }
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
    // WHICH severities blocked is a deployment choice (`PLUGIN_VULN_FAIL_ON`),
    // so this cannot say "Critical" and be right. The gate's AppError details
    // carry the threshold (`details.failOn`, always set by the plugin service);
    // only an event without it falls back to the findings — and that fallback is
    // weaker than it looks, because the listed findings include fixable Highs
    // even under a `critical` gate.
    const details = (data.details ?? {}) as Record<string, unknown>;
    const failOnRaw = str(details.failOn) ?? str(data.failOn);
    const declaredFailOn = failOnRaw === 'high' ? 'high' : failOnRaw === 'critical' ? 'critical' : null;
    const blockedOnHigh = findings.some((f) => f.severity.toLowerCase() === 'high');
    const failOn: VulnFailOn = declaredFailOn ?? (blockedOnHigh ? 'high' : 'critical');
    const label = gateThresholdLabel(failOn);
    const floor = num(details.maxFindings) ?? num(data.maxFindings);
    return {
      code,
      title: `Blocked by ${label} vulnerabilities`,
      message: `The image has ${label} vulnerabilities that already have a fix, more than this platform allows`
        + (floor != null ? ` (the floor is ${floor})` : '')
        + '. Upgrade the affected packages (or the base image) to the fixed versions and build again.',
      findings,
      detail: event.message,
    };
  }
  return { code: null, title: 'Build failed', message: event.message, findings: [], detail: event.message };
}

// ---------------------------------------------------------------------------
// Lookup warnings
// ---------------------------------------------------------------------------

/*
 * How loud a vulnerability warning is, quietest first: api-core's
 * `VULN_SEVERITIES`. Vulnerability state NEVER refuses a pipeline — not its
 * save, synth, deploy or run; it is graded, and the pipeline's owners are told.
 */
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

/** A warning a plugin lookup answers with (`POST /plugins/lookup` → `warnings[]`). */
export interface LookupWarning {
  code: string;
  message: string;
  /** Graded by the server; absent on the non-vulnerability warnings (deprecated, advisory, …). */
  severity?: VulnSeverity;
  plugin?: string;
  version?: string;
  /** `VULN_FLAGGED`: the flag's gated count. */
  gated?: number;
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
