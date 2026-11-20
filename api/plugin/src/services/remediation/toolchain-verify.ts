// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifying a toolchain release CANDIDATE (pure) — stricter than a plugin
 * fix's verifyCandidate, because every org's synth runs on these two images.
 * A candidate pair is recorded only when ALL hold, for BOTH halves:
 *  - its own scan passed the build gate (floor + compliance);
 *  - every targeted finding is gone (no partial fix: a half-fixed toolchain is
 *    not a release);
 *  - no Critical/High appears that the half's original did not have;
 *  - its plugin-spec.yaml is unchanged by the fix, and the fix is reproducible
 *    from the exported spec patch (a rebuild or a source patch — never an
 *    overlay layer or an ask-agent draft);
 *  - the exact tool versions — pipeline-manager, aws-cdk, cdk-assets, node —
 *    are the release's, read from the image LABELs AND the patched bootstrap
 *    Dockerfile ARGs (what the spec's `toolchain` block will say);
 *  - `cdk synth` of the fixture app succeeded in the candidate images.
 */

import {
  toolchainFromImageLabels,
  toolchainVersionChanges,
  type PluginScanFinding,
  type PluginToolchain,
  type RemediationFixMethod,
  type ToolchainFixRefusal,
  type ToolchainVersionChange,
} from '@pipeline-builder/api-core';

import type { ToolchainDir } from './toolchain-spec.js';
import { clearedBy, newFindingsOf, type CandidateScan } from './verify.js';

/** What one half's candidate showed. */
export interface ToolchainHalfEvidence {
  name: ToolchainDir;
  /** The findings this half's candidate must clear. */
  targeted: readonly PluginScanFinding[];
  /** The half's own findings before the fix (the "no new findings" baseline). */
  original: readonly PluginScanFinding[];
  scan: CandidateScan;
  /** The candidate image's config labels (null = unreadable). */
  labels: Readonly<Record<string, string>> | null;
  fixMethods: readonly RemediationFixMethod[];
  spec: { before: string | null; after: string | null };
}

export interface ToolchainVerifyInput {
  halves: readonly ToolchainHalfEvidence[];
  /** The flagged release's toolchain (its bootstrap row's metadata). */
  expected: PluginToolchain;
  /** What the patched bootstrap Dockerfile pins (null = unreadable). */
  dockerfileToolchain: PluginToolchain | null;
  synthSmoke: 'passed' | 'failed';
}

export interface ToolchainVerifyResult {
  ok: boolean;
  refusal: ToolchainFixRefusal | null;
  /** The half the refusal is about (null for a pair-wide check). */
  half: ToolchainDir | null;
  /** TOOL_VERSION_CHANGED: what would have moved. */
  changes: ToolchainVersionChange[];
  /** TARGETED_STILL_PRESENT / NEW_FINDINGS: the findings concerned. */
  findings: PluginScanFinding[];
}

const REPRODUCIBLE: ReadonlySet<RemediationFixMethod> = new Set(['rebuild', 'source_patch']);
const CRIT_HIGH = new Set(['critical', 'high']);

export function verifyToolchainCandidate(input: ToolchainVerifyInput): ToolchainVerifyResult {
  const refuse = (refusal: ToolchainFixRefusal, half: ToolchainDir | null, extra: Partial<Pick<ToolchainVerifyResult, 'changes' | 'findings'>> = {}): ToolchainVerifyResult => ({
    ok: false, refusal, half, changes: extra.changes ?? [], findings: extra.findings ?? [],
  });
  for (const h of input.halves) {
    if (h.scan.refusal) return refuse('GATE_REFUSED', h.name);
    const { stillPresent } = clearedBy(h.targeted, h.scan.findings);
    if (stillPresent.length > 0) return refuse('TARGETED_STILL_PRESENT', h.name, { findings: stillPresent });
    const added = newFindingsOf(h.original, h.scan).filter((f) => CRIT_HIGH.has(f.severity));
    if (added.length > 0) return refuse('NEW_FINDINGS', h.name, { findings: added });
    if (h.spec.before !== h.spec.after) return refuse('SPEC_CHANGED', h.name);
    if (h.fixMethods.some((m) => !REPRODUCIBLE.has(m))) return refuse('FIX_NOT_REPRODUCIBLE', h.name);
    const fromLabels = toolchainVersionChanges(input.expected, toolchainFromImageLabels(h.labels));
    if (fromLabels.length > 0) return refuse('TOOL_VERSION_CHANGED', h.name, { changes: fromLabels });
  }
  const fromArgs = toolchainVersionChanges(input.expected, input.dockerfileToolchain);
  if (fromArgs.length > 0) return refuse('TOOL_VERSION_CHANGED', 'pipeline-bootstrap', { changes: fromArgs });
  if (input.synthSmoke !== 'passed') return refuse('SYNTH_SMOKE_FAILED', 'cdk-synth');
  return { ok: true, refusal: null, half: null, changes: [], findings: [] };
}
