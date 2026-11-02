// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/waiver-report: what `PLUGIN_VULN_WAIVERS` parsed to, as
 * metrics. The expiry gauge is ONE SERIES PER ENTRY and the series set is reset
 * before every report — the two properties whose absence let an entry expiring
 * next week hide behind one expiring next year, and let a deleted entry alert
 * forever on its last value.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSetGauge = jest.fn();
const mockResetGauge = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { setGauge: mockSetGauge, resetGauge: mockResetGauge }));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { reportVulnWaivers } = await import('../src/helpers/waiver-report.js');

const days = () => mockSetGauge.mock.calls.filter((c) => c[0] === 'plugin_vuln_waiver_days_remaining').map((c) => c[1]);

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { delete process.env.PLUGIN_VULN_WAIVERS; });

describe('reportVulnWaivers', () => {
  it('publishes one expiry series per ENTRY — pinned entries and every fleet-wide one stay apart', () => {
    process.env.PLUGIN_VULN_WAIVERS = 'artillery@1.0.0:2099-01-01:chromium;artillery@2.0.0:2099-06-01:chromium;'
      + '*:2099-01-01:GO-2026-6612;*:2099-02-01:CVE-2026-115557';
    reportVulnWaivers();
    expect(days()).toEqual([
      { plugin: 'artillery@1.0.0', targets: 'chromium' },
      { plugin: 'artillery@2.0.0', targets: 'chromium' },
      { plugin: '*', targets: 'GO-2026-6612' },
      { plugin: '*', targets: 'CVE-2026-115557' },
    ]);
  });

  it('REGRESSION: resets the series set BEFORE re-publishing, so a deleted entry stops reporting', () => {
    process.env.PLUGIN_VULN_WAIVERS = 'artillery:2099-01-01:chromium';
    reportVulnWaivers();
    process.env.PLUGIN_VULN_WAIVERS = '';
    reportVulnWaivers();
    expect(mockResetGauge).toHaveBeenCalledTimes(2);
    expect(mockResetGauge).toHaveBeenLastCalledWith('plugin_vuln_waiver_days_remaining');
    expect(days()).toHaveLength(1); // only the first report set anything
    const firstSet = mockSetGauge.mock.invocationCallOrder[mockSetGauge.mock.calls.findIndex((c) => c[0] === 'plugin_vuln_waiver_days_remaining')]!;
    expect(mockResetGauge.mock.invocationCallOrder[0]!).toBeLessThan(firstSet);
  });

  it('counts the entries it had to drop', () => {
    process.env.PLUGIN_VULN_WAIVERS = '*:2099-01-01:stdlib;artillery:soon:chromium';
    reportVulnWaivers();
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_waivers_invalid', {}, 2);
    expect(days()).toEqual([]);
  });
});
