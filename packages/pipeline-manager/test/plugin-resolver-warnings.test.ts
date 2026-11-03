// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The lookup's `warnings[]` reach the CLI user, graded by severity: a
 * `VULN_FLAGGED` warning (the nightly rescan found fixable Critical findings in
 * the resolved version) is printed during synth / create / deploy, collected
 * for the end-of-run summary, and never fails the synth.
 */

import { jest, describe, it, expect } from '@jest/globals';

const mockPrintWarning = jest.fn();
const actualOutput = await import('../src/utils/output-utils.js');
jest.unstable_mockModule('../src/utils/output-utils.js', () => ({ ...actualOutput, printWarning: mockPrintWarning }));

const { printLookupWarningSummary, resolvePluginsForProps } = await import('../src/utils/plugin-resolver.js');

describe('resolvePluginsForProps — lookup warnings', () => {
  it('prints a VULN_FLAGGED warning with the plugin label', async () => {
    const warning = {
      code: 'VULN_FLAGGED',
      plugin: 'trivy',
      version: '1.1.0',
      gated: 2,
      high: 0,
      message: 'trivy@1.1.0 has 2 fixable Critical findings — rebuild or upgrade',
      findings: [],
    };
    const client = { post: async () => ({ data: { plugin: { name: 'trivy', version: '1.1.0' }, warnings: [{ ...warning, severity: 'critical' }] } }) };
    const sink: unknown[] = [];
    const resolved = await resolvePluginsForProps(client as never, { stages: [{ steps: [{ plugin: { name: 'trivy' } }] }] }, sink as never);
    expect(resolved['trivy-alias']).toMatchObject({ name: 'trivy' });
    const line = String(mockPrintWarning.mock.calls.at(-1)![0]).replace(/\x1b\[[0-9;]*m/g, '');
    expect(line).toBe('[CRITICAL] Plugin "trivy": trivy@1.1.0 has 2 fixable Critical findings — rebuild or upgrade');
    expect(sink).toEqual([{ code: 'VULN_FLAGGED', message: warning.message, severity: 'critical' }]);
  });

  it('prints a one-line severity summary', () => {
    mockPrintWarning.mockClear();
    printLookupWarningSummary([
      { message: 'a', severity: 'critical' }, { message: 'b', severity: 'error' }, { message: 'c', severity: 'error' },
    ]);
    expect(String(mockPrintWarning.mock.calls[0]![0]).replace(/\x1b\[[0-9;]*m/g, '')).toBe('3 plugin warnings: 1 critical, 2 error');
    mockPrintWarning.mockClear();
    printLookupWarningSummary([]);
    expect(mockPrintWarning).not.toHaveBeenCalled();
  });
});
