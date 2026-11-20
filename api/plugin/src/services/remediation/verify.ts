// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifying a remediation build (pure). A candidate is kept only when ALL hold:
 *  - it passed the full build gate (floor + compliance) on its own scan;
 *  - every targeted finding is gone, and no Critical/High appears that the
 *    original version did not have (identity: advisory × package — a patched
 *    package's version moves, so its key would otherwise look new);
 *  - the plugin contract is unchanged (every pipeline that met the old one meets
 *    the new one: the plugin contract check passes), and the image's user,
 *    entrypoint, cmd and working directory are unchanged;
 *  - the spec's smokeTest passed against it (when declared);
 *  - the diff touches only the named packages' lines, or the single overlay layer.
 */

import type { PluginScanFinding, RemediationRemainingReason } from '@pipeline-builder/api-core';

import { changedLines, type FileMap } from './diff.js';
import { isSingleLayerOverlay } from './overlay.js';

/** The image config fields a remediation must not change. */
export interface ImageConfigFacts {
  user: string;
  entrypoint: string[] | null;
  cmd: string[] | null;
  workingDir: string;
}

/** The plugin execution contract (what pipelines depend on). */
export interface PluginContractShape {
  pluginType: string;
  commands: string[];
  installCommands: string[];
  requiredMetadata: string[];
  requiredVars: string[];
  metadataTypes: Record<string, unknown>;
  varsTypes: Record<string, unknown>;
  secrets: unknown[];
  env: Record<string, unknown>;
}

/** What the candidate's own scan and gates said. */
export interface CandidateScan {
  findings: PluginScanFinding[];
  /** scanFindingKey of the findings a waiver exempted (still present, never "new"). */
  waivedKeys: ReadonlySet<string>;
  /** A gate refusal CODE (PLUGIN_VULN_GATE, COMPLIANCE_VIOLATION), or null when it passed. */
  refusal: string | null;
}

export interface VerifyInput {
  targeted: readonly PluginScanFinding[];
  original: readonly PluginScanFinding[];
  scan: CandidateScan;
  contract: { before: PluginContractShape; after: PluginContractShape };
  config: { before: ImageConfigFacts; after: ImageConfigFacts };
  smoke: 'passed' | 'failed' | 'none';
  scope: ScopeResult;
}

export interface VerifyResult {
  ok: boolean;
  cleared: PluginScanFinding[];
  stillPresent: PluginScanFinding[];
  newFindings: PluginScanFinding[];
  /** Why it failed (the remaining reason for what it targeted). */
  failure: RemediationRemainingReason | null;
  /** A short code: the failing check. */
  detail: string | null;
}

const identity = (f: Pick<PluginScanFinding, 'id' | 'packageName'>): string => `${f.id}|${f.packageName.toLowerCase()}`;
const waiverKey = (f: Pick<PluginScanFinding, 'id' | 'packageName' | 'packageVersion'>): string => `${f.id}|${f.packageName}|${f.packageVersion}`;

/** The targeted findings a scan no longer carries. */
export function clearedBy(targeted: readonly PluginScanFinding[], after: readonly PluginScanFinding[]): { cleared: PluginScanFinding[]; stillPresent: PluginScanFinding[] } {
  const present = new Set(after.map(identity));
  return { cleared: targeted.filter((f) => !present.has(identity(f))), stillPresent: targeted.filter((f) => present.has(identity(f))) };
}

/** Critical/High findings in `after` the original did not have (waived ones excluded). */
export function newFindingsOf(original: readonly PluginScanFinding[], scan: Pick<CandidateScan, 'findings' | 'waivedKeys'>): PluginScanFinding[] {
  const before = new Set(original.map(identity));
  return scan.findings.filter((f) => !before.has(identity(f)) && !scan.waivedKeys.has(waiverKey(f)));
}

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : x));

export const contractUnchanged = (a: PluginContractShape, b: PluginContractShape): boolean => canon(a) === canon(b);
export const imageConfigUnchanged = (a: ImageConfigFacts, b: ImageConfigFacts): boolean => canon(a) === canon(b);

export function verifyCandidate(input: VerifyInput): VerifyResult {
  const { cleared, stillPresent } = clearedBy(input.targeted, input.scan.findings);
  const newFindings = newFindingsOf(input.original, input.scan);
  const fail = (failure: RemediationRemainingReason, detail: string): VerifyResult => ({ ok: false, cleared, stillPresent, newFindings, failure, detail });
  if (!input.scope.ok) return fail('patch_out_of_scope', input.scope.detail ?? 'DIFF_SCOPE');
  if (newFindings.length > 0) return fail('new_findings', 'NEW_FINDINGS');
  if (!contractUnchanged(input.contract.before, input.contract.after)) return fail('patch_broke_plugin', 'CONTRACT_CHANGED');
  if (!imageConfigUnchanged(input.config.before, input.config.after)) return fail('patch_broke_plugin', 'IMAGE_CONFIG_CHANGED');
  if (input.smoke === 'failed') return fail('patch_broke_plugin', 'SMOKE_TEST_FAILED');
  if (cleared.length === 0) return fail('still_present', 'NOTHING_CLEARED');
  if (input.scan.refusal) return fail('still_present', input.scan.refusal);
  return { ok: true, cleared, stillPresent, newFindings, failure: null, detail: null };
}

// -- diff scope ---------------------------------------------------------------------

export interface ScopeResult { ok: boolean; detail?: string }

/** Lines a manifest edit may add or remove without naming the package (JSON / XML / Gradle structure). */
const STRUCTURAL: readonly RegExp[] = [
  /^\s*$/,
  /^\s*[{}[\](),;]*\s*$/,
  /^\s*"overrides"\s*:\s*\{\s*\}?,?\s*$/,
  /^\s*<\/?(?:dependencyManagement|dependencies|dependency)>\s*$/,
  /^\s*constraints\s*\{\s*$/,
];

const stripComma = (l: string): string => l.replace(/,\s*$/, '');

/**
 * Whether a patched tree touches only the named packages' lines. `mentions`
 * are the strings a changed line may contain to count as the package's
 * (names, purl segments, versions). Regenerated lockfiles are exempt; an
 * overlay context must be exactly one overlay layer.
 */
export function scopeCheck(input: {
  before: FileMap;
  after: FileMap;
  mentions: readonly string[];
  lockfiles: readonly string[];
  overlayDockerfile?: string | null;
}): ScopeResult {
  if (input.overlayDockerfile != null && !isSingleLayerOverlay(input.overlayDockerfile)) return { ok: false, detail: 'OVERLAY_NOT_SINGLE_LAYER' };
  const needles = input.mentions.map((m) => m.toLowerCase()).filter((m) => m.length >= 2);
  const lock = new Set(input.lockfiles);
  for (const path of new Set([...input.before.keys(), ...input.after.keys()])) {
    if (lock.has(path)) continue;
    const a = input.before.get(path) ?? null;
    const b = input.after.get(path) ?? null;
    if (a === b) continue;
    if (a === null || b === null) return { ok: false, detail: 'FILE_ADDED_OR_REMOVED' };
    const { removed, added } = changedLines(a, b);
    // A trailing comma moved by a JSON edit is structure, not content.
    const addedSet = new Set(added.map(stripComma));
    const removedSet = new Set(removed.map(stripComma));
    const lines = [...removed.filter((l) => !addedSet.has(stripComma(l))), ...added.filter((l) => !removedSet.has(stripComma(l)))];
    for (const line of lines) {
      if (STRUCTURAL.some((re) => re.test(line))) continue;
      const lower = line.toLowerCase();
      if (!needles.some((n) => lower.includes(n))) return { ok: false, detail: 'LINE_OUTSIDE_PACKAGES' };
    }
  }
  return { ok: true };
}
