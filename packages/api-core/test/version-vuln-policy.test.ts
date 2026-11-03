// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one vulnerability assessment lookup, runtime-check and the save-time
 * contract check share. It never refuses: every outcome is a severity-graded
 * warning, and a pipeline's risk acceptance downgrades exactly what it accepted.
 */

import { afterEach, describe, it, expect } from '@jest/globals';

import {
  assessVersionVulns, lastScannedAt, maxSeverity, scanFreshness, setVulnPolicyComplianceClientForTests, versionScanFacts,
} from '../src/services/version-vuln-policy.js';
import { scanFindingKey, type PluginScanFinding } from '../src/types/plugin-scan.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const now = new Date('2026-11-02T12:00:00Z');
const image = { name: 'x', version: '1.0.0', buildType: 'build_image', pluginType: 'CodeBuildStep', imageDigest: DIGEST, scannedAt: '2026-11-02T00:00:00Z' };
const policy = { warnFixableHigh: 0 };

const crit = (id: string, extra: Partial<PluginScanFinding> = {}): PluginScanFinding =>
  ({ id, severity: 'critical', packageName: 'openssl', packageVersion: '3.0.1', fixedIn: ['3.0.2'], ...extra });
const high = (id: string): PluginScanFinding => ({ id, severity: 'high', packageName: 'zlib', packageVersion: '1.2', fixedIn: ['1.3'] });
const summary = (findings: PluginScanFinding[], extra: Record<string, unknown> = {}) => ({
  criticalFixable: findings.filter((f) => f.severity === 'critical' && f.fixedIn.length).length,
  highFixable: findings.filter((f) => f.severity === 'high' && f.fixedIn.length).length,
  kev: findings.filter((f) => f.kev).length,
  findings,
  truncated: false,
  imageDigest: DIGEST,
  scannedAt: '2026-11-02T00:00:00Z',
  ...extra,
});
const flagged = (findings: PluginScanFinding[]) => ({
  ...image,
  scanFlaggedAt: '2026-11-01T00:00:00Z',
  scanFlag: { gated: findings.filter((f) => f.severity === 'critical').length, high: 0, maxFindings: 0, findings },
  scanSummary: summary(findings),
});

afterEach(() => {
  delete process.env.PLUGIN_SCAN_STALE_HOURS;
  setVulnPolicyComplianceClientForTests(null);
});

describe('scan freshness', () => {
  it('takes the later of the build scan and the rescan summary', () => {
    expect(lastScannedAt({ scannedAt: '2026-10-01T00:00:00Z', scanSummary: { scannedAt: '2026-11-01T00:00:00Z' } })?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(lastScannedAt({ scannedAt: null, scanSummary: null })).toBeNull();
  });

  it('is none for an image-less plugin, unscanned / stale / fresh otherwise', () => {
    expect(scanFreshness({ ...image, buildType: 'metadata_only' }, now).state).toBe('none');
    expect(scanFreshness({ ...image, imageDigest: null }, now).state).toBe('none');
    expect(scanFreshness({ ...image, scannedAt: null }, now).state).toBe('unscanned');
    expect(scanFreshness({ ...image, scannedAt: '2026-10-25T00:00:00Z' }, now).state).toBe('stale');
    process.env.PLUGIN_SCAN_STALE_HOURS = '24000';
    expect(scanFreshness({ ...image, scannedAt: '2026-10-25T00:00:00Z' }, now).state).toBe('fresh');
  });
});

describe('assessVersionVulns', () => {
  const run = (record: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    assessVersionVulns({ orgId: 'org-a', record: record as never, policy, compliance: false, now, ...extra });

  it('says nothing about a fresh, clean scan', async () => {
    const a = await run({ ...image, scanSummary: summary([]) });
    expect(a).toMatchObject({ severity: null, warnings: [] });
  });

  it('warns (never refuses) on an unscanned image', async () => {
    const a = await run({ ...image, scannedAt: null });
    expect(a.severity).toBe('warning');
    expect(a.warnings.map((w) => w.code)).toEqual(['UNSCANNED']);
  });

  it('grades a flagged version error, naming the version to move to', async () => {
    const a = await run(flagged([crit('CVE-1')]), { suggestedVersion: '1.0.3' });
    expect(a.severity).toBe('error');
    expect(a.warnings[0]).toMatchObject({ code: 'VULN_FLAGGED', severity: 'error', suggestedVersion: '1.0.3', plugin: 'x', gated: 1 });
    expect(a.warnings[0]!.message).toContain('x@1.0.3');
  });

  it('grades a KEV finding critical, fixable or not', async () => {
    const a = await run({ ...image, scanSummary: summary([crit('CVE-9', { kev: true, fixedIn: [] })]) });
    expect(a.severity).toBe('critical');
    expect(a.warnings.map((w) => w.code)).toContain('VULN_KEV');
  });

  it('grades fixable High against the org threshold', async () => {
    const record = { ...image, scanSummary: summary([high('CVE-3'), high('CVE-4')]) };
    expect((await run(record, { policy: { warnFixableHigh: 1 } })).severity).toBe('warning');
    expect((await run(record, { policy: { warnFixableHigh: 2 } })).severity).toBe('info');
    expect((await run(record, { policy: { warnFixableHigh: null } })).severity).toBe('info');
  });

  it('downgrades exactly the accepted findings to info', async () => {
    const f = crit('CVE-1');
    const a = await run(flagged([f]), { acceptance: { findingKeys: [scanFindingKey(f)], kev: false, acceptedUntil: '2026-12-01T00:00:00Z' } });
    expect(a.severity).toBe('info');
    expect(a.acceptedFindings).toEqual([scanFindingKey(f)]);
    expect(a.warnings[0]).toMatchObject({ code: 'VULN_ACCEPTED', covers: 'VULN_FLAGGED', acceptedUntil: '2026-12-01T00:00:00.000Z' });
  });

  it('never covers a finding the acceptance did not freeze', async () => {
    const old = crit('CVE-1');
    const a = await run(flagged([old, crit('CVE-2')]), { acceptance: { findingKeys: [scanFindingKey(old)], kev: false, acceptedUntil: null } });
    expect(a.severity).toBe('error');
  });

  it('covers a KEV finding only when the acceptance said kev: true', async () => {
    const k = crit('CVE-9', { kev: true, fixedIn: [] });
    const record = { ...image, scanSummary: summary([k]) };
    const acceptance = { findingKeys: [scanFindingKey(k)], kev: false, acceptedUntil: null };
    expect((await run(record, { acceptance })).severity).toBe('critical');
    expect((await run(record, { acceptance: { ...acceptance, kev: true } })).severity).toBe('info');
  });

  it('ignores a summary that describes another image', () => {
    const record = { ...image, scanSummary: { criticalFixable: 3, highFixable: 3, kev: 2, findings: [], imageDigest: `sha256:${'b'.repeat(64)}` } };
    expect(versionScanFacts(record as never)).toMatchObject({ criticalFixable: null, kev: 0 });
  });

  it('maps compliance block mode to error and warn mode to warning; an outage is info', async () => {
    const v = { ruleId: 'r', ruleName: 'no crit', field: 'vulnCritical', message: 'too many', operator: 'lte', expectedValue: 0, actualValue: 1, severity: 'error' };
    setVulnPolicyComplianceClientForTests({ dryRunPlugin: async () => ({ violations: [v], warnings: [{ ...v, ruleId: 'w' }] }) } as never);
    const a = await assessVersionVulns({ orgId: 'org-a', record: image as never, policy, now });
    expect(a.warnings.map((w) => [w.code, w.severity])).toEqual([['COMPLIANCE_VULN_RULE', 'error'], ['COMPLIANCE_VULN_RULE', 'warning']]);
    setVulnPolicyComplianceClientForTests({ dryRunPlugin: async () => { throw new Error('down'); } } as never);
    const down = await assessVersionVulns({ orgId: 'org-a', record: image as never, policy, now });
    expect(down.warnings.map((w) => [w.code, w.severity])).toEqual([['COMPLIANCE_UNAVAILABLE', 'info']]);
  });

  it('orders severities', () => {
    expect(maxSeverity('warning', 'critical')).toBe('critical');
    expect(maxSeverity('error', 'info')).toBe('error');
  });
});
