// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed pipeline toolchain as an org sees it: its effective release, its
 * own default, and the releases it may choose (docs/plans/
 * bootstrap-image-versioning.md §5, §11). Served by the plugin service under
 * `/api/plugins/toolchain/*`.
 */

/** Why a pipeline (or the org) lands on its effective release, most specific first. */
export type ToolchainResolvedVia = 'pin' | 'org-default' | 'canary' | 'default';

/** A release's lifecycle state. Yanked and deprecated releases can't be newly chosen. */
export type ToolchainReleaseStatus = 'default' | 'canary' | 'available' | 'deprecated' | 'yanked';

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
