// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers shared by the org "Pipeline toolchain" panel and the pipeline
 * editor's toolchain selector (docs/plans/bootstrap-image-versioning.md §5,
 * §10, §11). No React, so each rule is testable on its own.
 */
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import type { BadgeColor } from '@/components/ui/Badge';
import type {
  ToolchainOrgDefaultView, ToolchainRelease, ToolchainReleaseStatus, ToolchainResolvedVia, ToolchainWarning,
} from '@/types/toolchain';

/** An org default this many releases (or more) behind the platform default is flagged (§10, K=3). */
export const TOOLCHAIN_BEHIND_WARN_AFTER = 3;

export const RELEASE_STATUS_LABEL: Record<ToolchainReleaseStatus, string> = {
  default: 'Platform default',
  canary: 'Canary',
  available: 'Available',
  deprecated: 'Deprecated',
  yanked: 'Yanked',
};

export const RELEASE_STATUS_COLOR: Record<ToolchainReleaseStatus, BadgeColor> = {
  default: 'green',
  canary: 'purple',
  available: 'blue',
  deprecated: 'yellow',
  yanked: 'red',
};

/** Why the effective release applies, in words. */
export const RESOLVED_VIA_LABEL: Record<ToolchainResolvedVia, string> = {
  pin: 'pinned by the pipeline',
  'org-default': 'your organization default',
  canary: 'your organization is in the canary for this release',
  default: 'the platform default',
};

/** Whether a release may be NEWLY chosen (a pin or org default already on it keeps resolving). */
export function isReleaseSelectable(r: Pick<ToolchainRelease, 'status'>): boolean {
  return r.status !== 'yanked' && r.status !== 'deprecated';
}

/** Numeric semver compare on `major.minor.patch` (prerelease/build ignored); <0 when `a` is older. */
export function compareReleaseVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * How many listed releases are newer than `version` up to and including
 * `target` (the platform default). The list is the eligible one, so the count
 * is of releases the org could actually move to.
 */
export function releasesBehind(version: string, target: string | null, releases: ToolchainRelease[]): number {
  if (!target || compareReleaseVersions(version, target) >= 0) return 0;
  return releases.filter((r) =>
    compareReleaseVersions(r.releaseVersion, version) > 0 && compareReleaseVersions(r.releaseVersion, target) <= 0,
  ).length;
}

/** Whether a scan summary carries something worth warning about (fixable Critical or KEV). */
export function isScanVulnerable(scan: ToolchainRelease['scan']): boolean {
  return !!scan && (scan.criticalFixable > 0 || scan.kev > 0);
}

/** Scan summary in a few words. */
export function scanSummaryText(scan: ToolchainRelease['scan']): string {
  if (!scan || !scan.scannedAt) return 'Not scanned';
  const parts: string[] = [];
  if (scan.criticalFixable > 0) parts.push(`${scan.criticalFixable} fixable critical`);
  if (scan.highFixable > 0) parts.push(`${scan.highFixable} fixable high`);
  if (scan.kev > 0) parts.push(`${scan.kev} known exploited`);
  return parts.length > 0 ? parts.join(', ') : 'No fixable critical or high findings';
}

/** The component versions in one line. */
export function toolchainVersionsText(t: ToolchainRelease['toolchain']): string {
  return [
    `pipeline-manager ${t.pipelineManager}`,
    `aws-cdk ${t.awsCdk}`,
    `cdk-assets ${t.cdkAssets}`,
    `Node ${t.node}`,
    `pnpm ${t.pnpm}`,
    `esbuild ${t.esbuild}`,
  ].join(' · ');
}

/**
 * The §10 hygiene warnings for an org default (or a pipeline pin): yanked,
 * deprecated, vulnerable, or more than K releases behind the platform default.
 * A release missing from the eligible list is reported as no longer eligible.
 */
export function releaseWarnings(version: string, platformDefault: string | null, releases: ToolchainRelease[]): string[] {
  const out: string[] = [];
  const r = releases.find((x) => x.releaseVersion === version);
  if (!r) {
    out.push(`Release ${version} is no longer offered. It keeps resolving, but choose another release.`);
  } else {
    if (r.status === 'yanked') out.push(`Release ${version} was yanked. It keeps resolving, but move to another release.`);
    if (r.status === 'deprecated') out.push(`Release ${version} is deprecated.`);
    if (isScanVulnerable(r.scan)) out.push(`Release ${version} has ${scanSummaryText(r.scan)} findings.`);
  }
  const behind = releasesBehind(version, platformDefault, releases);
  if (behind >= TOOLCHAIN_BEHIND_WARN_AFTER) {
    out.push(`Release ${version} is ${behind} releases behind the platform default (${platformDefault}).`);
  }
  return out;
}

/** A write's `warnings`, as sentences. */
export function warningMessages(warnings: ToolchainWarning[] | undefined): string[] {
  return (warnings ?? []).map((w) => (typeof w === 'string' ? w : w.message)).filter(Boolean);
}

/** A toolchain write's error, with the eligibility refusals in plain words. */
export function toolchainErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'TOOLCHAIN_RELEASE_NOT_ELIGIBLE') {
      return `That release can't be chosen: only live releases that have served as the platform default, or are in canary for your organization, are eligible. ${err.message}`;
    }
    if (err.code === 'TOOLCHAIN_PIN_VIA_RELEASE') {
      return `The cdk-synth step can't pin its own version; pin the whole toolchain release instead. ${err.message}`;
    }
  }
  return formatError(err, fallback);
}

/**
 * The default an UNPINNED pipeline follows, in the editor's words: the org's
 * own default (or the one a team inherits), else the platform default (canary
 * included — it is still "the platform's choice" from a pipeline's side).
 */
export function followDefaultLabel(view: ToolchainOrgDefaultView | null): string {
  if (!view) return 'Default';
  const current = view.effective.releaseVersion ?? 'none';
  if (view.effective.resolvedVia === 'org-default') {
    return view.inheritedFrom
      ? `Org default, inherited from ${view.inheritedFrom} (currently ${current})`
      : `Org default (currently ${current})`;
  }
  return `Platform default (currently ${current})`;
}
