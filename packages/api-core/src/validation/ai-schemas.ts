import { z } from 'zod';
import { AccessModifierSchema } from './common-schemas';

const MAX_PROMPT_LENGTH = parseInt(process.env.MAX_PROMPT_LENGTH || '5000', 10);

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

  /** AI model identifier (e.g. "claude-sonnet-4-20250514", "gpt-4o"). */
  model: z.string().min(1, 'A model is required (e.g., "claude-sonnet-4-20250514", "gpt-4o")'),

  /** Optional custom API key to override the server/org key for this request. */
  apiKey: z.string().min(1).optional(),

  /** Previous pipeline config for iterative refinement. */
  previousConfig: z.record(z.string(), z.unknown()).optional(),

  /** Fallback AI providers if primary fails (e.g., ["openai", "google"]). */
  fallbackProviders: z.array(z.string()).optional(),
});

/** Validated type for AI generation request body. */
export type ValidatedAIGenerateBody = z.infer<typeof AIGenerateBodySchema>;

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
  accessModifier: AccessModifierSchema.default('private'),
});

/** Validated type for plugin deploy-generated request body. */
export type ValidatedPluginDeployGenerated = z.infer<typeof PluginDeployGeneratedSchema>;

// AI Generate From URL Request

/**
 * Schema for POST /pipelines/generate/from-url/stream request body.
 * Validates Git URL + AI provider configuration for repo-based pipeline generation.
 */
export const AIGenerateFromUrlBodySchema = z.object({
  /** Git repository URL (HTTPS, SSH, or git@ format). */
  gitUrl: z.string().min(1, 'A Git repository URL is required').max(500, 'URL must be 500 characters or fewer'),

  /** AI provider identifier (e.g. "ollama", "anthropic", "openai"). */
  provider: z.string().min(1, 'A provider is required'),

  /** AI model identifier (e.g. "llama3", "claude-sonnet-4-20250514"). */
  model: z.string().min(1, 'A model is required'),

  /** Optional custom API key (or base URL for Ollama) to override the server config. */
  apiKey: z.string().min(1).optional(),

  /** Optional authentication token for accessing private repositories. */
  repoToken: z.string().min(1).optional(),
});

/** Validated type for AI generate-from-URL request body. */
export type ValidatedAIGenerateFromUrlBody = z.infer<typeof AIGenerateFromUrlBodySchema>;
