// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `gatedFindingCount` — the gated count a STORED scan summary implies.
 *
 * It exists because the two halves of the system disagreed about what "gated"
 * means. The build floor derives its count from the findings, with waivers and
 * KEV applied; the PUBLISH gate read the scanner's fixable columns, which are
 * documented as knowing nothing about either. So a Critical the operator had
 * waived stopped blocking the build and went on blocking the listing, and a
 * KEV-listed UNFIXABLE Critical did the reverse.
 *
 * The two risks here point in opposite directions, and both are silent:
 *   - too STRICT: a waived finding keeps a plugin out of the public directory
 *     and the refusal is only visible to whoever reads the build log;
 *   - too LOOSE: a stale, truncated or wrong-image summary lets something
 *     unvetted be listed. That is why an untrustworthy summary returns `null`
 *     and the caller falls back to the raw columns rather than guessing.
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import { SYSTEM_ORG_ID } from '../src/middleware/system-org.js';
import { gatedFindingCount, type PluginScanFinding, type PluginScanSummary } from '../src/types/plugin-scan.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-11-09T12:00:00Z');
const FUTURE = '2099-01-01';
const PAST = '2020-01-01';

const crit = (id: string, extra: Partial<PluginScanFinding> = {}): PluginScanFinding =>
  ({ id, severity: 'critical', packageName: 'python3.14', packageVersion: '3.14.8', fixedIn: ['3.14.9'], ...extra });

const summary = (findings: PluginScanFinding[], extra: Partial<PluginScanSummary> = {}): PluginScanSummary => ({
  criticalFixable: findings.filter((f) => f.severity === 'critical' && f.fixedIn.length > 0).length,
  highFixable: 0,
  critical: findings.filter((f) => f.severity === 'critical').length,
  high: 0,
  medium: 0,
  low: 0,
  kev: findings.filter((f) => f.kev).length,
  findings,
  truncated: false,
  waived: [],
  scannedAt: '2026-11-09T00:00:00Z',
  trigger: 'rescan',
  imageDigest: DIGEST,
  dbBuiltAt: null,
  uncataloguedBinaries: [],
  ...extra,
});

/** The subject a listing gate would pass: a system-org plugin on this image. */
const SUBJECT = { pluginName: 'aws-cli', orgId: SYSTEM_ORG_ID, pluginVersion: '1.0.0', imageDigest: DIGEST };

afterEach(() => { delete process.env.PLUGIN_VULN_WAIVERS; delete process.env.PLUGIN_VULN_GATE_KEV; });

describe('gatedFindingCount — waivers are honoured here as they are at build', () => {
  it('counts an unwaived fixable Critical', () => {
    expect(gatedFindingCount(summary([crit('CVE-1')]), SUBJECT, 'critical', NOW)).toBe(1);
  });

  it('does NOT count a waived one — the defect this closes', () => {
    process.env.PLUGIN_VULN_WAIVERS = `aws-cli:${FUTURE}:python3.14`;
    expect(gatedFindingCount(summary([crit('CVE-1')]), SUBJECT, 'critical', NOW)).toBe(0);
  });

  it('RE-EVALUATES expiry instead of replaying the stored decision', () => {
    // The summary says this finding WAS waived at scan time. Replaying
    // `summary.waived` — the cheaper fix — would honour that forever, so an
    // expiry would stop blocking builds and never start blocking listings
    // again. The waiver below is expired, so it must block now.
    process.env.PLUGIN_VULN_WAIVERS = `aws-cli:${PAST}:python3.14`;
    const stored = summary([crit('CVE-1')], { waived: ['python3.14@3.14.8:CVE-1'] });
    expect(gatedFindingCount(stored, SUBJECT, 'critical', NOW)).toBe(1);
  });

  it('refuses a waiver to a non-system org, however the plugin is named', () => {
    // Plugin names are unique per (name, version, orgId), so a tenant can call
    // its plugin `aws-cli` and must not inherit the operator's exemption.
    process.env.PLUGIN_VULN_WAIVERS = `aws-cli:${FUTURE}:python3.14`;
    expect(gatedFindingCount(summary([crit('CVE-1')]), { ...SUBJECT, orgId: 'tenant-org' }, 'critical', NOW)).toBe(1);
  });

  it('counts a KEV-listed UNFIXABLE Critical, which the raw columns cannot see', () => {
    // The asymmetry in the other direction: `vulnCriticalFixable` counts only
    // fixable findings, so this one blocked the BUILD and was invisible to the
    // listing gate.
    const kev = crit('CVE-KEV', { fixedIn: [], kev: true });
    expect(gatedFindingCount(summary([kev]), SUBJECT, 'critical', NOW)).toBe(1);
  });

  it('gates Highs only when PLUGIN_VULN_FAIL_ON says so', () => {
    const high: PluginScanFinding = { id: 'CVE-H', severity: 'high', packageName: 'zlib', packageVersion: '1.2', fixedIn: ['1.3'] };
    expect(gatedFindingCount(summary([high]), SUBJECT, 'critical', NOW)).toBe(0);
    expect(gatedFindingCount(summary([high]), SUBJECT, 'high', NOW)).toBe(1);
  });
});

describe('gatedFindingCount — fails CLOSED when the summary cannot answer', () => {
  it('returns null with no summary at all', () => {
    expect(gatedFindingCount(null, SUBJECT, 'critical', NOW)).toBeNull();
    expect(gatedFindingCount(undefined, SUBJECT, 'critical', NOW)).toBeNull();
  });

  it('returns null when the findings were TRUNCATED', () => {
    // Capped at SCAN_SUMMARY_MAX_FINDINGS: what is missing cannot be counted,
    // so a derived figure would undercount by an unknown amount.
    expect(gatedFindingCount(summary([crit('CVE-1')], { truncated: true }), SUBJECT, 'critical', NOW)).toBeNull();
  });

  it('returns null when the summary describes a DIFFERENT image', () => {
    // A version rebuilt on a patched base is a different artifact.
    const other = summary([crit('CVE-1')], { imageDigest: `sha256:${'b'.repeat(64)}` });
    expect(gatedFindingCount(other, SUBJECT, 'critical', NOW)).toBeNull();
  });

  it('returns null when either digest is unknown — two unknowns prove nothing', () => {
    expect(gatedFindingCount(summary([crit('CVE-1')], { imageDigest: '' }), SUBJECT, 'critical', NOW)).toBeNull();
    expect(gatedFindingCount(summary([crit('CVE-1')]), { ...SUBJECT, imageDigest: null }, 'critical', NOW)).toBeNull();
  });

  it('returns 0, not null, for a clean summary — absence of findings is an ANSWER', () => {
    // The distinction the fallback depends on: "nothing gated" must not be
    // confused with "cannot tell", or every clean plugin would take the
    // stricter path for no reason.
    expect(gatedFindingCount(summary([]), SUBJECT, 'critical', NOW)).toBe(0);
  });
});
