import {
  getAvailableProviders,
  getProviderModels,
  resolveModel,
  createModelWithKey,
  generateText,
  streamText,
  Output,
} from '@mwashburn160/ai-core';
import { createLogger, ValidationError } from '@mwashburn160/api-core';
import { z } from 'zod';

export { getAvailableProviders, getProviderModels };

const logger = createLogger('ai-generation');

// Service-Specific Types

/** Summary of an available plugin, used as context for AI generation. */
export interface PluginSummary {
  name: string;
  description: string | null;
  version: string;
  pluginType: string;
  computeType: string;
  commands: string[];
  installCommands: string[];
  keywords: string[];
  metadata: Record<string, string | number | boolean>;
  env: Record<string, string>;
}

/** Parameters for pipeline configuration generation. */
export interface GenerationRequest {
  /** Natural language description of the desired pipeline. */
  prompt: string;
  /** Available plugins for the AI to reference. */
  plugins: PluginSummary[];
  /** Organization ID for the requesting user. */
  orgId: string;
  /** AI provider to use (e.g. "anthropic", "openai", "google"). */
  provider: string;
  /** AI model to use (e.g. "claude-sonnet-4-20250514"). */
  model: string;
  /** Optional custom API key overriding the server/org key. */
  apiKey?: string;
}

/** Result of AI pipeline configuration generation. */
export interface GenerationResult {
  /** Generated BuilderProps configuration. */
  props: Record<string, unknown>;
  /** AI-generated description of the pipeline. */
  description?: string;
  /** AI-generated keywords for the pipeline. */
  keywords?: string[];
}

// Zod Schema — BuilderProps structure for structured AI output

const PluginOptionsSchema = z.object({
  name: z.string().describe('Plugin name (must match an available plugin)'),
  alias: z.string().optional().describe('Optional alias for the plugin instance'),
});

const StepCustomizationSchema = z.object({
  preInstallCommands: z.array(z.string()).optional().describe('Commands to run before the plugin install commands'),
  postInstallCommands: z.array(z.string()).optional().describe('Commands to run after the plugin install commands'),
  preCommands: z.array(z.string()).optional().describe('Commands to run before the plugin build commands'),
  postCommands: z.array(z.string()).optional().describe('Commands to run after the plugin build commands'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables for this step'),
});

const SourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('github'),
    options: z.object({
      repo: z.string().describe('GitHub repository in format "owner/repo"'),
      branch: z.string().optional().describe('Branch name, defaults to "main"'),
      trigger: z.enum(['NONE', 'AUTO']).optional().describe('Trigger behavior'),
    }),
  }),
  z.object({
    type: z.literal('s3'),
    options: z.object({
      bucketName: z.string().describe('S3 bucket name'),
      objectKey: z.string().optional().describe('Object key, defaults to "source.zip"'),
      trigger: z.enum(['NONE', 'AUTO']).optional(),
    }),
  }),
  z.object({
    type: z.literal('codestar'),
    options: z.object({
      repo: z.string().describe('Repository in format "owner/repo"'),
      branch: z.string().optional().describe('Branch name, defaults to "main"'),
      connectionArn: z.string().describe('CodeStar connection ARN'),
      trigger: z.enum(['NONE', 'AUTO']).optional(),
      codeBuildCloneOutput: z.boolean().optional(),
    }),
  }),
]);

const StageStepSchema = StepCustomizationSchema.extend({
  plugin: PluginOptionsSchema,
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  position: z.enum(['pre', 'post']).optional().describe('Step position: "pre" (before deploy) or "post" (after deploy)'),
  timeout: z.number().optional().describe('CodeBuild timeout in minutes'),
});

const StageSchema = z.object({
  stageName: z.string().describe('Display name for this stage'),
  alias: z.string().optional().describe('Optional alias for construct ID generation'),
  steps: z.array(StageStepSchema).describe('Build steps within this stage'),
});

const SynthSchema = StepCustomizationSchema.extend({
  source: SourceSchema,
  plugin: PluginOptionsSchema,
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const PipelineGenerationSchema = z.object({
  project: z.string().describe('Project identifier (lowercase, alphanumeric with hyphens)'),
  organization: z.string().describe('Organization identifier (lowercase, alphanumeric with hyphens)'),
  pipelineName: z.string().optional().describe('Optional custom pipeline name'),
  description: z.string().optional().describe('Human-readable description of the pipeline'),
  keywords: z.array(z.string()).optional().describe('Keywords for categorizing this pipeline'),
  synth: SynthSchema.describe('Synthesis step configuration'),
  stages: z.array(StageSchema).optional().describe('Pipeline stages after synth'),
  global: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Global metadata inherited by all steps'),
});

// Plugin Context Helpers

/** Extract category from plugin metadata or top-level field. Defaults to 'unknown'. */
function getCategory(plugin: PluginSummary): string {
  const category = (plugin.metadata ?? {}).category;
  return typeof category === 'string' && category.trim().length > 0 ? category.trim().toLowerCase() : 'unknown';
}

// System Prompt

/**
 * Build the system prompt for AI pipeline generation.
 *
 * @param plugins - Available plugins to include as context
 * @returns System prompt string
 */
function buildSystemPrompt(plugins: PluginSummary[]): string {
  const pluginList = plugins.length > 0
    ? plugins.map((p) => {
      let line = `- "${p.name}" (v${p.version}, type: ${p.pluginType}, compute: ${p.computeType})${p.description ? `: ${p.description}` : ''}`;

      const parts: string[] = [];

      const keywords = p.keywords ?? [];
      if (keywords.length > 0) {
        parts.push(`keywords: ${keywords.join(', ')}`);
      }

      const category = getCategory(p);
      if (category) {
        parts.push(`category: ${category}`);
      }

      const envKeys = Object.keys(p.env ?? {});
      if (envKeys.length > 0) {
        parts.push(`env: ${envKeys.join(', ')}`);
      }

      if (parts.length > 0) {
        line += `\n  ${parts.join(' | ')}`;
      }
      return line;
    }).join('\n')
    : '(No plugins available — use a reasonable default plugin name and note it may need to be created)';

  return `You are a pipeline configuration assistant for an AWS CDK Pipelines platform.

Your job is to convert a user's natural language description of a CI/CD pipeline into a structured pipeline configuration.

## Available Plugins
These are the plugins available for use in the synth step and stage steps. You MUST use plugin names from this list:

${pluginList}

## Configuration Rules

1. **project** and **organization** are required. Infer them from the user's description. Use lowercase with hyphens.
2. **synth** is required and must include:
   - source: one of {type: "github", options: {repo: "owner/repo", branch?: "main"}}, {type: "s3", options: {bucketName: "..."}}, or {type: "codestar", options: {repo: "owner/repo", connectionArn: "..."}}
   - plugin: {name: "..."} — must reference an available plugin
3. **stages** are optional arrays of {stageName, steps: [{plugin: {name}, ...}]}
4. For source, default to "github" if the user mentions a repo. Default branch to "main" unless specified.
5. trigger values: "NONE" (default, manual) or "AUTO" (automatic on changes).
6. Step position is "pre" (before deploy, default) or "post" (after deploy).
7. Only include fields the user explicitly or implicitly requested. Omit optional fields with no value.
8. If the user mentions environment variables, include them in the env field of the relevant step.
9. If the user does not specify a pipeline name, omit it (the system will auto-generate one).
10. Choose the most appropriate plugin based on description, keywords, category, and env vars. Prefer plugins whose keywords match the user's technology stack. Use category to select appropriate plugins for each pipeline stage purpose (e.g., "testing" plugins for test stages, "security" for scan stages).
11. If the user's description is too vague, make reasonable assumptions and proceed.`;
}

// Main Generation Function

/**
 * Generate a pipeline configuration from a natural language description.
 *
 * Calls the AI SDK's generateText() with a structured output schema to
 * produce BuilderProps JSON. The system prompt includes available plugins
 * as context for the AI.
 *
 * @param request - Generation parameters including prompt, plugins, provider, and model
 * @returns Generated BuilderProps, optional description, and keywords
 * @throws Error if the AI provider is not configured, model is invalid, or AI produces no output
 */
export async function generatePipelineConfig(request: GenerationRequest): Promise<GenerationResult> {
  const model = request.apiKey
    ? createModelWithKey(request.provider, request.model, request.apiKey)
    : resolveModel(request.provider, request.model);
  const systemPrompt = buildSystemPrompt(request.plugins);

  logger.info('Generating pipeline config via AI', {
    orgId: request.orgId,
    provider: request.provider,
    model: request.model,
    promptLength: request.prompt.length,
    pluginCount: request.plugins.length,
  });

  const { output } = await generateText({
    model,
    system: systemPrompt,
    prompt: request.prompt,
    output: Output.object({ schema: PipelineGenerationSchema }),
  });

  if (!output) {
    throw new ValidationError('AI did not produce a pipeline configuration');
  }

  const { description, keywords, ...props } = output;

  logger.info('AI pipeline generation completed', {
    orgId: request.orgId,
    provider: request.provider,
    project: props.project,
    organization: props.organization,
    stageCount: props.stages?.length ?? 0,
  });

  return {
    props,
    description: description ?? undefined,
    keywords: keywords ?? undefined,
  };
}

// Streaming Generation Function

/** Result of streaming AI pipeline generation. */
export interface StreamingGenerationResult {
  /** Async iterable of partial pipeline objects as they stream in. */
  partialOutputStream: AsyncIterable<Record<string, unknown>>;
  /** Promise that resolves to the final validated output when streaming completes. */
  output: PromiseLike<z.infer<typeof PipelineGenerationSchema> | undefined>;
}

/**
 * Stream a pipeline configuration from a natural language description.
 *
 * Uses streamText() with Output.object() to produce partial BuilderProps
 * objects as the AI generates them. The caller iterates partialOutputStream
 * for progressive updates and awaits output for the final result.
 *
 * @param request - Generation parameters including prompt, plugins, provider, and model
 * @returns Streaming result with partialOutputStream and final output promise
 * @throws Error if the AI provider is not configured or model is invalid
 */
export function streamPipelineConfig(request: GenerationRequest): StreamingGenerationResult {
  const model = request.apiKey
    ? createModelWithKey(request.provider, request.model, request.apiKey)
    : resolveModel(request.provider, request.model);
  const systemPrompt = buildSystemPrompt(request.plugins);

  logger.info('Streaming pipeline config via AI', {
    orgId: request.orgId,
    provider: request.provider,
    model: request.model,
    promptLength: request.prompt.length,
    pluginCount: request.plugins.length,
  });

  const result = streamText({
    model,
    system: systemPrompt,
    prompt: request.prompt,
    output: Output.object({ schema: PipelineGenerationSchema }),
  });

  return {
    partialOutputStream: result.partialOutputStream as AsyncIterable<Record<string, unknown>>,
    output: result.output,
  };
}
