// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The lookup's `warnings[]` reach the CLI user: a `VULN_FLAGGED` warning (the
 * nightly rescan found fixable Critical findings in the resolved version) is
 * printed during synth / create / deploy, like every other lookup warning.
 */

import { jest, describe, it, expect } from '@jest/globals';

const mockPrintWarning = jest.fn();
const actualOutput = await import('../src/utils/output-utils.js');
jest.unstable_mockModule('../src/utils/output-utils.js', () => ({ ...actualOutput, printWarning: mockPrintWarning }));

const { resolvePluginsForProps } = await import('../src/utils/plugin-resolver.js');

describe('resolvePluginsForProps — lookup warnings', () => {
  it('prints a VULN_FLAGGED warning with the plugin label', async () => {
    const warning = {
      code: 'VULN_FLAGGED',
      plugin: 'trivy',
      version: '1.1.0',
      critical: 2,
      high: 0,
      message: 'trivy@1.1.0 has 2 fixable Critical findings — rebuild or upgrade',
      findings: [],
    };
    const client = { post: async () => ({ data: { plugin: { name: 'trivy', version: '1.1.0' }, warnings: [warning] } }) };
    const resolved = await resolvePluginsForProps(client as never, { stages: [{ steps: [{ plugin: { name: 'trivy' } }] }] });
    expect(resolved['trivy-alias']).toMatchObject({ name: 'trivy' });
    expect(mockPrintWarning).toHaveBeenCalledWith('Plugin "trivy": trivy@1.1.0 has 2 fixable Critical findings — rebuild or upgrade');
  });
});
