// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Application-artifact security reports: what a pipeline's OWN scan steps found
 * in what it builds (the image, the dependency tree, the source), as opposed to
 * the plugin images the steps run on (`plugin_vuln_exposure`).
 *
 * A scan step uploads its tool's raw report; it is normalized here, once, into
 * severity counts plus the Critical/High findings in the platform's finding
 * shape (`PluginScanFinding`, plus the `target` the finding was in). Three
 * formats, because three formats cover every scanner the plugin catalog ships:
 *
 *   - `sarif`      — SARIF 2.1.0 (semgrep, snyk, checkov, gitleaks, codeql …).
 *                    Severity from the rule's `security-severity` (CVSS score)
 *                    when present, else the result `level`.
 *   - `trivy-json` — `trivy … --format json` (`Results[].Vulnerabilities[]`).
 *   - `grype-json` — `grype -o json` (`matches[]`), incl. CISA KEV
 *                    (`knownExploited`) on the primary or a related record.
 *
 * An input that is not the declared format THROWS: a report that cannot be read
 * is a scan whose result is unknown, never a clean one.
 */

import { ADVISORY_SEVERITIES, type AdvisorySeverity, type PluginScanFinding } from '@pipeline-builder/api-core';
import type { SecurityReportFormat } from '@pipeline-builder/pipeline-core';

/** At most this many Critical/High findings are stored per report (counts are never capped). */
export const SECURITY_REPORT_MAX_FINDINGS = 200;

/** One stored finding: the plugin-scan shape plus where it was found. */
export interface ArtifactFinding extends PluginScanFinding {
  /** The scanned target — an image layer, a lockfile, a source path. */
  target?: string;
}

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  /** KEV-listed Critical + High. */
  kev: number;
  criticalFixable: number;
  highFixable: number;
}

export interface NormalizedSecurityReport {
  counts: SeverityCounts;
  findings: ArtifactFinding[];
  truncated: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function severityOf(raw: string): AdvisorySeverity | null {
  const s = raw.toLowerCase();
  return (ADVISORY_SEVERITIES as readonly string[]).includes(s) ? s as AdvisorySeverity : null;
}

/** CVSS score → severity (the SARIF `security-severity` convention GitHub and the scanners use). */
function severityFromScore(score: number): AdvisorySeverity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/** Collects findings, de-duplicated by (id, package, version, target). */
class Collector {
  readonly counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, kev: 0, criticalFixable: 0, highFixable: 0 };
  readonly findings: ArtifactFinding[] = [];
  private readonly seen = new Set<string>();

  add(severity: AdvisorySeverity, f: Omit<ArtifactFinding, 'severity'>): void {
    const key = `${f.id}|${f.packageName}|${f.packageVersion}|${f.target ?? ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.counts[severity]++;
    if (severity !== 'critical' && severity !== 'high') return;
    if (f.fixedIn.length > 0) this.counts[severity === 'critical' ? 'criticalFixable' : 'highFixable']++;
    if (f.kev) this.counts.kev++;
    this.findings.push({ ...f, severity });
  }

  result(): NormalizedSecurityReport {
    const rank = (b: boolean) => (b ? 0 : 1);
    const sorted = [...this.findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1)
      || rank(a.kev === true) - rank(b.kev === true)
      || rank(a.fixedIn.length > 0) - rank(b.fixedIn.length > 0));
    return { counts: this.counts, findings: sorted.slice(0, SECURITY_REPORT_MAX_FINDINGS), truncated: sorted.length > SECURITY_REPORT_MAX_FINDINGS };
  }
}

function parseSarif(report: Record<string, unknown>): NormalizedSecurityReport {
  if (!Array.isArray(report.runs)) throw new Error('SARIF report has no runs array');
  const c = new Collector();
  for (const run of report.runs) {
    const r = asRecord(run);
    const rules = new Map<string, Record<string, unknown>>();
    for (const rule of asArray(asRecord(asRecord(r.tool).driver).rules)) {
      const rr = asRecord(rule);
      if (str(rr.id)) rules.set(str(rr.id), rr);
    }
    for (const result of asArray(r.results)) {
      const res = asRecord(result);
      const ruleId = str(res.ruleId) || str(asRecord(res.rule).id);
      if (!ruleId) continue;
      const rule = rules.get(ruleId) ?? {};
      const score = Number(asRecord(rule.properties)['security-severity'] ?? asRecord(res.properties)['security-severity']);
      const level = str(res.level) || str(asRecord(rule.defaultConfiguration).level) || 'warning';
      const severity = Number.isFinite(score) && score > 0
        ? severityFromScore(score)
        : level === 'error' ? 'high' : level === 'warning' ? 'medium' : 'low';
      const location = asRecord(asRecord(asArray(res.locations)[0]).physicalLocation);
      c.add(severity, {
        id: ruleId,
        packageName: '',
        packageVersion: '',
        // A code finding has no fixed package version; "fixable" is a dependency notion.
        fixedIn: [],
        ...(str(asRecord(location.artifactLocation).uri) ? { target: str(asRecord(location.artifactLocation).uri) } : {}),
      });
    }
  }
  return c.result();
}

function parseTrivy(report: Record<string, unknown>): NormalizedSecurityReport {
  if (!Array.isArray(report.Results)) throw new Error('trivy report has no Results array');
  const c = new Collector();
  for (const result of report.Results) {
    const res = asRecord(result);
    for (const vuln of asArray(res.Vulnerabilities)) {
      const v = asRecord(vuln);
      const severity = severityOf(str(v.Severity));
      if (!str(v.VulnerabilityID) || !severity) continue;
      const fixed = str(v.FixedVersion).split(',').map((x) => x.trim()).filter(Boolean);
      c.add(severity, {
        id: str(v.VulnerabilityID),
        packageName: str(v.PkgName),
        packageVersion: str(v.InstalledVersion),
        fixedIn: fixed,
        ...(str(res.Target) ? { target: str(res.Target) } : {}),
      });
    }
  }
  return c.result();
}

function parseGrype(report: Record<string, unknown>): NormalizedSecurityReport {
  if (!Array.isArray(report.matches)) throw new Error('grype report has no matches array');
  const c = new Collector();
  for (const match of report.matches) {
    const m = asRecord(match);
    const vuln = asRecord(m.vulnerability);
    const severity = severityOf(str(vuln.severity));
    if (!str(vuln.id) || !severity) continue;
    const fix = asRecord(vuln.fix);
    const fixedIn = str(fix.state).toLowerCase() === 'fixed'
      ? asArray(fix.versions).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
      : [];
    // KEV is keyed by CVE: a GHSA-primary match carries it on a related record.
    const kev = [vuln, ...asArray(m.relatedVulnerabilities).map(asRecord)].some((r) => asArray(r.knownExploited).length > 0);
    const artifact = asRecord(m.artifact);
    const location = str(asRecord(asArray(artifact.locations)[0]).path);
    c.add(severity, {
      id: str(vuln.id),
      packageName: str(artifact.name),
      packageVersion: str(artifact.version),
      fixedIn,
      ...(kev ? { kev: true } : {}),
      ...(location ? { target: location } : {}),
    });
  }
  return c.result();
}

/** Normalize a raw report of `format` (see the module doc). Throws on a report that is not that format. */
export function normalizeSecurityReport(format: SecurityReportFormat, report: unknown): NormalizedSecurityReport {
  const r = asRecord(report);
  switch (format) {
    case 'sarif': return parseSarif(r);
    case 'trivy-json': return parseTrivy(r);
    case 'grype-json': return parseGrype(r);
  }
}
