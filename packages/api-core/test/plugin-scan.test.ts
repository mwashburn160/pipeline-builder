// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, it, expect } from '@jest/globals';

import {
  asScanFlag, blockOnNewCritical, describeFindings, exceedsVulnFloor, pluginVulnMaxCritical,
  vulnBlockedMessage, vulnFlaggedMessage, vulnFlaggedWarning, type PluginScanFlag,
} from '../src/types/plugin-scan.js';

const finding = (id: string, fixedIn: string[] = ['1.0.1']) =>
  ({ id, severity: 'critical' as const, packageName: 'openssl', packageVersion: '1.0.0', fixedIn });

const flag: PluginScanFlag = { critical: 2, high: 1, maxCritical: 0, findings: [finding('CVE-1'), finding('CVE-2', ['1.0.2', '2.0.0'])] };

afterEach(() => {
  delete process.env.PLUGIN_VULN_MAX_CRITICAL;
  delete process.env.PLUGIN_BLOCK_ON_NEW_CRITICAL;
});

describe('plugin scan gates vocabulary', () => {
  it('PLUGIN_VULN_MAX_CRITICAL defaults to 0 and -1 disables the floor', () => {
    expect(pluginVulnMaxCritical()).toBe(0);
    expect(exceedsVulnFloor(1)).toBe(true);
    expect(exceedsVulnFloor(0)).toBe(false);
    expect(exceedsVulnFloor(null)).toBe(false);
    process.env.PLUGIN_VULN_MAX_CRITICAL = '-1';
    expect(exceedsVulnFloor(99)).toBe(false);
    process.env.PLUGIN_VULN_MAX_CRITICAL = '-7';
    expect(pluginVulnMaxCritical()).toBe(-1);
    process.env.PLUGIN_VULN_MAX_CRITICAL = '3';
    expect(exceedsVulnFloor(3)).toBe(false);
    expect(exceedsVulnFloor(4)).toBe(true);
  });

  it('PLUGIN_BLOCK_ON_NEW_CRITICAL defaults off', () => {
    expect(blockOnNewCritical()).toBe(false);
    process.env.PLUGIN_BLOCK_ON_NEW_CRITICAL = 'true';
    expect(blockOnNewCritical()).toBe(true);
  });

  it('describes fixes, the warning and the block', () => {
    expect(describeFindings([finding('CVE-9', [])])).toBe('CVE-9 (openssl@1.0.0 (no fix))');
    expect(describeFindings(flag.findings, 1)).toBe('CVE-1 (openssl@1.0.0 → 1.0.1); +1 more');
    expect(vulnFlaggedMessage('trivy@1.0.0', { critical: 1 })).toBe('trivy@1.0.0 has 1 fixable Critical finding — rebuild or upgrade');
    expect(vulnFlaggedWarning('trivy', '1.0.0', flag)).toEqual({
      code: 'VULN_FLAGGED',
      plugin: 'trivy',
      version: '1.0.0',
      critical: 2,
      high: 1,
      message: 'trivy@1.0.0 has 2 fixable Critical findings — rebuild or upgrade',
      findings: flag.findings,
    });
    const blocked = vulnBlockedMessage('trivy', '1.0.0', flag);
    expect(blocked).toContain('trivy@1.0.0 is blocked');
    expect(blocked).toContain('CVE-2 (openssl@1.0.0 → 1.0.2, 2.0.0)');
  });

  it('narrows a stored flag', () => {
    expect(asScanFlag(null)).toBeNull();
    expect(asScanFlag([])).toBeNull();
    expect(asScanFlag({ critical: 'x', high: 1 })).toBeNull();
    expect(asScanFlag({ critical: 1, high: 0, findings: [{ id: 'CVE-1' }, null] }))
      .toEqual({ critical: 1, high: 0, maxCritical: 0, findings: [{ id: 'CVE-1', fixedIn: [] }] });
  });
});
