// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly toolchain FIXES, propose-only (docs/plugin-publishing.md
 * "Remediation → toolchains"): when the nightly rescan flags a managed
 * toolchain release (`pipeline-bootstrap` + `cdk-synth`, one version) with
 * targeted findings, the plugin service builds a patched PAIR — the bootstrap
 * through the remediation engine's Stage 1 and Stage 2, cdk-synth FROM that
 * candidate bootstrap — verifies it more strictly than a plugin fix (targeted
 * findings gone, no new Critical/High, the exact tool versions unchanged, a
 * real `cdk synth` of a fixture app), and records a RELEASE CANDIDATE. Nothing
 * is published until a system-org `plugins:write` holder approves it with a
 * step-up; orgs move only through their own toolchain default.
 *
 * Browser-safe (re-exported by the `./plugin-scan` subpath): no zod, no node.
 */

import type { PluginRemediationOutcome, PluginRemediationStage, RemediationClearedFinding, RemediationFixMethod, RemediationRemainingFinding } from './plugin-remediation.js';
import type { PluginToolchain } from '../validation/plugin-spec-schema.js';

// -- the operator knob ------------------------------------------------------------

/** PLUGIN_REMEDIATION_TOOLCHAINS: `propose` builds and records candidates; `off` keeps the owner request. Never `apply`. */
export const REMEDIATION_TOOLCHAIN_MODES = ['propose', 'off'] as const;
export type RemediationToolchainMode = typeof REMEDIATION_TOOLCHAIN_MODES[number];
export const DEFAULT_REMEDIATION_TOOLCHAINS: RemediationToolchainMode = 'propose';

/**
 * PLUGIN_REMEDIATION_TOOLCHAINS: `propose` (default) or `off`, trimmed and
 * case-insensitive. Unset or blank → the default, silently. Anything else —
 * `apply` included: a toolchain release is never published automatically —
 * → the default plus ONE `warn` call naming the value.
 */
export function parseRemediationToolchains(
  raw: string | undefined | null,
  warn: (message: string) => void = (m) => console.warn(m),
): RemediationToolchainMode {
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_REMEDIATION_TOOLCHAINS;
  const v = raw.trim().toLowerCase();
  if ((REMEDIATION_TOOLCHAIN_MODES as readonly string[]).includes(v)) return v as RemediationToolchainMode;
  warn(`PLUGIN_REMEDIATION_TOOLCHAINS=${JSON.stringify(raw)} is not propose or off; using ${DEFAULT_REMEDIATION_TOOLCHAINS}`);
  return DEFAULT_REMEDIATION_TOOLCHAINS;
}

// -- what a toolchain image carries -----------------------------------------------------

/**
 * The image LABEL holding each `toolchain` field — what
 * deploy/toolchain/pipeline-bootstrap/Dockerfile labels from the ARG it
 * installs (cdk-synth, FROM the bootstrap, inherits them).
 */
export const TOOLCHAIN_IMAGE_LABELS: Readonly<Record<keyof PluginToolchain, string>> = {
  pipelineManager: 'org.pipeline-builder.toolchain.pipeline-manager',
  awsCdk: 'org.pipeline-builder.toolchain.aws-cdk',
  cdkAssets: 'org.pipeline-builder.toolchain.cdk-assets',
  node: 'org.pipeline-builder.toolchain.node',
};

const TOOLCHAIN_FIELDS = Object.keys(TOOLCHAIN_IMAGE_LABELS) as Array<keyof PluginToolchain>;
/** The spec schema's exact-semver rule (validation/plugin-spec-schema.ts), without zod. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** The toolchain an image's labels carry, or null when one is missing or not an exact version. */
export function toolchainFromImageLabels(labels: Readonly<Record<string, string>> | null | undefined): PluginToolchain | null {
  if (!labels) return null;
  const out: Partial<PluginToolchain> = {};
  for (const f of TOOLCHAIN_FIELDS) {
    const v = labels[TOOLCHAIN_IMAGE_LABELS[f]];
    if (typeof v !== 'string' || !EXACT_SEMVER.test(v)) return null;
    out[f] = v;
  }
  return out as PluginToolchain;
}

/** One tool whose version a candidate would change. */
export interface ToolchainVersionChange { tool: keyof PluginToolchain; from: string; to: string | null }

/** Every tool whose version differs between `expected` and `actual` (an unreadable `actual` changes them all). */
export function toolchainVersionChanges(expected: PluginToolchain, actual: PluginToolchain | null): ToolchainVersionChange[] {
  return TOOLCHAIN_FIELDS.filter((f) => actual?.[f] !== expected[f]).map((f) => ({ tool: f, from: expected[f], to: actual?.[f] ?? null }));
}

// -- the stored candidate -------------------------------------------------------------

/** `plugin_remediations.kind`: a plugin version's fix, or a toolchain release candidate. */
export const PLUGIN_REMEDIATION_KINDS = ['plugin', 'toolchain'] as const;
export type PluginRemediationKind = typeof PLUGIN_REMEDIATION_KINDS[number];

/** Why a toolchain candidate was refused (the row goes to needs_owner with this as the remaining findings' detail). */
export const TOOLCHAIN_FIX_REFUSALS = [
  /** A release's build inputs were never kept (uploaded before the platform kept them). */
  'TOOLCHAIN_INPUTS_MISSING',
  /** The engine produced no candidate for a half that had targeted findings. */
  'NO_CANDIDATE',
  /** A candidate's own scan was refused by the build gate (floor / compliance). */
  'GATE_REFUSED',
  /** A targeted finding is still present in a candidate. */
  'TARGETED_STILL_PRESENT',
  /** A candidate has a Critical/High the original half did not. */
  'NEW_FINDINGS',
  /** pipeline-manager, aws-cdk, cdk-assets or node differs from the release's (labels or Dockerfile ARGs). */
  'TOOL_VERSION_CHANGED',
  /** The fix is an overlay layer or an ask-agent draft: the exported spec patch could not reproduce it. */
  'FIX_NOT_REPRODUCIBLE',
  /** A half's plugin-spec.yaml was changed by the fix. */
  'SPEC_CHANGED',
  /** `cdk synth` of the fixture app failed in a candidate image. */
  'SYNTH_SMOKE_FAILED',
] as const;
export type ToolchainFixRefusal = typeof TOOLCHAIN_FIX_REFUSALS[number];

/** One half of a candidate release. */
export interface ToolchainFixHalf {
  name: 'pipeline-bootstrap' | 'cdk-synth';
  /** The flagged release's row of this half. */
  fromPluginId: string;
  fromDigest: string | null;
  /** The candidate image (unchanged = the half had nothing targeted and was not rebuilt). */
  digest: string;
  rebuilt: boolean;
  cleared: RemediationClearedFinding[];
  fixMethods: RemediationFixMethod[];
}

/**
 * An APPROVED candidate's publish, step by step — recorded before the first
 * step runs, so a crash anywhere resumes (a repeat approve, or the nightly
 * sweep once `leaseUntil` has passed) and never publishes twice or under
 * another number. Present = publishing has started: reject is refused.
 */
export interface ToolchainFixPublishState {
  approvedBy: string;
  approvedAt: string;
  /** Who holds the publish (ISO time it expires); a resume claims it only once it has passed. */
  leaseUntil: string;
  steps: {
    /** The stored half's plugin id once it exists (reused, never stored again). */
    bootstrap: string | null;
    cdkSynth: string | null;
    /** The release's build inputs were kept. */
    inputs: boolean;
    /** N34 was sent to the orgs on the vulnerable release. */
    notice: boolean;
  };
  /** How many times it was resumed. */
  resumes: number;
}

/** How long one publish attempt holds a candidate before a resume may take it over. */
export const TOOLCHAIN_FIX_PUBLISH_LEASE_MS = 5 * 60_000;

/**
 * `plugin_remediations.toolchain_candidate`: the verified pair and the spec
 * change `deploy/bin/sync-image-tags.sh --toolchain-only` would produce for it.
 */
export interface ToolchainFixCandidate {
  fromRelease: string;
  toRelease: string;
  /** The release's exact tool versions — verified unchanged in both candidates. */
  toolchain: PluginToolchain;
  bootstrap: ToolchainFixHalf;
  cdkSynth: ToolchainFixHalf;
  /** The bootstrap's digest-pinned `ARG NODE_IMAGE`, when the fix refreshed it (same tag, current digest). */
  baseImage: { from: string; to: string } | null;
  sourceDigest: { from: string | null; to: string };
  /** The patched build inputs (top-level text files per half), kept for the release this candidate publishes. */
  buildInputs: { 'pipeline-bootstrap': Record<string, string>; 'cdk-synth': Record<string, string> };
  synthSmoke: 'passed';
  verifiedAt: string;
  /** Set when approved: the publish's progress (resumable). */
  publish?: ToolchainFixPublishState;
  /** How many approve / resume attempts the build gate's re-scan refused; at {@link TOOLCHAIN_FIX_MAX_GATE_REFUSALS} the candidate moves to `needs_review`. */
  gateRefusals?: number;
}

/** Gate refusals of one candidate's publish before it is moved to `needs_review` (counted on `toolchain_fix_failures_total{stage="gate_refused"}`). */
export const TOOLCHAIN_FIX_MAX_GATE_REFUSALS = 3;

// -- wire shapes ---------------------------------------------------------------

/** One toolchain release candidate as `GET /plugins/toolchain-fixes` answers it. */
export interface ToolchainFixDto {
  id: string;
  stage: PluginRemediationStage;
  outcome: PluginRemediationOutcome | null;
  fromRelease: string;
  /** Null until a candidate was verified. */
  toRelease: string | null;
  targetedCount: number;
  cleared: Array<RemediationClearedFinding & { half: 'pipeline-bootstrap' | 'cdk-synth' }>;
  remaining: RemediationRemainingFinding[];
  /** The tool versions the candidate keeps (verified unchanged). */
  toolchain: PluginToolchain | null;
  baseImage: { from: string; to: string } | null;
  sourceDigest: { from: string | null; to: string } | null;
  digests: { 'pipeline-bootstrap': { from: string | null; to: string }; 'cdk-synth': { from: string | null; to: string } } | null;
  /** The spec patch is stored (GET /plugins/toolchain-fixes/:id/export). */
  hasExport: boolean;
  /** Approved and publishing (null before approval): a repeat approve, or the nightly sweep, resumes it. */
  publishing: { approvedBy: string; approvedAt: string; steps: ToolchainFixPublishState['steps'] } | null;
  error: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** `GET /plugins/toolchain-fixes`. */
export interface ToolchainFixList {
  fixes: ToolchainFixDto[];
  /** PLUGIN_REMEDIATION_ENABLED. */
  enabled: boolean;
  /** PLUGIN_REMEDIATION_TOOLCHAINS. */
  mode: RemediationToolchainMode;
}

/** Metric names (labels bounded: outcome ∈ the list below, stage ∈ keep_inputs | publish). */
export const TOOLCHAIN_FIX_METRICS = {
  /** {outcome}: proposed | refused | approved | rejected. */
  candidates: 'toolchain_fix_candidates_total',
  /** {stage}: keep_inputs (a release's build inputs could not be kept) | publish (an approved pair did not fully publish)
   *  | gate_refused (the build gate refused its publish TOOLCHAIN_FIX_MAX_GATE_REFUSALS times; moved to needs_review). Alerted. */
  failures: 'toolchain_fix_failures_total',
  /** {outcome}: resumed | idle | skipped (knobs off) | error — one per tick of the stuck-publish resume scheduler. */
  resumeRuns: 'toolchain_fix_resume_runs_total',
} as const;

/** TOOLCHAIN_FIX_RESUME_INTERVAL_MS: how often the plugin service resumes stuck toolchain publishes (default 2 min, at least 30 s). */
export const TOOLCHAIN_FIX_RESUME_INTERVAL = { name: 'TOOLCHAIN_FIX_RESUME_INTERVAL_MS', default: 120_000, min: 30_000 } as const;
