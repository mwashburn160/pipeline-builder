// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { BaseFilterSchema, BooleanQuerySchema, VisibilitySchema, CatalogMetadataShape } from './common-schemas.js';
import { PUBLISHER_HANDLE_PATTERN } from '../types/ecosystem.js';

/**
 * Pipeline filter schema for query parameters
 */
export const PipelineFilterSchema = BaseFilterSchema.extend({
  project: z.string().min(1).optional(),
  organization: z.string().min(1).optional(),
  pipelineName: z.string().min(1).optional(),
  orgId: z.string().min(1).optional(),
  keyword: z.string().min(1).optional(),
});

/**
 * Keys that look like plugin-reference fields but aren't: synth never reads
 * them, so without a loud refusal the reference silently resolves to something
 * other than what its author meant.
 */
const PLUGIN_REF_NON_FIELDS: Record<string, string> = {
  version:
    '`version` is not a plugin-reference field — it is ignored and the default version is used. '
    + 'Pin or range the version with `filter: { version: "1.2.3" }` (also ^, ~, 1.x, 1.2, latest).',
};

/**
 * Plugin options schema (name-based selection)
 */
const PluginOptionsSchema = z.object({
  name: z.string().min(1),
  /**
   * The publisher whose installed listing the reference resolves to
   * (docs/plans/plugin-ecosystem.md §3.5). Absent: the org's own plugin, then
   * its parent's, then the Official listing.
   */
  publisher: z.string().max(39).regex(PUBLISHER_HANDLE_PATTERN, 'publisher must be a publisher handle (lowercase letters, digits and single hyphens)').optional(),
  alias: z.string().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough().superRefine((ref, ctx) => {
  for (const [key, message] of Object.entries(PLUGIN_REF_NON_FIELDS)) {
    if (key in (ref as Record<string, unknown>)) {
      ctx.addIssue({ code: 'custom', path: [key], message });
    }
  }
});

/**
 * Stage step schema
 *
 * `passthrough()` keeps forward-compatible fields, but a few common mistakes are
 * rejected loudly rather than silently ignored at synth — most notably a
 * top-level `commands`, which is NOT a step field (the plugin's own commands run)
 * and would otherwise do nothing.
 */
const STEP_NON_FIELDS: Record<string, string> = {
  commands:
    '`commands` is not a step field — it is ignored at synth (the plugin\'s own commands run). '
    + 'To change what a step runs, use a plugin env knob (e.g. `metadata.GRADLE_TASK`), '
    + '`preCommands`/`postCommands` to add commands around the plugin\'s, or the '
    + '`aws:cdk:pipelines:codebuildstep:commands` metadata key for a full override.',
};

const StageStepSchema = z.object({
  plugin: PluginOptionsSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
  network: z.record(z.string(), z.unknown()).optional(),
  position: z.enum(['pre', 'post']).optional(),
}).passthrough().superRefine((step, ctx) => {
  for (const [key, message] of Object.entries(STEP_NON_FIELDS)) {
    if (key in (step as Record<string, unknown>)) {
      ctx.addIssue({ code: 'custom', path: [key], message });
    }
  }
});

/**
 * Stage schema. `passthrough()` like its siblings: a strict-by-default object
 * here stripped every undeclared stage field before storage — including
 * `environment`, which marks a stage as a DORA deploy.
 */
const StageSchema = z.object({
  stageName: z.string().min(1),
  alias: z.string().optional(),
  /** Deploy environment this stage targets (DORA deploy attribution, `pb.deploys`). */
  environment: z.string().min(1).max(64).optional(),
  steps: z.array(StageStepSchema).min(1),
}).passthrough();

/**
 * BuilderProps schema — structural validation for pipeline configuration.
 * Uses passthrough() to allow additional fields without rejecting them.
 */
const BuilderPropsSchema = z.object({
  project: z.string().min(1),
  organization: z.string().min(1),
  pipelineName: z.string().optional(),
  global: z.record(z.string(), z.unknown()).optional(),
  defaults: z.record(z.string(), z.unknown()).optional(),
  role: z.record(z.string(), z.unknown()).optional(),
  synth: z.object({
    source: z.record(z.string(), z.unknown()).optional(),
    plugin: PluginOptionsSchema,
  }).passthrough(),
  stages: z.array(StageSchema).optional(),
}).passthrough();

/**
 * Pipeline creation schema
 */
export const PipelineCreateSchema = z.object({
  ...CatalogMetadataShape,
  project: z.string().min(1, 'Project is required'),
  organization: z.string().min(1, 'Organization is required'),
  pipelineName: z.string().min(1).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  visibility: VisibilitySchema.optional(),
  props: BuilderPropsSchema,
});

/**
 * Pipeline update schema
 */
export const PipelineUpdateSchema = z.object({
  ...CatalogMetadataShape,
  pipelineName: z.string().min(1).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  props: BuilderPropsSchema.optional(),
  isActive: BooleanQuerySchema.optional(),
  isDefault: BooleanQuerySchema.optional(),
  visibility: VisibilitySchema.optional(),
});
