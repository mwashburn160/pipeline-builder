/**
 * @module services/ai-plugin-generation-service
 * @description AI-powered plugin configuration generation using Vercel AI SDK.
 *
 * Uses generateText() with Output.object() to produce structured plugin
 * configuration JSON + Dockerfile from natural language descriptions.
 * Supports multiple AI providers (Anthropic, OpenAI, Google).
 *
 * Provider types and model catalog are imported from the shared
 * {@link @mwashburn160/api-core} constants to avoid duplication with the
 * pipeline AI generation service.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  createLogger,
  AI_PROVIDER_CATALOG,
  AI_PROVIDER_ENV_VARS,
  getAIProviderModels,
  type AIProviderInfo,
  type AIModelInfo,
} from '@mwashburn160/api-core';
import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';

const logger = createLogger('ai-plugin-generation');

// ---------------------------------------------------------------------------
// Re-export shared types for backward compatibility
// ---------------------------------------------------------------------------

/** @see {@link AIProviderInfo} from api-core */
export type ProviderInfo = AIProviderInfo;
/** @see {@link AIModelInfo} from api-core */
export type ModelInfo = AIModelInfo;

// ---------------------------------------------------------------------------
// Service-Specific Types
// ---------------------------------------------------------------------------

/** Parameters for plugin configuration generation. */
export interface PluginGenerationRequest {
  /** Natural language description of the desired plugin. */
  prompt: string;
  /** Organization ID for the requesting user. */
  orgId: string;
  /** AI provider to use (e.g. "anthropic", "openai", "google"). */
  provider: string;
  /** AI model to use (e.g. "claude-sonnet-4-20250514"). */
  model: string;
  /** Optional custom API key overriding the server/org key. */
  apiKey?: string;
}

/** Result of AI plugin configuration generation. */
export interface PluginGenerationResult {
  /** Generated plugin configuration (without Dockerfile). */
  config: {
    name: string;
    description?: string;
    version: string;
    pluginType: string;
    computeType: string;
    keywords: string[];
    primaryOutputDirectory?: string;
    installCommands: string[];
    commands: string[];
    env?: Record<string, string>;
  };
  /** Generated Dockerfile content for the plugin build environment. */
  dockerfile: string;
}

// ---------------------------------------------------------------------------
// Provider Registry (SDK-dependent — kept local)
// ---------------------------------------------------------------------------

/** Registered provider with model factory function. */
interface ProviderEntry {
  info: AIProviderInfo;
  createModel: (modelId: string) => LanguageModel;
}

const registry = new Map<string, ProviderEntry>();

/**
 * Lazily initialize the provider registry from environment variables.
 * Only providers with configured API keys are registered.
 */
function initRegistry(): void {
  if (registry.size > 0) return;

  const factories: Record<string, (key: string) => (modelId: string) => LanguageModel> = {
    anthropic: (key) => createAnthropic({ apiKey: key }),
    openai: (key) => createOpenAI({ apiKey: key }),
    google: (key) => createGoogleGenerativeAI({ apiKey: key }),
  };

  for (const [id, info] of Object.entries(AI_PROVIDER_CATALOG)) {
    const envVar = AI_PROVIDER_ENV_VARS[id];
    const apiKey = envVar ? process.env[envVar] : undefined;
    if (apiKey && factories[id]) {
      const provider = factories[id](apiKey);
      registry.set(id, {
        info,
        createModel: (modelId) => provider(modelId),
      });
    }
  }
}

/**
 * Returns the list of providers that have API keys configured via env vars.
 *
 * @returns Array of configured provider info with model lists
 */
export function getAvailableProviders(): AIProviderInfo[] {
  initRegistry();
  return Array.from(registry.values()).map((e) => e.info);
}

/**
 * Returns the model list for a given provider ID (regardless of env var config).
 *
 * @param providerId - Provider identifier
 * @returns Array of models, or empty array if provider is unknown
 */
export function getProviderModels(providerId: string): AIModelInfo[] {
  return getAIProviderModels(providerId);
}

/**
 * Resolve a LanguageModel from the registry for a configured provider.
 *
 * @param providerId - Provider identifier
 * @param modelId - Model identifier
 * @returns LanguageModel instance
 * @throws Error if provider is not configured or model is invalid
 */
function resolveModel(providerId: string, modelId: string): LanguageModel {
  initRegistry();
  const entry = registry.get(providerId);
  if (!entry) {
    throw new Error(`AI provider "${providerId}" is not configured. Set the corresponding API key environment variable.`);
  }
  const validModel = entry.info.models.find((m) => m.id === modelId);
  if (!validModel) {
    const available = entry.info.models.map((m) => m.id).join(', ');
    throw new Error(`Model "${modelId}" is not available for provider "${providerId}". Available models: ${available}`);
  }
  return entry.createModel(modelId);
}

/**
 * Create a temporary LanguageModel using a custom API key (not cached in registry).
 *
 * @param providerId - Provider identifier
 * @param modelId - Model identifier
 * @param apiKey - Custom API key
 * @returns LanguageModel instance
 * @throws Error if provider or model is unknown
 */
function createModelWithKey(providerId: string, modelId: string, apiKey: string): LanguageModel {
  const models = getAIProviderModels(providerId);
  if (models.length === 0) {
    throw new Error(`Unknown AI provider "${providerId}". Supported: ${Object.keys(AI_PROVIDER_CATALOG).join(', ')}`);
  }
  if (!models.find((m) => m.id === modelId)) {
    throw new Error(`Model "${modelId}" is not available for provider "${providerId}". Available: ${models.map((m) => m.id).join(', ')}`);
  }

  switch (providerId) {
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId);
    case 'openai':
      return createOpenAI({ apiKey })(modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId);
    default:
      throw new Error(`Unsupported AI provider "${providerId}"`);
  }
}

// ---------------------------------------------------------------------------
// Zod Schema — Plugin configuration structure for structured AI output
// ---------------------------------------------------------------------------

const PluginGenerationSchema = z.object({
  name: z.string().describe('Plugin name (lowercase, alphanumeric with hyphens, e.g. "nodejs-build")'),
  description: z.string().optional().describe('Human-readable description of what this plugin does'),
  version: z.string().describe('Semantic version (e.g. "1.0.0")'),
  pluginType: z.enum(['CodeBuildStep', 'ShellStep', 'ManualApprovalStep']).describe('Plugin execution type'),
  computeType: z.enum(['SMALL', 'MEDIUM', 'LARGE', 'X2_LARGE']).describe('AWS CodeBuild compute size'),
  keywords: z.array(z.string()).describe('Keywords for categorizing this plugin'),
  primaryOutputDirectory: z.string().optional().describe('Primary output directory path (e.g. "dist", "build", "cdk.out")'),
  installCommands: z.array(z.string()).describe('Commands to install dependencies (run before build commands)'),
  commands: z.array(z.string()).describe('Build/execution commands'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables for the plugin'),
  dockerfile: z.string().describe('Complete Dockerfile content for the plugin build environment'),
});

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for AI plugin generation.
 *
 * @returns System prompt string with plugin type, compute, and Dockerfile guidance
 */
function buildSystemPrompt(): string {
  return `You are a plugin configuration assistant for an AWS CDK Pipelines platform.

Your job is to convert a user's natural language description into a complete plugin configuration, including a Dockerfile for the build environment.

## What is a Plugin?

A plugin defines a reusable build step for CI/CD pipelines. It runs inside a Docker container in AWS CodeBuild. The plugin specifies:
- **installCommands**: Commands to install dependencies (e.g., "npm ci", "pip install -r requirements.txt")
- **commands**: Build/execution commands (e.g., "npm run build", "pytest")
- **Dockerfile**: Defines the Docker image with all required tools pre-installed

## Plugin Types

- **CodeBuildStep** (most common): Runs commands in AWS CodeBuild using the Docker image
- **ShellStep**: Runs shell commands directly (simpler, no Docker required)
- **ManualApprovalStep**: Pauses pipeline for manual approval

## Compute Types

- **SMALL**: 3 GB memory, 2 vCPUs — lightweight tasks
- **MEDIUM**: 7 GB memory, 4 vCPUs — standard builds (default)
- **LARGE**: 15 GB memory, 8 vCPUs — heavy builds, large test suites
- **X2_LARGE**: 145 GB memory, 72 vCPUs — extreme workloads

## Configuration Rules

1. **name**: Must be lowercase with hyphens (e.g., "nodejs-build", "python-test", "docker-deploy")
2. **version**: Default to "1.0.0" unless the user specifies otherwise
3. **pluginType**: Default to "CodeBuildStep" unless the user specifies otherwise
4. **computeType**: Default to "MEDIUM" unless the task clearly needs more/less resources
5. **installCommands**: Should install all dependencies needed for the build
6. **commands**: Should perform the actual build/test/deploy operations
7. **Dockerfile**: Must be a complete, valid Dockerfile that:
   - Starts with an appropriate base image for the language/framework
   - Installs all required system dependencies and tools
   - Sets a sensible WORKDIR (typically /app)
   - Does NOT copy application source code (the pipeline handles this)
   - Should be optimized with multi-stage builds when appropriate
   - Include common tools like git, curl, and unzip when useful
8. **keywords**: Include relevant technology names and use cases
9. **primaryOutputDirectory**: Set when the plugin produces build artifacts (e.g., "dist" for frontend builds, "cdk.out" for CDK synth)
10. **env**: Only include if the user mentions specific environment variables

## Dockerfile Best Practices

- Use official base images (node:20-slim, python:3.12-slim, golang:1.22, etc.)
- Minimize layer count by combining RUN commands with &&
- Clean up package manager caches (apt-get clean, rm -rf /var/lib/apt/lists/*)
- Install only necessary packages
- Set appropriate environment variables (NODE_ENV, PYTHONDONTWRITEBYTECODE, etc.)

## Examples

For a "Node.js build plugin":
- installCommands: ["npm ci"]
- commands: ["npm run build", "npm test"]
- Dockerfile: Based on node:20-slim with git and build essentials

For a "Python test plugin":
- installCommands: ["pip install -r requirements.txt"]
- commands: ["pytest --verbose"]
- Dockerfile: Based on python:3.12-slim with git`;
}

// ---------------------------------------------------------------------------
// Main Generation Function
// ---------------------------------------------------------------------------

/**
 * Generate a plugin configuration from a natural language description.
 *
 * Calls the AI SDK's generateText() with a structured output schema to
 * produce plugin config JSON and a Dockerfile. The system prompt includes
 * guidance on plugin types, compute sizes, and Dockerfile best practices.
 *
 * @param request - Generation parameters including prompt, provider, and model
 * @returns Generated plugin config and Dockerfile content
 * @throws Error if the AI provider is not configured, model is invalid, or AI produces no output
 */
export async function generatePluginConfig(request: PluginGenerationRequest): Promise<PluginGenerationResult> {
  const model = request.apiKey
    ? createModelWithKey(request.provider, request.model, request.apiKey)
    : resolveModel(request.provider, request.model);
  const systemPrompt = buildSystemPrompt();

  logger.info('Generating plugin config via AI', {
    orgId: request.orgId,
    provider: request.provider,
    model: request.model,
    promptLength: request.prompt.length,
  });

  const { output } = await generateText({
    model,
    system: systemPrompt,
    prompt: request.prompt,
    output: Output.object({ schema: PluginGenerationSchema }),
  });

  if (!output) {
    throw new Error('AI did not produce a plugin configuration');
  }

  const { dockerfile, ...config } = output;

  logger.info('AI plugin generation completed', {
    orgId: request.orgId,
    provider: request.provider,
    name: config.name,
    pluginType: config.pluginType,
  });

  return {
    config: {
      ...config,
      description: config.description ?? undefined,
      primaryOutputDirectory: config.primaryOutputDirectory ?? undefined,
      env: config.env ?? undefined,
    },
    dockerfile,
  };
}
