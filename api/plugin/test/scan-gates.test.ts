// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, it, expect } from '@jest/globals';

import { scanFlagFor, vulnGateError } from '../src/helpers/scan-gates.js';

const f = (id: string, severity: 'critical' | 'high', fixedIn: string[] = ['1.0.1']) =>
  ({ id, severity, packageName: 'openssl', packageVersion: '1.0.0', fixedIn });

afterEach(() => {
  delete process.env.PLUGIN_VULN_FAIL_ON;
});

describe('scan gates — PLUGIN_VULN_FAIL_ON', () => {
  const highsOnly = { vulnCriticalFixable: 0, vulnHighFixable: 2, findings: [f('CVE-H1', 'high'), f('CVE-H2', 'high')] };

  it('default critical: fixable Highs alone pass the floor and raise no flag', () => {
    expect(vulnGateError(highsOnly)).toBeNull();
    expect(scanFlagFor(highsOnly)).toBeNull();
  });

  it('high: fixable Highs break the floor, and the flag records the threshold', () => {
    process.env.PLUGIN_VULN_FAIL_ON = 'high';
    const err = vulnGateError(highsOnly);
    expect(err?.message).toContain('2 fixable Critical or High findings (at most 0 allowed)');
    expect(scanFlagFor(highsOnly)).toMatchObject({ gated: 2, failOn: 'high' });
  });

  it('a counts-only scan (no findings) uses the fixable count at the threshold', () => {
    const countsOnly = { vulnCriticalFixable: 0, vulnHighFixable: 3, findings: [] };
    expect(vulnGateError(countsOnly)).toBeNull();
    process.env.PLUGIN_VULN_FAIL_ON = 'high';
    expect(scanFlagFor(countsOnly)).toMatchObject({ gated: 3, failOn: 'high' });
  });

  it('the default flag omits failOn, so stored flags stay unchanged', () => {
    const crit = { vulnCriticalFixable: 1, vulnHighFixable: 0, findings: [f('CVE-C1', 'critical')] };
    const flag = scanFlagFor(crit);
    expect(flag).toMatchObject({ gated: 1 });
    expect(flag).not.toHaveProperty('failOn');
  });
});
