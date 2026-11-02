// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * THE vulnerability assessment of one resolved plugin version, for one org (and,
 * optionally, one pipeline's risk acceptance). One function, three callers:
 * `/plugins/lookup` (what synth pins), `/plugins/runtime-check` (what a running
 * pipeline is about to execute) and the pipeline service's save-time contract
 * check. Three copies of these rules drifted once already.
 *
 * Vulnerability state NEVER refuses a pipeline — not its save, its synth, its
 * deploy or its run. What it produces is SEVERITY-GRADED warnings (and, from the
 * callers, notifications to the pipeline's owners). The grades:
 *
 *   critical — a finding on the CISA Known Exploited Vulnerabilities list
 *   error    — the version is FLAGGED (gated Criticals over the platform floor),
 *              it has fixable Critical findings, or an org compliance rule on the
 *              vulnerability attributes is in BLOCK mode and fails
 *   warning  — fixable High findings over the org's `warnFixableHigh`, a version
 *              never scanned, a scan older than `PLUGIN_SCAN_STALE_HOURS`, or a
 *              compliance rule in WARN mode
 *   info     — what a reader may want to know but need not act on
 *
 * A PIPELINE's active risk acceptance (`plugin_vuln_exposure`, triaged `accepted`
 * with a reason and an expiry) downgrades the warnings about the findings it
 * ACCEPTED to `info` ("accepted until …") — never one about a finding that
 * appeared since, never a KEV one unless the acceptance said `kev: true`, and
 * never the scan-freshness or compliance warnings (neither is about a finding).
 */

import { createComplianceClient, type ComplianceViolation } from './compliance-client.js';
import { getServiceAuthHeader } from '../middleware/service-tokens.js';
import { isSystemOrgId } from '../middleware/system-org.js';
import {
  asScanFlag, describeFindings, isGatedFinding, pluginVulnGateKev, scanFindingKey,
  type PluginScanFinding, type PluginScanFlag,
} from '../types/plugin-scan.js';
import { envInt } from '../utils/env.js';
import { derivePluginImageCompliance, pluginRunsOwnImage, type PluginComplianceAttributes, type PluginImageRow } from '../utils/plugin-compliance.js';
import { errorMessage } from '../utils/response.js';

/** How loud a warning is, quietest first. */
export const VULN_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export type VulnSeverity = typeof VULN_SEVERITIES[number];

/** The louder of two severities. */
export function maxSeverity(a: VulnSeverity, b: VulnSeverity): VulnSeverity {
  return VULN_SEVERITIES.indexOf(a) >= VULN_SEVERITIES.indexOf(b) ? a : b;
}

/** Whether `s` is at least `floor`. */
export function severityAtLeast(s: VulnSeverity, floor: VulnSeverity): boolean {
  return VULN_SEVERITIES.indexOf(s) >= VULN_SEVERITIES.indexOf(floor);
}

/** `PLUGIN_SCAN_STALE_HOURS` (default 72): a scan older than this is stale. */
export function scanStaleHours(): number {
  return envInt('PLUGIN_SCAN_STALE_HOURS', 72, { min: 1 });
}

/** The scan-related fields of a resolved record (an org row or a listed record). */
export interface ScannedRecord extends PluginImageRow {
  name: string;
  version: string;
  scannedAt?: Date | string | null;
  scanSummary?: unknown;
  scanFlaggedAt?: Date | string | null;
  scanFlag?: unknown;
  vulnHighFixable?: unknown;
}

const toDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

const summaryOf = (record: Pick<ScannedRecord, 'scanSummary'>): Record<string, unknown> | null =>
  (record.scanSummary && typeof record.scanSummary === 'object' && !Array.isArray(record.scanSummary)
    ? record.scanSummary as Record<string, unknown> : null);

/**
 * When the version was last scanned: the later of the build-time `scannedAt` and
 * the nightly rescan's `scan_summary.scannedAt`. Null = never.
 */
export function lastScannedAt(record: Pick<ScannedRecord, 'scannedAt' | 'scanSummary'>): Date | null {
  const build = toDate(record.scannedAt);
  const summary = toDate(summaryOf(record)?.scannedAt);
  if (!build) return summary;
  if (!summary) return build;
  return summary > build ? summary : build;
}

/** Whether the record runs a BUILT image of its own — the only thing a scan applies to. */
function hasImage(record: ScannedRecord): boolean {
  return pluginRunsOwnImage(record) && typeof record.imageDigest === 'string' && record.imageDigest.length > 0;
}

/** Freshness of a version's scan: `none` (no image to scan), `unscanned`, `stale` or `fresh`. */
export function scanFreshness(record: ScannedRecord, now = new Date()): { state: 'none' | 'unscanned' | 'stale' | 'fresh'; scannedAt: Date | null } {
  if (!hasImage(record)) return { state: 'none', scannedAt: null };
  const at = lastScannedAt(record);
  if (!at) return { state: 'unscanned', scannedAt: null };
  return { state: now.getTime() - at.getTime() > scanStaleHours() * 3_600_000 ? 'stale' : 'fresh', scannedAt: at };
}

/** One severity-graded vulnerability warning. */
export type VulnWarning =
  | {
    code: 'VULN_KEV' | 'VULN_FLAGGED' | 'VULN_CRITICAL_FIXABLE' | 'VULN_HIGH_FIXABLE';
    severity: VulnSeverity;
    message: string;
    findings: PluginScanFinding[];
    suggestedVersion?: string;
    /** `VULN_FLAGGED` carries the flag's counts (the shape the rescan-flag warning always had). */
    plugin?: string;
    version?: string;
    critical?: number;
    high?: number;
  }
  | { code: 'VULN_ACCEPTED'; severity: 'info'; message: string; findings: string[]; acceptedUntil: string | null; kev: boolean; covers: string }
  | { code: 'UNSCANNED'; severity: VulnSeverity; message: string }
  | { code: 'SCAN_STALE'; severity: VulnSeverity; message: string; scannedAt: string; staleAfterHours: number }
  | { code: 'COMPLIANCE_VULN_RULE'; severity: VulnSeverity; message: string; ruleId: string; ruleName: string; field: string; mode: 'block' | 'warn' }
  | { code: 'COMPLIANCE_UNAVAILABLE'; severity: VulnSeverity; message: string };

/** `UNSCANNED` / `SCAN_STALE` for a resolved version (empty for a fresh scan or an image-less plugin). */
export function scanWarnings(record: ScannedRecord, now = new Date()): VulnWarning[] {
  const ref = `${record.name}@${record.version}`;
  const f = scanFreshness(record, now);
  if (f.state === 'unscanned') {
    return [{ code: 'UNSCANNED', severity: 'warning', message: `Plugin ${ref} has never been scanned for vulnerabilities; nothing is known about what its image contains.` }];
  }
  if (f.state === 'stale') {
    const hours = scanStaleHours();
    return [{
      code: 'SCAN_STALE',
      severity: 'warning',
      message: `Plugin ${ref} was last scanned ${f.scannedAt!.toISOString()}, more than ${hours}h ago; findings published since are not reflected.`,
      scannedAt: f.scannedAt!.toISOString(),
      staleAfterHours: hours,
    }];
  }
  return [];
}

/** The vulnerability fields of an org's consumption policy (pipeline-data's `ConsumptionPolicy` satisfies it). */
export interface VulnConsumptionPolicy {
  /** Fixable High findings above this many raise a `warning`; null = never (they stay `info`). */
  warnFixableHigh: number | null;
}

/**
 * A pipeline's ACTIVE risk acceptance of one version / image: the finding keys
 * ({@link scanFindingKey}) it accepted, whether it accepted KEV findings, and
 * until when. Built by pipeline-data from `plugin_vuln_exposure`.
 */
export interface VulnAcceptance {
  findingKeys: readonly string[];
  kev: boolean;
  acceptedUntil: Date | string | null;
}

/** What a version's stored scan says, normalized from `scan_summary` (for its image) and `scan_flag`. */
export interface VersionScanFacts {
  flagged: boolean;
  flag: PluginScanFlag | null;
  /** Fixable Critical / High findings (null = not known). */
  criticalFixable: number | null;
  highFixable: number | null;
  /** Totals including unfixable findings (null = not known). */
  critical: number | null;
  high: number | null;
  /** KEV-listed Critical + High findings. */
  kev: number;
  /** Every Critical/High finding the scan itemized (the summary's list, else the flag's). */
  findings: PluginScanFinding[];
  /** The summary cut its findings list — a subset check over it cannot be trusted. */
  truncated: boolean;
  scannedAt: Date | null;
}

/** The normalized scan facts of a resolved record. A summary describing another image is ignored. */
export function versionScanFacts(record: ScannedRecord): VersionScanFacts {
  const flag = record.scanFlaggedAt ? asScanFlag(record.scanFlag) : null;
  const raw = summaryOf(record);
  const digest = typeof raw?.imageDigest === 'string' ? raw.imageDigest : null;
  const summary = raw && (digest === null || !record.imageDigest || digest === record.imageDigest) ? raw : null;
  const findings = summary && Array.isArray(summary.findings)
    ? (summary.findings as PluginScanFinding[]).filter((f) => f && typeof f.id === 'string').map((f) => ({ ...f, fixedIn: Array.isArray(f.fixedIn) ? f.fixedIn : [] }))
    : (flag?.findings ?? []);
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const kevCount = Math.max(num(summary?.kev) ?? 0, flag?.kev ?? 0, findings.filter((f) => f.kev === true).length);
  return {
    flagged: flag !== null,
    flag,
    criticalFixable: num(summary?.criticalFixable),
    highFixable: num(summary?.highFixable) ?? num(record.vulnHighFixable),
    critical: num(summary?.critical),
    high: num(summary?.high),
    kev: kevCount,
    findings,
    truncated: summary?.truncated === true,
    scannedAt: lastScannedAt(record),
  };
}

/**
 * Whether `acceptance` covers EVERY one of `findings` (by finding key), and its
 * KEV ones only when it accepted KEV. An empty set is never "covered": with
 * nothing itemized there is nothing an acceptance can be shown to describe.
 */
function covers(acceptance: VulnAcceptance | null | undefined, findings: readonly PluginScanFinding[], truncated: boolean): boolean {
  if (!acceptance || truncated || findings.length === 0) return false;
  const keys = new Set(acceptance.findingKeys);
  return findings.every((f) => keys.has(scanFindingKey(f)) && (f.kev !== true || acceptance.kev));
}

/** Input to {@link assessVersionVulns}. */
export interface VersionVulnInput {
  orgId: string;
  record: ScannedRecord;
  policy: VulnConsumptionPolicy;
  /** The pipeline's active acceptance of this version / image, when the caller has a pipeline. */
  acceptance?: VulnAcceptance | null;
  /** The newest unflagged version the owner can move to, named on the finding warnings. */
  suggestedVersion?: string | null;
  /** Run the org's compliance rules (a network call). Default true. */
  compliance?: boolean;
  now?: Date;
}

/** The assessment: every warning, the loudest severity, and which accepted findings it downgraded. */
export interface VersionVulnAssessment {
  /** `null` when there is nothing to say. */
  severity: VulnSeverity | null;
  warnings: VulnWarning[];
  /** Finding keys an acceptance downgraded (empty = no acceptance applied). */
  acceptedFindings: string[];
  facts: VersionScanFacts;
}

/** The loudest severity of `warnings`, or null for none. */
export function severityOf(warnings: ReadonlyArray<{ severity?: VulnSeverity }>): VulnSeverity | null {
  return warnings.reduce<VulnSeverity | null>((acc, w) => (w.severity ? (acc ? maxSeverity(acc, w.severity) : w.severity) : acc), null);
}

/**
 * The assessment of one resolved version (see the module doc). Never throws and
 * never refuses: a compliance outage adds an `info` `COMPLIANCE_UNAVAILABLE`.
 */
export async function assessVersionVulns(input: VersionVulnInput): Promise<VersionVulnAssessment> {
  const { orgId, record, policy, acceptance } = input;
  const now = input.now ?? new Date();
  const ref = `${record.name}@${record.version}`;
  const facts = versionScanFacts(record);
  const warnings: VulnWarning[] = [...scanWarnings(record, now)];
  const accepted = new Set<string>();
  const way = input.suggestedVersion ? ` Move to ${record.name}@${input.suggestedVersion}.` : '';
  const suggested = input.suggestedVersion ? { suggestedVersion: input.suggestedVersion } : {};
  const until = toDate(acceptance?.acceptedUntil)?.toISOString() ?? null;

  /** Push a finding warning — or, when the pipeline accepted exactly those findings, its `info` downgrade. */
  const finding = (code: 'VULN_KEV' | 'VULN_FLAGGED' | 'VULN_CRITICAL_FIXABLE' | 'VULN_HIGH_FIXABLE', severity: VulnSeverity, message: string, findings: PluginScanFinding[],
    extra: { plugin?: string; version?: string; critical?: number; high?: number } = {}) => {
    if (covers(acceptance, findings, facts.truncated)) {
      for (const f of findings) accepted.add(scanFindingKey(f));
      warnings.push({
        code: 'VULN_ACCEPTED',
        severity: 'info',
        message: `${message} Accepted for this pipeline${until ? ` until ${until}` : ''}.`,
        findings: findings.map(scanFindingKey),
        acceptedUntil: until,
        kev: acceptance?.kev ?? false,
        covers: code,
      });
      return;
    }
    warnings.push({ code, severity, message: `${message}${way}`, findings: findings.slice(0, 10), ...suggested, ...extra });
  };

  const kevFindings = facts.findings.filter((f) => f.kev === true);
  if (facts.kev > 0) {
    finding('VULN_KEV', 'critical', `${ref} has ${facts.kev} finding${facts.kev === 1 ? '' : 's'} on the CISA Known Exploited Vulnerabilities list${kevFindings.length ? `: ${describeFindings(kevFindings)}` : ''}.`, kevFindings);
  }
  const flag = facts.flag;
  if (flag) {
    const gated = facts.findings.filter((f) => isGatedFinding(f, pluginVulnGateKev()));
    finding('VULN_FLAGGED', 'error', `${ref} is flagged: a rescan found ${flag.critical} gated Critical finding${flag.critical === 1 ? '' : 's'} over the platform limit${flag.findings.length ? ` (fix: ${describeFindings(flag.findings)})` : ''}.`,
      gated.length > 0 ? gated : flag.findings, { plugin: record.name, version: record.version, critical: flag.critical, high: flag.high });
  } else if ((facts.criticalFixable ?? 0) > 0) {
    const crits = facts.findings.filter((f) => f.severity === 'critical' && f.fixedIn.length > 0);
    finding('VULN_CRITICAL_FIXABLE', 'error', `${ref} has ${facts.criticalFixable} fixable Critical finding${facts.criticalFixable === 1 ? '' : 's'}${crits.length ? `: ${describeFindings(crits)}` : ''}.`, crits);
  }
  const highFixable = facts.highFixable ?? 0;
  if (highFixable > 0) {
    const highs = facts.findings.filter((f) => f.severity === 'high' && f.fixedIn.length > 0);
    const over = policy.warnFixableHigh !== null && highFixable > policy.warnFixableHigh;
    finding('VULN_HIGH_FIXABLE', over ? 'warning' : 'info',
      `${ref} has ${highFixable} fixable High finding${highFixable === 1 ? '' : 's'}${over ? `, over your organization's threshold of ${policy.warnFixableHigh}` : ''}.`, highs);
  }

  if (input.compliance !== false) warnings.push(...await complianceVulnWarnings(orgId, record));
  return { severity: severityOf(warnings), warnings, acceptedFindings: [...accepted], facts };
}

/** The compliance attributes a plugin's vulnerability rules read. */
const VULN_RULE_FIELDS = new Set(['scanned', 'vulnCritical', 'vulnHigh', 'vulnMedium', 'vulnLow', 'vulnCriticalFixable', 'vulnHighFixable']);

const fieldRoot = (field: string): string => field.split(/[.[]/)[0] ?? field;

type ComplianceClient = Pick<ReturnType<typeof createComplianceClient>, 'dryRunPlugin'>;

let complianceClient: ComplianceClient | null = null;

/** Test hook: replace the compliance client the assessment's compliance layer calls. */
export function setVulnPolicyComplianceClientForTests(client: ComplianceClient | null): void {
  complianceClient = client;
}

/**
 * The org's plugin compliance rules on the vulnerability attributes, evaluated
 * against the RESOLVED version — the org's own row, its parent's, a system
 * plugin or an installed marketplace version alike. A BLOCK-mode rule that fails
 * is an `error`, a WARN-mode one a `warning`; neither refuses anything here
 * (vulnerability state never stops a pipeline).
 *
 * Only the vuln / scanned rules count here: the plugin's other rules (tags,
 * secrets, commands …) describe how a plugin is AUTHORED, which is its owner's
 * concern at upload, not the consumer's at resolution — and a system plugin would
 * otherwise fail every tenant's authoring rules.
 */
async function complianceVulnWarnings(orgId: string, record: ScannedRecord): Promise<VulnWarning[]> {
  if (isSystemOrgId(orgId) || !hasImage(record)) return [];
  const facts = derivePluginImageCompliance(record, null).attributes;
  const attributes: PluginComplianceAttributes = { name: record.name, version: record.version, ...facts };
  try {
    complianceClient ??= createComplianceClient();
    const auth = getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' });
    const result = await complianceClient.dryRunPlugin(orgId, attributes as Record<string, unknown>, auth);
    const relevant = (v: ComplianceViolation) => VULN_RULE_FIELDS.has(fieldRoot(v.field));
    const as = (mode: 'block' | 'warn') => (v: ComplianceViolation): VulnWarning => ({
      code: 'COMPLIANCE_VULN_RULE',
      severity: mode === 'block' ? 'error' : 'warning',
      message: `${record.name}@${record.version}: ${v.message}`,
      ruleId: v.ruleId,
      ruleName: v.ruleName,
      field: v.field,
      mode,
    });
    return [...result.violations.filter(relevant).map(as('block')), ...result.warnings.filter(relevant).map(as('warn'))];
  } catch (err) {
    return [{ code: 'COMPLIANCE_UNAVAILABLE', severity: 'info', message: `Your organization's plugin vulnerability rules could not be checked for ${record.name}@${record.version} (${errorMessage(err)}).` }];
  }
}
