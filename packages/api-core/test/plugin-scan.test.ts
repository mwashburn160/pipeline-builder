// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, it, expect } from '@jest/globals';

import {
  asScanFlag, describeFindings, exceedsVulnFloor, gatedFixableCount, isGatedFinding, pluginVulnFailOn, pluginVulnMaxFindings,
  vulnFlaggedMessage, vulnFlaggedWarning, type PluginScanFlag,
} from '../src/types/plugin-scan.js';

const finding = (id: string, fixedIn: string[] = ['1.0.1']) =>
  ({ id, severity: 'critical' as const, packageName: 'openssl', packageVersion: '1.0.0', fixedIn });

const flag: PluginScanFlag = { gated: 2, high: 1, maxFindings: 0, findings: [finding('CVE-1'), finding('CVE-2', ['1.0.2', '2.0.0'])] };

afterEach(() => {
  delete process.env.PLUGIN_VULN_MAX_FINDINGS;
  delete process.env.PLUGIN_VULN_FAIL_ON;
});

describe('PLUGIN_VULN_FAIL_ON', () => {
  const high = (fixedIn: string[], kev?: boolean) =>
    ({ severity: 'high' as const, fixedIn, ...(kev ? { kev } : {}) });

  it('defaults to critical: a fixable High is not gated, a fixable Critical is', () => {
    expect(pluginVulnFailOn()).toBe('critical');
    expect(isGatedFinding(high(['1.0.1']))).toBe(false);
    expect(isGatedFinding(finding('CVE-1'))).toBe(true);
    expect(gatedFixableCount({ vulnCriticalFixable: 2, vulnHighFixable: 5 })).toBe(2);
  });

  it('high gates fixable and KEV-listed Highs too, never an unfixable non-KEV one', () => {
    process.env.PLUGIN_VULN_FAIL_ON = 'HIGH';
    expect(pluginVulnFailOn()).toBe('high');
    expect(isGatedFinding(high(['1.0.1']))).toBe(true);
    expect(isGatedFinding(high([], true))).toBe(true);
    expect(isGatedFinding(high([]))).toBe(false);
    expect(gatedFixableCount({ vulnCriticalFixable: 2, vulnHighFixable: 5 })).toBe(7);
    expect(gatedFixableCount({ vulnCriticalFixable: null, vulnHighFixable: null })).toBe(0);
  });

  it('an unrecognised value resolves to the STRICTER high, and blank to the default', () => {
    for (const v of ['medium', 'crit', 'low']) {
      process.env.PLUGIN_VULN_FAIL_ON = v;
      expect(pluginVulnFailOn()).toBe('high');
    }
    process.env.PLUGIN_VULN_FAIL_ON = '  ';
    expect(pluginVulnFailOn()).toBe('critical');
  });

  it('a flag carries a high threshold through asScanFlag and into its message', () => {
    const highFlag = asScanFlag({ ...flag, failOn: 'high' });
    expect(highFlag?.failOn).toBe('high');
    expect(vulnFlaggedMessage('x@1', highFlag!)).toContain('2 fixable Critical or High findings');
    expect(asScanFlag({ ...flag, failOn: 'bogus' })?.failOn).toBeUndefined();
    expect(vulnFlaggedMessage('x@1', flag)).toContain('2 fixable Critical findings');
  });
});

describe('plugin scan gates vocabulary', () => {
  it('PLUGIN_VULN_MAX_FINDINGS defaults to 0 and -1 disables the floor', () => {
    expect(pluginVulnMaxFindings()).toBe(0);
    expect(exceedsVulnFloor(1)).toBe(true);
    expect(exceedsVulnFloor(0)).toBe(false);
    expect(exceedsVulnFloor(null)).toBe(false);
    process.env.PLUGIN_VULN_MAX_FINDINGS = '-1';
    expect(exceedsVulnFloor(99)).toBe(false);
    process.env.PLUGIN_VULN_MAX_FINDINGS = '-7';
    expect(pluginVulnMaxFindings()).toBe(-1);
    process.env.PLUGIN_VULN_MAX_FINDINGS = '3';
    expect(exceedsVulnFloor(3)).toBe(false);
    expect(exceedsVulnFloor(4)).toBe(true);
  });

  it('describes fixes and the (severity-graded, never refusing) flag warning', () => {
    expect(describeFindings([finding('CVE-9', [])])).toBe('CVE-9 (openssl@1.0.0 (no fix))');
    expect(describeFindings(flag.findings, 1)).toBe('CVE-1 (openssl@1.0.0 → 1.0.1); +1 more');
    expect(vulnFlaggedMessage('trivy@1.0.0', { gated: 1 })).toBe('trivy@1.0.0 has 1 fixable Critical finding — rebuild or upgrade');
    expect(vulnFlaggedWarning('trivy', '1.0.0', flag)).toEqual({
      code: 'VULN_FLAGGED',
      severity: 'error',
      plugin: 'trivy',
      version: '1.0.0',
      gated: 2,
      high: 1,
      message: 'trivy@1.0.0 has 2 fixable Critical findings — rebuild or upgrade',
      findings: flag.findings,
    });
    expect(vulnFlaggedWarning('trivy', '1.0.0', { ...flag, kev: 1 }).severity).toBe('critical');
  });

  it('narrows a stored flag', () => {
    expect(asScanFlag(null)).toBeNull();
    expect(asScanFlag([])).toBeNull();
    expect(asScanFlag({ critical: 'x', high: 1 })).toBeNull();
    expect(asScanFlag({ gated: 1, high: 0, findings: [{ id: 'CVE-1' }, null] }))
      .toEqual({ gated: 1, high: 0, maxFindings: 0, findings: [{ id: 'CVE-1', fixedIn: [] }] });
  });
});
