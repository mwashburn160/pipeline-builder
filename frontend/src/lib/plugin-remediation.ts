// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard copy and small decisions for nightly plugin CVE remediation.
 *
 * Every RULE (which stages are live, how far a library may move, how a
 * pipeline's effective mode resolves) is api-core's, imported from the
 * browser-safe `plugin-scan` subpath, so a badge cannot disagree with the job.
 * This module only turns those vocabularies into words and colours.
 */
import {
  GRYPE_PACKAGE_TYPE_CATALOG,
  LIBRARY_UPGRADE_LEVELS,
  PLUGIN_REMEDIATION_STAGE_LABELS,
  REMEDIATION_REMAINING_REASON_LABELS,
  comparePackageVersions,
  isGrypePackageType,
  libraryUpgradeRequirement,
  type GrypePackageType,
  type LibraryUpgradeLevel,
  type LibraryUpgradeRequirement,
  type PipelineRemediationElection,
  type PipelineRemediationUpgradeState,
  type PluginRemediationMode,
  type PluginRemediationStage,
  type RemediationFixMethod,
  type RemediationProposeReason,
  type RemediationRemainingReason,
  type RemediationRolloutStatus,
  type TeamRemediationRollout,
} from '@pipeline-builder/api-core/plugin-scan';
import type { BadgeColor } from '@/components/ui/Badge';

export { PLUGIN_REMEDIATION_STAGE_LABELS, REMEDIATION_REMAINING_REASON_LABELS, LIBRARY_UPGRADE_LEVELS };

/** The one sentence every surface shows while the deployment knob (`PLUGIN_REMEDIATION_ENABLED=false`) is off. */
export const REMEDIATION_OPERATOR_OFF_TITLE = 'Remediation is turned off by the operator';
export const REMEDIATION_OPERATOR_OFF_MESSAGE = 'This deployment does not build, publish or roll out plugin security fixes right now. '
  + 'Flagged versions are still reported and your settings are kept; they take effect once the operator turns remediation back on.';

/** Badge colour per stage: waiting on someone is yellow, failed red, done green. */
export const REMEDIATION_STAGE_COLORS: Record<PluginRemediationStage, BadgeColor> = {
  queued: 'gray',
  rebuild: 'blue',
  libraries: 'blue',
  awaiting_approval: 'yellow',
  published: 'indigo',
  rolling_out: 'indigo',
  done: 'green',
  needs_owner: 'yellow',
  needs_review: 'red',
  failed: 'red',
};

/** The stage filters the Remediations list offers (plan: needs owner, awaiting approval, rolling out, needs review). */
export const REMEDIATION_STAGE_FILTERS: ReadonlyArray<{ key: string; label: string; stages: PluginRemediationStage[] }> = [
  { key: 'all', label: 'All', stages: [] },
  { key: 'needs_owner', label: 'Needs owner', stages: ['needs_owner'] },
  { key: 'awaiting_approval', label: 'Awaiting approval', stages: ['awaiting_approval'] },
  { key: 'rolling_out', label: 'Rolling out', stages: ['published', 'rolling_out'] },
  { key: 'needs_review', label: 'Needs review', stages: ['needs_review'] },
];

export const REMEDIATION_FIX_METHOD_LABELS: Record<RemediationFixMethod, string> = {
  rebuild: 'Base-image rebuild',
  source_patch: 'Source patch',
  overlay: 'Overlay layer',
  ask_agent: 'Drafted by the ask agent',
};

export const REMEDIATION_PROPOSE_REASON_LABELS: Record<RemediationProposeReason, string> = {
  org_mode: 'Your organization reviews fixes before they are published',
  major_upgrade: 'A library crosses a major version (always reviewed)',
  no_smoke_test: 'The plugin declares no smokeTest, so the fix cannot be verified automatically',
  ask_agent_patch: 'The patch was drafted by the ask agent (always reviewed)',
};

export const REMEDIATION_ROLLOUT_STATUS_LABELS: Record<RemediationRolloutStatus, string> = {
  pending: 'Pending',
  canary: 'Canary wave',
  batches: 'Rolling out in batches',
  done: 'Finished',
  paused: 'Paused',
  cancelled: 'Cancelled',
};

/**
 * Where a pipeline remediation-upgrade row shows on the pipeline's panel: an
 * open proposal, a change request, a wave of an apply rollout, the rollback
 * history, or nowhere of its own (closed rows).
 */
export type PipelineUpgradeSection = 'proposal' | 'change_request' | 'wave' | 'history' | 'closed';

/** Each pipeline remediation-upgrade state: its badge words and colour, and its panel section. */
export const PIPELINE_UPGRADE_STATE_CATALOG = {
  proposed: { label: 'Proposed', color: 'yellow', section: 'proposal' },
  change_requested: { label: 'Change requested', color: 'yellow', section: 'change_request' },
  queued: { label: 'Waiting for its wave', color: 'blue', section: 'wave' },
  moved: { label: 'Moved', color: 'green', section: 'wave' },
  failed: { label: 'Move failed', color: 'red', section: 'history' },
  rolled_back: { label: 'Rolled back', color: 'red', section: 'history' },
  rollback_blocked: { label: 'Rollback blocked', color: 'red', section: 'history' },
  skipped_opt_out: { label: 'Skipped (opted out)', color: 'gray', section: 'closed' },
  skipped_runner: { label: 'Skipped (runner unhealthy)', color: 'gray', section: 'wave' },
  dismissed: { label: 'Dismissed', color: 'gray', section: 'closed' },
  superseded: { label: 'Superseded', color: 'gray', section: 'closed' },
} as const satisfies Record<PipelineRemediationUpgradeState, { label: string; color: BadgeColor; section: PipelineUpgradeSection }>;

export const PIPELINE_UPGRADE_STATE_LABELS: Record<PipelineRemediationUpgradeState, string> = Object.fromEntries(
  Object.entries(PIPELINE_UPGRADE_STATE_CATALOG).map(([k, v]) => [k, v.label]),
) as Record<PipelineRemediationUpgradeState, string>;

/** A state's catalog entry, tolerant of a state the server sends that this build does not know. */
export function pipelineUpgradeState(state: string): { label: string; color: BadgeColor; section: PipelineUpgradeSection } {
  return (PIPELINE_UPGRADE_STATE_CATALOG as Record<string, { label: string; color: BadgeColor; section: PipelineUpgradeSection }>)[state]
    ?? { label: state, color: 'gray', section: 'closed' };
}

export const REMEDIATION_MODE_LABELS: Record<PluginRemediationMode, string> = {
  off: 'Off: do not build fixes',
  propose: 'Propose: build fixes and wait for approval',
  apply: 'Apply: build and publish verified fixes',
};

/** Pipeline rollout copy; `inherit` only applies to teams and pipelines. */
export const REMEDIATION_ROLLOUT_LABELS: Record<TeamRemediationRollout, string> = {
  inherit: 'Follow the root organization',
  off: 'Off: publish and notify only',
  propose: 'Propose: open an upgrade proposal per pipeline',
  apply: 'Apply: upgrade and redeploy in waves',
};

export const PIPELINE_ELECTION_LABELS: Record<PipelineRemediationElection, string> = {
  inherit: 'Follow organization',
  off: 'Off',
  propose: 'Propose',
  apply: 'Apply',
};

export const LIBRARY_UPGRADE_LEVEL_LABELS: Record<LibraryUpgradeLevel, string> = {
  patch: 'Patch: same major and minor (2.3.1 to 2.3.4)',
  minor: 'Minor: same major (2.3.1 to 2.4.0)',
  major: 'Major: any version (2.3.1 to 3.0.0, always reviewed)',
};

/** A package type's label, tolerant of a type the server sends that this build does not know. */
export function packageTypeLabel(type: string | null | undefined): string {
  if (!type) return 'Unknown';
  return isGrypePackageType(type) ? GRYPE_PACKAGE_TYPE_CATALOG[type].label : type;
}

/** The short layer id (`sha256:abcdef123456`) a findings row shows. */
export function shortLayer(layerID: string | null | undefined): string {
  if (!layerID) return '';
  const [algo, hex] = layerID.includes(':') ? layerID.split(':', 2) : ['', layerID];
  return `${algo ? `${algo}:` : ''}${hex.slice(0, 12)}`;
}

/** What a finding needs before remediation can fix it automatically. */
export type FindingRemediationMarker =
  /** The smallest fix is a major library upgrade (propose-only) or a Go /vN module the owner must take. */
  | { kind: 'major'; requirement: LibraryUpgradeRequirement; fixVersion: string }
  /** No fixed version, or a package type nothing can patch (`other`, a compiled binary without a pinned ARG). */
  | { kind: 'not_patchable'; why: string }
  | null;

/** The lowest fixed version, by the package type's own ordering. */
export function lowestFixVersion(fixedIn: readonly string[], type: GrypePackageType): string | null {
  if (fixedIn.length === 0) return null;
  return [...fixedIn].sort((a, b) => comparePackageVersions(a, b, type))[0] ?? null;
}

/**
 * The marker a findings row shows: "needs a major upgrade" when the smallest
 * fix crosses a major version (or is a Go module major, always the owner's),
 * "not patchable" when there is no fix or the package type has no patcher and
 * no overlay. Null when remediation can handle it within the defaults.
 */
export function findingRemediationMarker(f: {
  packageType: string | null;
  packageVersion: string | null;
  fixedIn: readonly string[];
}): FindingRemediationMarker {
  if (f.fixedIn.length === 0) return { kind: 'not_patchable', why: 'No fixed version yet' };
  const type: GrypePackageType = f.packageType && isGrypePackageType(f.packageType) ? f.packageType : 'other';
  const spec = GRYPE_PACKAGE_TYPE_CATALOG[type];
  if (spec.sourcePatch === 'no' && !spec.overlay) {
    return { kind: 'not_patchable', why: type === 'other' ? 'Package type has no patcher' : 'Cannot be patched automatically' };
  }
  const fix = lowestFixVersion(f.fixedIn, type);
  if (!fix || !f.packageVersion) return null;
  const requirement = libraryUpgradeRequirement(f.packageVersion, fix, type);
  if (requirement === 'major' || requirement === 'owner') return { kind: 'major', requirement, fixVersion: fix };
  return null;
}

/** Words for a remaining finding's reason (unknown reason codes are shown as sent). */
export function remainingReasonLabel(reason: RemediationRemainingReason | string, requiredLevel?: LibraryUpgradeRequirement): string {
  const base = (REMEDIATION_REMAINING_REASON_LABELS as Record<string, string>)[reason] ?? reason;
  if (reason === 'beyond_upgrade_level' && requiredLevel) {
    return `${base} (needs ${requiredLevel === 'owner' ? 'the owner' : `a ${requiredLevel} upgrade`})`;
  }
  return base;
}

/** The plugins page deep link that opens a remediation (the Remediations tab, scrolled to the row). */
export function remediationHref(remediationId: string): string {
  return `/dashboard/plugins?tab=remediations&remediation=${encodeURIComponent(remediationId)}`;
}
