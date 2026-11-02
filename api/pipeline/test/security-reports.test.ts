// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { normalizeSecurityReport, SECURITY_REPORT_MAX_FINDINGS } from '../src/helpers/security-report.js';
import { memorySecurityReportStore, summarizeReports } from '../src/services/security-report-store.js';

describe('normalizeSecurityReport', () => {
  it('reads grype JSON: severities, fixability, KEV on a related record, de-duplicated matches', () => {
    const match = (id: string, severity: string, over: Record<string, unknown> = {}) => ({
      vulnerability: { id, severity, fix: { state: 'not-fixed', versions: [] } },
      artifact: { name: 'openssl', version: '3.0.1', locations: [{ path: '/usr/lib/libssl.so' }] },
      ...over,
    });
    const r = normalizeSecurityReport('grype-json', {
      matches: [
        match('CVE-1', 'Critical', { vulnerability: { id: 'CVE-1', severity: 'Critical', fix: { state: 'fixed', versions: ['3.0.2'] } } }),
        match('CVE-1', 'Critical'),
        match('GHSA-2', 'High', { relatedVulnerabilities: [{ id: 'CVE-2', knownExploited: [{ cve: 'CVE-2' }] }] }),
        match('CVE-3', 'Medium'),
        match('CVE-4', 'Negligible'),
      ],
    });
    expect(r.counts).toEqual({ critical: 1, high: 1, medium: 1, low: 0, kev: 1, criticalFixable: 1, highFixable: 0 });
    expect(r.findings.map((f) => [f.id, f.severity, f.kev ?? false, f.fixedIn])).toEqual([
      ['CVE-1', 'critical', false, ['3.0.2']],
      ['GHSA-2', 'high', true, []],
    ]);
    expect(r.findings[0]!.target).toBe('/usr/lib/libssl.so');
  });

  it('reads trivy JSON per target', () => {
    const r = normalizeSecurityReport('trivy-json', {
      Results: [
        { Target: 'package-lock.json', Vulnerabilities: [{ VulnerabilityID: 'CVE-9', PkgName: 'lodash', InstalledVersion: '4.17.0', FixedVersion: '4.17.21', Severity: 'HIGH' }] },
        { Target: 'alpine', Vulnerabilities: [{ VulnerabilityID: 'CVE-8', PkgName: 'musl', InstalledVersion: '1', Severity: 'LOW' }] },
        { Target: 'empty' },
      ],
    });
    expect(r.counts).toEqual(expect.objectContaining({ high: 1, low: 1, highFixable: 1 }));
    expect(r.findings).toEqual([expect.objectContaining({ id: 'CVE-9', packageName: 'lodash', fixedIn: ['4.17.21'], target: 'package-lock.json' })]);
  });

  it('reads SARIF: security-severity score first, else the result level', () => {
    const r = normalizeSecurityReport('sarif', {
      runs: [{
        tool: { driver: { rules: [{ id: 'sql-injection', properties: { 'security-severity': '9.8' } }, { id: 'weak-hash' }] } },
        results: [
          { ruleId: 'sql-injection', locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.ts' } } }] },
          { ruleId: 'weak-hash', level: 'error' },
          { ruleId: 'weak-hash', level: 'note', locations: [{ physicalLocation: { artifactLocation: { uri: 'src/b.ts' } } }] },
        ],
      }],
    });
    expect(r.counts).toEqual(expect.objectContaining({ critical: 1, high: 1, low: 1 }));
    expect(r.findings[0]).toEqual(expect.objectContaining({ id: 'sql-injection', severity: 'critical', target: 'src/db.ts', fixedIn: [] }));
  });

  it('refuses a report that is not the declared format (an unreadable scan is never clean)', () => {
    expect(() => normalizeSecurityReport('grype-json', { Results: [] })).toThrow(/matches/);
    expect(() => normalizeSecurityReport('trivy-json', { matches: [] })).toThrow(/Results/);
    expect(() => normalizeSecurityReport('sarif', {})).toThrow(/runs/);
  });

  it('caps stored findings but never the counts', () => {
    const matches = Array.from({ length: SECURITY_REPORT_MAX_FINDINGS + 5 }, (_, i) => ({
      vulnerability: { id: `CVE-${i}`, severity: 'High' }, artifact: { name: 'p', version: '1' },
    }));
    const r = normalizeSecurityReport('grype-json', { matches });
    expect(r.counts.high).toBe(SECURITY_REPORT_MAX_FINDINGS + 5);
    expect(r.findings).toHaveLength(SECURITY_REPORT_MAX_FINDINGS);
    expect(r.truncated).toBe(true);
  });
});

describe('security report store (in-memory double) + summary', () => {
  const counts = (critical: number, high: number) => ({ critical, high, medium: 0, low: 0, kev: 0, criticalFixable: 0, highFixable: 0 });
  const input = (tool: string, stage: string, c = counts(0, 0)) => ({
    orgId: 'org-1', pipelineId: 'p-1', tool, format: 'grype-json' as const, stage, executionId: null, counts: c, findings: [], truncated: false, submittedBy: 'user:u-1',
  });

  it('keeps the LATEST report per (tool, stage) and sums them', async () => {
    const store = memorySecurityReportStore();
    await store.put(input('grype', 'Build', counts(2, 0)));
    await store.put(input('grype', 'Build', counts(1, 1)));
    await store.put(input('semgrep', '', counts(0, 3)));
    const latest = await store.latest('org-1', ['p-1']);
    expect(latest).toHaveLength(2);
    expect(summarizeReports(latest).counts).toEqual(expect.objectContaining({ critical: 1, high: 4 }));
    expect(await store.latest('org-2', ['p-1'])).toEqual([]);
  });
});
