// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The toolchain candidate's strict verification (pure). */

import { describe, expect, it } from '@jest/globals';
import { TOOLCHAIN_IMAGE_LABELS } from '@pipeline-builder/api-core';

const { verifyToolchainCandidate } = await import('../src/services/remediation/toolchain-verify.js');

const TC = { pipelineManager: '6.3.1', awsCdk: '2.1148.1', cdkAssets: '4.8.0', node: '26.13.1' };
const LABELS = Object.fromEntries(Object.entries(TOOLCHAIN_IMAGE_LABELS).map(([k, l]) => [l, TC[k as keyof typeof TC]]));
const f = (over: Record<string, unknown> = {}): any => ({ id: 'CVE-1', severity: 'critical', packageName: 'perl', packageVersion: '1', fixedIn: ['2'], packageType: 'deb', purl: 'pkg:deb/perl@1', locations: [], ...over });
const half = (over: Record<string, unknown> = {}): any => ({
  name: 'pipeline-bootstrap',
  targeted: [f()],
  original: [f()],
  scan: { findings: [], waivedKeys: new Set(), refusal: null },
  labels: LABELS,
  fixMethods: ['rebuild'],
  spec: { before: 'a', after: 'a' },
  ...over,
});
const input = (over: Record<string, unknown> = {}): any => ({ halves: [half(), half({ name: 'cdk-synth' })], expected: TC, dockerfileToolchain: TC, synthSmoke: 'passed', ...over });

describe('verifyToolchainCandidate', () => {
  it('passes a clean, reproducible pair with unchanged tools and a passing synth', () => {
    expect(verifyToolchainCandidate(input())).toMatchObject({ ok: true, refusal: null });
  });

  it.each([
    ['GATE_REFUSED', { halves: [half({ scan: { findings: [], waivedKeys: new Set(), refusal: 'PLUGIN_VULN_GATE' } })] }],
    ['TARGETED_STILL_PRESENT', { halves: [half({ scan: { findings: [f()], waivedKeys: new Set(), refusal: null } })] }],
    ['NEW_FINDINGS', { halves: [half({ scan: { findings: [f({ id: 'CVE-NEW', severity: 'high' })], waivedKeys: new Set(), refusal: null } })] }],
    ['SPEC_CHANGED', { halves: [half({ spec: { before: 'a', after: 'b' } })] }],
    ['FIX_NOT_REPRODUCIBLE', { halves: [half({ fixMethods: ['rebuild', 'overlay'] })] }],
    ['FIX_NOT_REPRODUCIBLE', { halves: [half({ fixMethods: ['ask_agent'] })] }],
    ['TOOL_VERSION_CHANGED', { halves: [half({ labels: { ...LABELS, [TOOLCHAIN_IMAGE_LABELS.pipelineManager]: '6.3.2' } })] }],
    ['TOOL_VERSION_CHANGED', { halves: [half({ labels: null })] }],
    ['TOOL_VERSION_CHANGED', { dockerfileToolchain: { ...TC, node: '26.14.0' } }],
    ['SYNTH_SMOKE_FAILED', { synthSmoke: 'failed' }],
  ])('refuses %s', (refusal, over) => {
    expect(verifyToolchainCandidate(input(over))).toMatchObject({ ok: false, refusal });
  });

  it('names what would move', () => {
    const r = verifyToolchainCandidate(input({ dockerfileToolchain: { ...TC, awsCdk: '2.1150.0' } }));
    expect(r.changes).toEqual([{ tool: 'awsCdk', from: '2.1148.1', to: '2.1150.0' }]);
  });

  it('a new Medium is not a new Critical/High; a waived one never counts', () => {
    expect(verifyToolchainCandidate(input({ halves: [half({ scan: { findings: [f({ id: 'CVE-M', severity: 'medium' })], waivedKeys: new Set(), refusal: null } })] })).ok).toBe(true);
    expect(verifyToolchainCandidate(input({ halves: [half({ scan: { findings: [f({ id: 'CVE-W', packageVersion: '3' })], waivedKeys: new Set(['CVE-W|perl|3']), refusal: null } })] })).ok).toBe(true);
  });
});
