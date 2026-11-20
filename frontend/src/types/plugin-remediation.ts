// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nightly plugin CVE remediation as the dashboard sees it.
 *
 * Every shape the plugin service answers with lives in api-core
 * (`types/plugin-remediation.ts`) and is imported from the browser-safe
 * `@pipeline-builder/api-core/plugin-scan` subpath, so these are re-exports, not
 * copies. Only the envelopes of the list / settings answers and the pipeline
 * service's per-pipeline rows (pipeline-data, not importable) are declared here.
 */
import type {
  GrypePackageType, LibraryUpgradeLevel, PipelineRemediationElection, PipelineRemediationUpgradeState,
  PluginRemediationDto, PluginRemediationRollout, PluginRemediationSettings, RemediationSeverity,
  ResolvedRemediationRollout, TeamRemediationRollout,
} from '@pipeline-builder/api-core/plugin-scan';

export type {
  GrypePackageType, LibraryUpgradeLevel, LibraryUpgradeRequirement, PipelineRemediationElection,
  PipelineRemediationUpgradeState, PluginBatchActionResult, PluginDeleteAllResult, PluginDeletePreview,
  PluginDeleteSkip, PluginDeleteSkipReason, PluginRemediationDto, PluginRemediationMode, PluginRemediationOutcome,
  PluginRemediationRollout, PluginRemediationSettings, PluginRemediationStage, RemediationClearedFinding,
  RemediationFixMethod, RemediationProposeReason, RemediationRemainingFinding, RemediationRemainingReason,
  RemediationRolloutSummary, RemediationRolloutWave, RemediationSeverity, ResolvedRemediationRollout,
  TeamRemediationRollout,
} from '@pipeline-builder/api-core/plugin-scan';

/** `GET /plugins/remediations` (one page, newest first). */
export interface PluginRemediationList {
  remediations: PluginRemediationDto[];
  nextCursor: string | null;
  /** The deployment knob (`PLUGIN_REMEDIATION_ENABLED`). False = nothing is built, published or rolled out. */
  enabled: boolean;
  severities: RemediationSeverity[];
  /** Remediations this org started in the last 24 hours, out of `maxPerDay`. */
  usedToday: number;
  maxPerDay: number;
  /** Pipelines in the org that elected `off` (skipped by every rollout). */
  optedOutPipelines?: number;
}

/** Query of the list route: `stage` is one stage or a comma list. */
export interface PluginRemediationListQuery {
  stage?: string;
  pluginId?: string;
  pluginName?: string;
  limit?: number;
  cursor?: string;
}

/** `GET /plugins/remediation-settings`. */
export interface PluginRemediationSettingsView {
  settings: PluginRemediationSettings;
  /** The caller's org is a team: rollout may be `inherit`, `allowPipelineApply` is the root's. */
  isTeam: boolean;
  /** For a team: the root org's values it inherits. Null for a root org. */
  root: { rollout: PluginRemediationRollout; allowPipelineApply: boolean } | null;
  /** The deployment knob; settings stay editable while it is off. */
  enabled: boolean;
  severities: RemediationSeverity[];
  canEdit: boolean;
}

/** Body of `PUT /plugins/remediation-settings` (only provided fields are written). */
export interface PluginRemediationSettingsWrite {
  mode?: PluginRemediationSettings['mode'];
  libraryUpgradeLevel?: LibraryUpgradeLevel;
  /** `null` for a type clears its override. */
  libraryUpgradeLevelByType?: Partial<Record<GrypePackageType, LibraryUpgradeLevel | null>>;
  rollout?: TeamRemediationRollout;
  /** Root org only (400 on a team). */
  allowPipelineApply?: boolean;
}

/**
 * One row of a pipeline's remediation upgrades (`pipeline_remediation_upgrades`
 * as `GET /pipelines/:id/remediation-upgrades` answers it, dates ISO). This is
 * where proposals, change requests, waves and rollback history live.
 *
 * `criticalCleared` / `highCleared` / `kev` / `advisoryIds` are what the plugin
 * service sent when it started the rollout; the row does not store them today,
 * so they are optional and the banner falls back to plain words without them.
 */
export interface PipelineRemediationUpgradeView {
  id: string;
  orgId: string;
  remediationId: string;
  pipelineId: string;
  pluginName: string;
  pluginPublisher: string | null;
  fromVersion: string;
  toVersion: string;
  mode: PluginRemediationRollout;
  state: PipelineRemediationUpgradeState;
  /** 0 = canary, null = not in a wave (propose). */
  wave: number | null;
  movedAt: string | null;
  runRequestId: string | null;
  rolledBackAt: string | null;
  rolledBackTo: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  criticalCleared?: number;
  highCleared?: number;
  kev?: boolean;
  advisoryIds?: string[];
}

/** `GET /pipelines/:id/remediation-upgrades`. */
export interface PipelineRemediationUpgrades {
  election: PipelineRemediationElection;
  effective: ResolvedRemediationRollout;
  orgDefault: PluginRemediationRollout;
  allowPipelineApply: boolean;
  upgrades: PipelineRemediationUpgradeView[];
}
