// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Response shapes of a pipeline's plugin-security surface:
 *  - api/plugin `routes/pipeline-security.ts` — per-step security, exposures, triage;
 *  - api/pipeline `routes/plugin-upgrade-routes.ts` — plugin upgrade preview / apply;
 *  - api/pipeline `routes/security-report-routes.ts` — application-artifact scan reports;
 *  - api/plugin `routes/kept-setup-images.ts` — the system org's kept setup images.
 *
 * Type-only (no runtime imports). Vulnerability state never blocks a pipeline:
 * everything here is a severity grade, an exposure or a remediation.
 */

import type { ToolchainResolvedVia } from '@pipeline-builder/api-core/plugin-catalog';

import type { VulnGrade, VulnSeverity } from '@/lib/plugin-vulns';
import type { PluginFinding } from './plugin-vulnerability-types';

/** One severity-graded warning (`code`, `severity`, `message`). */
export interface GradedPluginWarning {
  code: string;
  severity: VulnSeverity;
  message: string;
  suggestedVersion?: string;
}

/** Triage state of an exposure. */
export type ExposureTriage = 'open' | 'accepted' | 'false_positive' | string;

/** One exposure of a pipeline to a vulnerable plugin version (`shapeExposure`). */
export interface PipelineExposureView {
  id: string;
  pipelineId: string;
  /** `publisher/name` or `name`. */
  plugin: string;
  pluginPublisher: string | null;
  pluginName: string;
  version: string;
  imageDigest: string | null;
  /** `declared` (config resolves to it) or `deployed` (last deploy runs it). */
  source: string;
  criticalCount: number;
  highCount: number;
  topFindings: Array<Partial<PluginFinding> & Record<string, unknown>>;
  findingCount: number;
  triageState: ExposureTriage;
  acceptance: { active: boolean; until: string | null; findingCount: number; kev: boolean } | null;
  triageReason: string | null;
  triagedBy: string | null;
  triagedAt: string | null;
  flaggedAt: string;
  fixedAt: string | null;
}

/** The scan facts of a step's resolved version, now. */
export interface StepScanFacts {
  flagged: boolean;
  kev: number;
  criticalFixable: number | null;
  highFixable: number | null;
  critical: number | null;
  high: number | null;
  scannedAt: string | null;
  stale: boolean;
  unscanned: boolean;
}

/** One step of `GET /plugins/pipelines/:pipelineId/security`. */
export interface PipelineSecurityStep {
  /** `synth` or `<stage>/<step>`. */
  stepKey: string;
  plugin: string | null;
  declaredVersion: string | null;
  version: string | null;
  digest: string | null;
  withinPolicy: boolean | null;
  resolutionComputedAt: string | null;
  lastLookupAt: string | null;
  /** The warnings the last lookup answered. */
  warnings: Array<{ code: string; message: string; severity?: VulnSeverity; suggestedVersion?: string }>;
  refusal: { code?: string; message?: string } | null;
  catalogState: 'live' | 'inactive' | 'yanked' | 'deleted' | null;
  scan: StepScanFacts | null;
  severity: VulnGrade;
  /** The assessment of the version as it stands now. */
  currentWarnings: GradedPluginWarning[];
  exposures: PipelineExposureView[];
}


/**
 * The pipeline's "Build image" row: the toolchain release (its
 * `pipeline-bootstrap` half) the last deploy runs on, or — before a deploy —
 * the last bootstrap lookup. Not a step.
 */
export interface PipelineBuildImage {
  /** Always `build-image` (the key its lookup warnings are recorded under). */
  stepKey: string;
  plugin: string;
  releaseVersion: string | null;
  digest: string | null;
  imageRepository: string | null;
  resolvedVia: ToolchainResolvedVia | string | null;
  deployedAt: string | null;
  lastLookupAt: string | null;
  warnings: Array<{ code: string; message: string; severity?: VulnSeverity; suggestedVersion?: string }>;
  refusal: { code?: string; message?: string } | null;
  catalogState: 'live' | 'inactive' | 'yanked' | 'deleted' | null;
  scan: StepScanFacts | null;
  severity: VulnGrade;
  currentWarnings: GradedPluginWarning[];
  exposures: PipelineExposureView[];
  /** What an unpinned pipeline of this org resolves now (org default, canary or platform default). */
  effectiveDefault: { releaseVersion: string; resolvedVia: ToolchainResolvedVia | string } | null;
  /** The release is older than {@link effectiveDefault} (never `isDefault`). */
  behindDefault: boolean;
  /** The synth step's plugin (`publisher/name` or `name`). */
  synthPlugin: string | null;
  /** The synth step is not the managed `cdk-synth`. */
  toolchainUnmanaged: boolean;
  /** The last release change between consecutive deploys (the run-history marker). */
  change: { from: string; to: string; changedAt: string } | null;
  releaseNotes: string | null;
}

/** `GET /plugins/pipelines/:pipelineId/security` (`pipelines:read`). */
export interface PipelineSecurity {
  pipeline: { id: string; name: string | null };
  severity: VulnGrade;
  steps: PipelineSecurityStep[];
  /** Null until a deploy (or a bootstrap lookup) recorded one. */
  buildImage: PipelineBuildImage | null;
  exposures: PipelineExposureView[];
}

/** Body of `POST /plugins/pipelines/:pipelineId/exposures/:exposureId/triage` (`pipelines:write`). */
export interface ExposureTriageBody {
  action: 'accept' | 'false_positive' | 'reopen';
  /** Required for accept and false_positive. */
  reason?: string;
  /** accept only: an ISO date at most PLUGIN_RISK_ACCEPTANCE_MAX_DAYS (90) away. */
  acceptedUntil?: string;
  /** accept only: accepting a version with KEV findings must say so explicitly. */
  kev?: boolean;
}

// ── Plugin upgrades (api/pipeline helpers/plugin-upgrades.ts) ──────────────

/** Why a step needs an upgrade (what its resolved version's scan says). */
export interface UpgradeReason {
  flagged: boolean;
  kev: number;
  criticalFixable: number;
  highFixable: number;
}

/** One step's remediation. */
export interface StepUpgrade {
  stepKey: string;
  path: string;
  plugin: string;
  publisher: string | null;
  declaredVersion: string | null;
  pin: 'exact' | 'range' | 'none';
  currentVersion: string;
  reason: UpgradeReason;
  suggestedInPin: string | null;
  suggestedLatest: string | null;
  apply: { version: string | null; widenVersion: string | null };
}

/** One rewritten step, as recorded on the audit event and the response. */
export interface AppliedUpgrade {
  stepKey: string;
  plugin: string;
  publisher: string | null;
  fromVersion: string;
  fromDeclared: string | null;
  toDeclared: string;
}

/** One version an upgrade moves off, and whether anything still references it. */
export interface VersionRelease {
  plugin: string;
  publisher: string | null;
  version: string;
  references: { declared: number; deployed: number };
  removable: boolean;
}

/** `POST /pipelines/:id/plugin-upgrades/preview` (`pipelines:read`). */
export interface PluginUpgradePreview {
  pipelineId: string;
  upgrades: StepUpgrade[];
  releases: VersionRelease[];
}

/** One save-time plugin warning (create / update / bulk / validate / upgrade apply). */
export interface PipelinePluginWarning {
  /** `synth` or `<stageName>/<alias ?? name>`. */
  stepKey: string;
  plugin: string;
  code: string;
  severity: VulnSeverity;
  message: string;
  suggestedVersion?: string;
}

/** Per-pipeline outcome of an upgrade apply. */
export type PluginUpgradeOutcome =
  | { pipelineId: string; status: 'upgraded'; applied: AppliedUpgrade[]; pluginWarnings?: PipelinePluginWarning[]; redeploy?: { executionId: string } | { error: string } }
  | { pipelineId: string; status: 'unchanged' }
  | { pipelineId: string; status: 'failed'; error: string };

/** `POST /pipelines/plugin-upgrades/apply` (`pipelines:write`). */
export interface PluginUpgradeApplyResult {
  upgraded: number;
  results: PluginUpgradeOutcome[];
  releases: VersionRelease[];
  /** Nothing runs the new versions until a synth re-reads the config. */
  redeployRequired: boolean;
}

// ── Application-artifact security reports ──────────────────────────────────

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  kev: number;
  criticalFixable: number;
  highFixable: number;
}

/** The latest report for one (tool, stage). */
export interface ArtifactSecurityReport {
  id: string;
  pipelineId: string;
  tool: string;
  format: 'sarif' | 'trivy-json' | 'grype-json' | string;
  /** `''` when the upload named no stage. */
  stage: string;
  executionId: string | null;
  counts: SeverityCounts;
  findings: Array<Partial<PluginFinding> & { id: string; target?: string }>;
  truncated: boolean;
  submittedBy: string;
  createdAt: string;
}

/** `GET /pipelines/:id/security-reports` (`pipelines:read`). */
export interface PipelineSecurityReports {
  pipelineId: string;
  reports: ArtifactSecurityReport[];
  counts: SeverityCounts;
  latestAt: string | null;
}

// ── Kept setup images (system org) ─────────────────────────────────────────

export interface KeptSetupImageView {
  id: string;
  pluginName: string;
  pluginVersion: string;
  imageDigest: string;
  imageSource: string;
  refusalCode: string;
  refusalMessage: string;
  refusalFindings: unknown[];
  visibility: string | null;
  publishRequest: boolean;
  keptBy: string;
  keptAt: string;
  expiresAt: string;
}

export interface PromotionResult {
  plugin: { id: string; name: string; version: string; imageDigest: string | null };
  messages: Array<{ level: 'INFO' | 'WARN'; message: string; data?: Record<string, unknown> }>;
}

// ── 409 PLUGIN_VERSION_IN_USE ──────────────────────────────────────────────

/** `details` of a 409 PLUGIN_VERSION_IN_USE refusing a delete / purge. */
export interface PluginVersionInUseDetails {
  reason: 'in_use' | 'listed';
  pipelineCount?: number;
  orgCount?: number;
  /** The caller's own org's referencing pipelines (others only as counts). */
  pipelines?: Array<{ id: string; name: string | null; orgId: string; sources?: string[]; deleted?: boolean }>;
  severity?: VulnSeverity | null;
  vulnerability?: {
    flagged: boolean; kev: number; criticalFixable: number | null; highFixable: number | null; critical: number | null; high: number | null;
  };
  suggestedVersion?: string;
}
