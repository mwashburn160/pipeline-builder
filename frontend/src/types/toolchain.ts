// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed pipeline toolchain as an org sees it: its effective release, its
 * own default, and the releases it may choose (docs/plans/
 * bootstrap-image-versioning.md §5, §11). Served by the plugin service under
 * `/api/plugins/toolchain/*`.
 */

/** Why a pipeline (or the org) lands on its effective release, most specific
 *  first, and where a release sits in its lifecycle (yanked and deprecated
 *  releases can't be newly chosen) — api-core's vocabularies, the ones the
 *  plugin service resolves and reports with. */
import type { ToolchainReleaseStatus, ToolchainResolvedVia } from '@pipeline-builder/api-core/plugin-catalog';

export type { ToolchainReleaseStatus, ToolchainResolvedVia };

/** Where a release sits relative to the caller's effective default. */
export type ToolchainReleaseRelation = 'newer' | 'older' | 'current';

/** One org default as stored (and as each history row records it). */
export interface ToolchainOrgDefault {
  releaseVersion: string;
  setBy: string;
  setAt: string;
  reason: string | null;
}

/** `GET /plugins/toolchain/org-default` (`pipelines:read`). */
export interface ToolchainOrgDefaultView {
  effective: { releaseVersion: string | null; resolvedVia: ToolchainResolvedVia };
  /** This org's OWN default; null when it follows the platform default (or inherits). */
  orgDefault: ToolchainOrgDefault | null;
  /** A team without its own default: the root org whose default applies. */
  inheritedFrom: string | null;
  canary: { member: boolean; releaseVersion: string | null; effective: boolean };
  platformDefault: string | null;
  counts: { pipelines: number; pinned: number; behind: number };
}

/** One history row, newest first; `releaseVersion: null` = "followed the platform default". */
export interface ToolchainOrgDefaultHistoryEntry {
  releaseVersion: string | null;
  setBy: string;
  setAt: string;
  reason: string | null;
}

/** The component versions a release ships. */
export interface ToolchainVersions {
  pipelineManager: string;
  awsCdk: string;
  cdkAssets: string;
  esbuild: string;
  pnpm: string;
  node: string;
}

/** A release's scan summary (fixable findings only, plus known-exploited). */
export interface ToolchainScanSummary {
  scannedAt: string | null;
  criticalFixable: number;
  highFixable: number;
  kev: number;
}

/** One entry of `GET /plugins/toolchain/eligible`. */
export interface ToolchainRelease {
  releaseVersion: string;
  status: ToolchainReleaseStatus;
  relation: ToolchainReleaseRelation;
  toolchain: ToolchainVersions;
  releaseNotes: string | null;
  scan: ToolchainScanSummary | null;
}

/** `GET /plugins/toolchain/eligible`. */
export interface ToolchainEligibleView {
  platformDefault: string | null;
  releases: ToolchainRelease[];
}

/** A server warning on a write: a plain sentence, or a coded one. */
export type ToolchainWarning = string | { code?: string; message: string };

// ---------------------------------------------------------------------------
// System org: the Toolchain console (`toolchain:operate`; §6, §8, §9, §11).

/** One half of a release (`pipeline-bootstrap` or `cdk-synth`) as the console lists it. */
export interface ToolchainReleaseHalf {
  digest: string | null;
  scan: ToolchainScanSummary | null;
}

/** One row of `GET /plugins/toolchain/releases`. */
export interface ToolchainConsoleRelease {
  releaseVersion: string;
  status: ToolchainReleaseStatus;
  /** Both halves exist under this version. */
  complete: boolean;
  createdAt: string;
  releaseNotes: string | null;
  /** From the bootstrap half's metadata; null when it carries none. */
  toolchain: ToolchainVersions | null;
  halves: { bootstrap: ToolchainReleaseHalf | null; synth: ToolchainReleaseHalf | null };
  canaryOrgCount: number;
}

/** `GET /plugins/toolchain/releases`. */
export interface ToolchainReleasesView {
  platformDefault: string | null;
  releases: ToolchainConsoleRelease[];
}

/** `GET /plugins/toolchain/releases/:v/adoption`. */
export interface ToolchainAdoptionView {
  releaseVersion: string;
  byResolvedVia: Record<ToolchainResolvedVia, number>;
  orgs: Array<{ orgId: string; orgName: string; pipelines: number; pinned: number; orgDefault: boolean }>;
}

/** One canary member. An org with its own default is unaffected by the canary. */
export interface ToolchainCanaryMember {
  orgId: string;
  orgName: string;
  hasOrgDefault: boolean;
}

/** `PUT /plugins/toolchain/releases/:v/rollout`. One canary per org: an added org in another release's canary moves here. */
export interface ToolchainRolloutUpdate {
  members: ToolchainCanaryMember[];
  added?: string[];
  removed?: string[];
  moved?: Array<{ orgId: string; fromReleaseVersion: string }>;
}

/** The canary gate's thresholds: N runs, M orgs, T percentage points. */
export interface ToolchainGateThresholds {
  n: number;
  m: number;
  t: number;
}

/** The §6 canary gate and the numbers behind it. Rates are percent (0–100). */
export interface ToolchainCanaryGate {
  passes: boolean;
  runs: number;
  orgs: number;
  failureRate: number | null;
  defaultFailureRate: number | null;
  thresholds: ToolchainGateThresholds;
}

/** `GET /plugins/toolchain/releases/:v/canary`. */
export interface ToolchainCanaryView {
  members: ToolchainCanaryMember[];
  gate: ToolchainCanaryGate;
}

/** One §8 guard as the preview evaluates it. */
export interface ToolchainGuard {
  code: string;
  ok: boolean;
  detail?: string;
}

/** `GET /plugins/toolchain/releases/:v/default-preview`. */
export interface ToolchainDefaultPreview {
  blastRadius: {
    followingPipelines: number;
    followingOrgs: number;
    orgsWithOwnDefault: number;
    pinnedPipelines: number;
  };
  guards: ToolchainGuard[];
  currentDefault: string | null;
}

/** `POST /plugins/toolchain/releases/:v/default` body. */
export interface ToolchainSetDefaultBody {
  expectedCurrentDefault: string | null;
  overrideReason?: string;
  canaryGate?: ToolchainGateThresholds;
}

/** The kinds of platform-default change history records. */
export type ToolchainDefaultKind = 'set' | 'initial' | 'restore';

/** One row of `GET /plugins/toolchain/history`, newest first. */
export interface ToolchainDefaultHistoryEntry {
  releaseVersion: string;
  previousReleaseVersion: string | null;
  kind: ToolchainDefaultKind;
  setBy: string;
  setAt: string;
  reason: string | null;
}

/** `GET /plugins/toolchain/affected?release=v` (§9). */
export interface ToolchainAffectedView {
  releaseVersion: string;
  orgs: Array<{ orgId: string; orgName: string; pipelineCount: number; pipelineIds: string[] }>;
}

/** `GET /plugins/toolchain/cleanup`. */
export interface ToolchainCleanupCandidate {
  releaseVersion: string;
  createdAt: string;
}
