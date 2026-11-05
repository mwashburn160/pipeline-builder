// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { VisibilitySchema } from './common-schemas.js';
import { BUILD_CLASSES, BUILD_SIZES } from '../types/build-catalog.js';
import { envInt } from '../utils/env.js';

const MAX_PROMPT_LENGTH = envInt('MAX_PROMPT_LENGTH', 5000, { min: 1 });

/**
 * Largest `previousConfig` (serialized JSON, chars) an iterative refinement may
 * send back. It rides in the model's prompt on every refinement, so an
 * unbounded one turned a single `aiCalls` unit into an arbitrarily large input
 * bill; a real generated pipeline config is a few KB.
 */
export const MAX_PREVIOUS_CONFIG_CHARS = 64_000;

// AI Generation Request

/**
 * Schema for AI generation request body.
 * Used by both POST /pipelines/generate and POST /plugins/generate.
 */
export const AIGenerateBodySchema = z.object({
  /** Natural language description of what to generate. */
  prompt: z
    .string()
    .min(1, 'A prompt with a natural language description is required')
    .max(MAX_PROMPT_LENGTH, `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer`),

  /** AI provider identifier (e.g. "anthropic", "openai", "google"). */
  provider: z.string().min(1, 'A provider is required (e.g., "anthropic", "openai", "google")'),

  /** AI model identifier (e.g. "claude-sonnet-5-5", "gpt-5.6-sol"). */
  model: z.string().min(1, 'A model is required (e.g., "claude-sonnet-5-5", "gpt-5.6-sol")'),

  /** Optional custom API key to override the server/org key for this request. */
  apiKey: z.string().min(1).optional(),

  /** Previous pipeline config for iterative refinement. */
  previousConfig: z.record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= MAX_PREVIOUS_CONFIG_CHARS, `previousConfig must serialize to ${MAX_PREVIOUS_CONFIG_CHARS} characters or fewer`)
    .optional(),

  /** Fallback AI providers if primary fails (e.g., ["openai", "google"]). */
  fallbackProviders: z.array(z.string()).optional(),
});

// Plugin Deploy-Generated Request

/**
 * Schema for POST /plugins/deploy-generated request body.
 * Validates the AI-generated plugin configuration before Docker build.
 */
export const PluginDeployGeneratedSchema = z.object({
  /** Plugin name (lowercase, alphanumeric with hyphens). */
  name: z.string().min(1, 'Plugin name is required'),

  /** Human-readable description. */
  description: z.string().optional(),

  /** Semantic version (e.g. "1.0.0"). */
  version: z.string().min(1, 'Version is required'),

  /** Plugin execution type. */
  pluginType: z.enum(['CodeBuildStep', 'ShellStep', 'ManualApprovalStep']).default('CodeBuildStep'),

  /** AWS CodeBuild compute size. */
  computeType: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'X2_LARGE']).default('MEDIUM'),

  /** Keywords for categorization. */
  keywords: z.array(z.string()).optional().default([]),

  /** Primary output directory path. */
  primaryOutputDirectory: z.string().nullable().optional(),

  /** Commands to install dependencies. */
  installCommands: z.array(z.string()).optional().default([]),

  /** Build/execution commands. */
  commands: z.array(z.string()).min(1, 'At least one build command is required'),

  /** Environment variables. */
  env: z.record(z.string(), z.string()).optional(),

  /** Docker build arguments passed via --build-arg at image build time. */
  buildArgs: z.record(z.string(), z.string()).optional(),

  /** Complete Dockerfile content for the build environment. */
  dockerfile: z.string().min(1, 'Dockerfile content is required'),

  /** Access visibility. */
  visibility: VisibilitySchema.default('private'),

  /** Scheduling class for the image build (D11); see `PluginUploadBodySchema`. */
  buildClass: z.enum(BUILD_CLASSES).optional(),

  /** Machine size for the image build (D13); refused above the tier's ceiling. */
  buildSize: z.enum(BUILD_SIZES).optional(),
});

// AI Generate From URL Request

/**
 * Schema for POST /pipelines/generate/from-url/stream request body.
 * Validates Git URL + AI provider configuration for repo-based pipeline generation.
 */
export const AIGenerateFromUrlBodySchema = z.object({
  /** Git repository URL (HTTPS, SSH, or git@ format). */
  gitUrl: z.string().min(1, 'A Git repository URL is required').max(500, 'URL must be 500 characters or fewer'),

  /** AI provider identifier (e.g. "anthropic", "openai", "google"). */
  provider: z.string().min(1, 'A provider is required'),

  /** AI model identifier (e.g. "claude-sonnet-5-5", "gpt-5.6-sol"). */
  model: z.string().min(1, 'A model is required'),

  /** Optional custom API key to override the server config. */
  apiKey: z.string().min(1).optional(),

  /** Optional authentication token for accessing private repositories. */
  repoToken: z.string().min(1).optional(),
});

// Repository Analysis Request

/**
 * Schema for POST /pipelines/analyze/from-url — repository analysis ONLY (no AI
 * call, no `aiCalls` slot): the Ask agent's `propose_plugin_from_repo` reads the
 * analysis summary from it before drafting through the plugin generator.
 */
export const AnalyzeFromUrlBodySchema = z.object({
  /** Git repository URL (HTTPS, SSH, or git@ format). */
  gitUrl: z.string().min(1, 'A Git repository URL is required').max(500, 'URL must be 500 characters or fewer'),

  /** Optional authentication token for accessing private repositories. */
  repoToken: z.string().min(1).optional(),
});
