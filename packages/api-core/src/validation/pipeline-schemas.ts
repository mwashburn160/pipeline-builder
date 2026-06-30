// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { BaseFilterSchema, BooleanQuerySchema, AccessModifierSchema } from './common-schemas.js';

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
 * Plugin options schema (name-based selection)
 */
const PluginOptionsSchema = z.object({
  name: z.string().min(1),
  alias: z.string().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

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
 * Stage schema
 */
const StageSchema = z.object({
  stageName: z.string().min(1),
  alias: z.string().optional(),
  steps: z.array(StageStepSchema).min(1),
});

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
  project: z.string().min(1, 'Project is required'),
  organization: z.string().min(1, 'Organization is required'),
  pipelineName: z.string().min(1).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  accessModifier: AccessModifierSchema.optional(),
  props: BuilderPropsSchema,
});

/**
 * Pipeline update schema
 */
export const PipelineUpdateSchema = z.object({
  pipelineName: z.string().min(1).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  props: BuilderPropsSchema.optional(),
  isActive: BooleanQuerySchema.optional(),
  isDefault: BooleanQuerySchema.optional(),
  accessModifier: AccessModifierSchema.optional(),
});

/**
 * Infer TypeScript types from schemas
 * Note: Prefixed with "Validated" to avoid conflicts with existing type definitions
 */
export type ValidatedPipelineFilter = z.infer<typeof PipelineFilterSchema>;
export type ValidatedPipelineCreate = z.infer<typeof PipelineCreateSchema>;
export type ValidatedPipelineUpdate = z.infer<typeof PipelineUpdateSchema>;
