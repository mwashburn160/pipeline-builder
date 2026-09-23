// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Pipelines and the things shaped like them: the builder props a pipeline is
 *  defined by, its maturity scorecard, the golden-path templates it starts from
 *  and its execution counts. */

import type { Criticality, EntityLink, Lifecycle, OwnerType, TemplateInput, Visibility } from '@pipeline-builder/api-core';

/**
 * Builder props for pipeline configuration.
 * Mirrors the canonical BuilderProps from @pipeline-builder/pipeline-core
 * but without CDK-specific type imports.
 */
export interface BuilderProps {
  project: string;
  organization: string;
  pipelineName?: string;
  global?: Record<string, string | number | boolean>;
  /** Pipeline-level template variables, exposed to `{{ pipeline.vars.* }}`. */
  vars?: Record<string, string | number | boolean>;
  defaults?: Record<string, unknown>;
  role?: Record<string, unknown>;
  synth: Record<string, unknown>;
  stages?: Record<string, unknown>[];
}

/**
 * Create pipeline request data
 * Only props (based on BuilderProps) and visibility are required
 */
export interface CreatePipelineData {
  project: string;
  organization: string;
  pipelineName?: string;
  description?: string;
  keywords?: string[];
  props: BuilderProps;
  visibility?: Visibility;
}

/**
 * Pipeline model
 */
export interface Pipeline {
  // Primary key
  id: string;
  
  // Organization and access control
  orgId: string;
  
  // Audit fields
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  
  // Core pipeline information
  project: string;
  organization: string;
  pipelineName?: string;
  description?: string;
  keywords: string[];
  
  // Pipeline configuration
  props: BuilderProps;

  // Developer-portal catalog metadata (ownership / lifecycle / classification)
  ownerId?: string | null;
  ownerType?: OwnerType | null;
  /** Catalog lifecycle stage. `notNull` + DEFAULT 'production' in the schema and
   *  never projected away, so every row carries one. */
  lifecycle: Lifecycle;
  criticality?: Criticality | null;
  labels?: Record<string, string>;
  links?: EntityLink[];

  // Access and visibility
  visibility: Visibility;
  isDefault: boolean;
  isActive: boolean;

  // Deletion tracking (soft delete)
  deletedAt?: string;
  deletedBy?: string;
}

/** DORA performance band (shared with the reporting domain type). */
export type ScorecardDoraLevel = 'elite' | 'high' | 'medium' | 'low' | null;

/**
 * Per-pipeline maturity scorecard: compliance posture + DORA bands → a graded
 * 0–100 score. Mirrors the server `Scorecard` shape.
 */
export interface PipelineScorecard {
  pipelineId: string;
  score: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | 'N/A';
  compliance: {
    score: number | null;
    rulesEvaluated: number;
    violations: number;
    warnings: number;
  };
  dora: {
    score: number | null;
    basis: 'deploy' | 'run';
    deploymentFrequency: ScorecardDoraLevel;
    changeFailureRate: ScorecardDoraLevel;
    meanTimeToRestore: ScorecardDoraLevel;
    leadTime: ScorecardDoraLevel;
  };
  computedAt: string;
}

/** One pipeline's scorecard within the org-wide roll-up (adds its display name). */
export interface ScorecardLeaderboardEntry extends PipelineScorecard {
  name?: string;
}

/**
 * Org-wide "software health" roll-up: every pipeline graded, ranked, plus
 * aggregate stats. Mirrors the server `rollup` shape from GET /pipelines/scorecard.
 */
export interface ScorecardRollup {
  orgId: string;
  pipelineCount: number;
  scored: number;
  averageScore: number | null;
  gradeDistribution: Record<string, number>;
  leaderboard: ScorecardLeaderboardEntry[];
  computedAt: string;
  truncated: boolean;
  /** Pipelines whose score could not be COMPUTED (an error), as opposed to
   *  computed with no data. The roll-up degrades per row rather than failing
   *  the page, so this is how a partial result announces itself. */
  failed?: number;
}

/**
 * Template visibility ladder. Unlike the pipeline/plugin catalogs' two-value
 * `visibility`, templates have a personal rung so an author can iterate on a
 * draft before sharing it:
 * - `private` — only the author (`createdBy`) sees or edits it
 * - `org`     — everyone in the owning org sees it
 * - `public`  — shared with the org and its teams (needs `pipelines:publish`);
 *               the system org's public templates are the catalog every org sees
 */
export type TemplateVisibility = 'private' | 'org' | 'public';

/** Golden-path pipeline template (parameterized starter). */
export interface PipelineTemplate {
  id: string;
  orgId: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  name: string;
  description?: string | null;
  keywords: string[];
  category: string;
  /** Template body: a BuilderProps with `{{ vars.* }}` placeholders. */
  props: BuilderProps;
  /** Declared inputs the user fills in to instantiate. */
  inputs: TemplateInput[];
  ownerId?: string | null;
  ownerType?: OwnerType | null;
  /** Catalog lifecycle stage. `notNull` + DEFAULT 'production' in the schema and
   *  never projected away, so every row carries one. */
  lifecycle: Lifecycle;
  criticality?: Criticality | null;
  labels?: Record<string, string>;
  links?: EntityLink[];
  /** Three-rung ladder — see {@link TemplateVisibility}. */
  visibility: TemplateVisibility;
  isActive: boolean;
  /** Soft-delete tombstone fields (set when deleted; powers "recently deleted"). */
  deletedAt?: string | null;
  deletedBy?: string | null;
}

/**
 * Typed views for AI-generated BuilderProps structure.
 * Used by GitUrlTab to safely access nested plugin references
 * within the loosely-typed BuilderProps.synth / BuilderProps.stages.
 */

/** Plugin reference as it appears in AI-generated BuilderProps JSON. */
export interface GeneratedPluginRef {
  /** Publisher handle of an installed listing; absent = unqualified reference. */
  publisher?: string;
  name: string;
  alias?: string;
  filter?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Typed view of an AI-generated stage step. */
export interface GeneratedStageStep {
  plugin: GeneratedPluginRef;
  [key: string]: unknown;
}

/** Typed view of an AI-generated stage. */
export interface GeneratedStage {
  stageName: string;
  alias?: string;
  steps: GeneratedStageStep[];
}

/** Typed view of the AI-generated synth section. */
export interface GeneratedSynth {
  plugin: GeneratedPluginRef;
  [key: string]: unknown;
}

/**
 * Narrow a loosely-typed `BuilderProps.synth` / `.stages` (arbitrary plugin-
 * config JSON, `Record<string, unknown>`) to the AI-generated view. The wire
 * shape is genuinely untyped, so this is an unavoidable assertion — centralized
 * and documented here instead of scattering `as unknown as GeneratedSynth` at
 * each read in the AI-generation UI (which only renders AFTER generation
 * produces this shape). Prefer these over inline casts.
 */
export function asGeneratedSynth(synth: Record<string, unknown>): GeneratedSynth {
  return synth as unknown as GeneratedSynth;
}

export function asGeneratedStages(stages: Record<string, unknown>[] | undefined): GeneratedStage[] {
  return (stages ?? []) as unknown as GeneratedStage[];
}

/**
 * One pipeline's execution-count row from `/api/reports/execution/count`
 * (the `pipelines[]` entries). Canonical shape shared by the reports, dashboard,
 * and executions pages — mirrors the `getExecutionCount` API return type.
 */
export interface ExecutionCountRow {
  id: string;
  project: string;
  organization: string;
  pipeline_name: string | null;
  total: number;
  succeeded: number;
  failed: number;
  canceled: number;
  first_execution: string | null;
  last_execution: string | null;
}

