// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { generateText, resolveModelSelection, streamText, Output } from '@pipeline-builder/ai-core';
import { createLogger } from '@pipeline-builder/api-core';
import type { z } from 'zod';
import { PipelineGenerationSchema } from './generation-schema.js';
import type { PluginSummary } from './plugin-catalog.js';

const logger = createLogger('ai-generation');

/**
 * The provider round-trip completed but produced no usable output. Distinct from
 * pre-provider failures (model resolution, connectivity) so callers can apply the
 * keep-on-provider-contact quota policy: the external $ cost was already incurred,
 * so the reserved `aiCalls` slot is NOT refunded (matching the streaming path,
 * which keeps the slot once the provider was contacted).
 */
export class AIEmptyOutputError extends Error {
  /** Marker: the AI provider WAS contacted before this failure. */
  readonly providerContacted = true;
  constructor(message = 'AI did not produce a pipeline configuration') {
    super(message);
    this.name = 'AIEmptyOutputError';
  }
}

// -- Prompt versioning --------------------------------------------------------

const PROMPT_VERSION = '2.0';

// -- Generation types ---------------------------------------------------------

export interface GenerationRequest {
  prompt: string;
  plugins: PluginSummary[];
  orgId: string;
  provider: string;
  model: string;
  apiKey?: string;
  /** Previous config for iterative refinement (conversation memory). */
  previousConfig?: Record<string, unknown>;
  /** Fallback providers to try if primary fails (e.g., ['openai', 'google']). */
  fallbackProviders?: string[];
}

export interface GenerationResult {
  props: Record<string, unknown>;
  description?: string;
  keywords?: string[];
  /** Token usage from the AI call. */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Which provider/model actually served the request. */
  servedBy?: { provider: string; model: string };
  /** Prompt template version used. */
  promptVersion?: string;
  /** Plugin validation warnings (referenced plugins that don't exist). */
  validationWarnings?: string[];
}

// -- Prompt plugin list -------------------------------------------------------

/** `trust: official, health: 92/100, rating: 4.4/5, PAUSED` — only what's known. */
function qualityTags(p: PluginSummary): string {
  const tags: string[] = [];
  if (p.tier) tags.push(`trust: ${p.tier}`);
  if (typeof p.healthScore === 'number') tags.push(`health: ${p.healthScore}/100`);
  if (typeof p.ratingBayes === 'number') tags.push(`rating: ${p.ratingBayes}/5`);
  if (p.lifecycle === 'paused') tags.push('PAUSED (no new installs)');
  if (p.lifecycle === 'unmaintained') tags.push('UNMAINTAINED');
  return tags.join(', ');
}

// Built fresh per call: a process-global cache keyed only on `name:version`
// leaked one org's rendered plugin metadata (descriptions/keywords/env) into
// another org's prompt when they shared name:version pairs. The render is a
// cheap string concat over the (bounded) visible plugin set.
function buildPluginList(plugins: PluginSummary[]): string {
  return plugins.length > 0
    ? plugins.map((p) => {
      let line = `- "${p.name}"${p.publisher ? ` [publisher: "${p.publisher}"]` : ''} (v${p.version}, type: ${p.pluginType}, compute: ${p.computeType})${p.description ? `: ${p.description}` : ''}`;
      const parts: string[] = [];
      const quality = qualityTags(p);
      if (quality) parts.push(quality);
      const keywords = p.keywords ?? [];
      if (keywords.length > 0) parts.push(`keywords: ${keywords.join(', ')}`);
      const category = (p.category || 'unknown').toLowerCase();
      if (category) parts.push(`category: ${category}`);
      const envKeys = Object.keys(p.env ?? {});
      if (envKeys.length > 0) parts.push(`env: ${envKeys.join(', ')}`);
      if (parts.length > 0) line += `\n  ${parts.join(' | ')}`;
      return line;
    }).join('\n')
    : '(No plugins available — use a reasonable default plugin name and note it may need to be created)';
}


// -- System prompt ------------------------------------------------------------

function buildSystemPrompt(plugins: PluginSummary[], previousConfig?: Record<string, unknown>): string {
  const pluginList = buildPluginList(plugins);

  const previousConfigSection = previousConfig
    ? `\n## Previous Configuration (for refinement)\nThe user already has this pipeline config. Modify it based on their new request:\n\`\`\`json\n${JSON.stringify(previousConfig, null, 2).slice(0, 4000)}\n\`\`\`\n`
    : '';

  return `You are a pipeline configuration assistant for an AWS CDK Pipelines platform.

Your job is to convert a user's natural language description of a CI/CD pipeline into a structured pipeline configuration.

${previousConfigSection}## Available Plugins
These are the plugins available for use in the synth step and stage steps. You MUST use plugin names from this list:

${pluginList}

## Configuration Rules

1. **project** and **organization** are required. Infer them from the user's description. Use lowercase with hyphens.
2. **synth** is required and must include:
   - source: one of {type: "github", options: {repo: "owner/repo", branch?: "main"}}, {type: "s3", options: {bucketName: "..."}}, {type: "codestar", options: {repo: "owner/repo", connectionArn: "..."}}, or {type: "codecommit", options: {repositoryName: "..."}}
   - plugin: {name: "cdk-synth", filter: {isDefault: true}} — ALWAYS use "cdk-synth" as the synth plugin with isDefault: true. This is required for all pipelines.
   Optional top-level fields include **role** (custom IAM role with roleArn or roleName) and **schedule** (cron/rate expression for scheduled execution).
3. **stages** are optional arrays of {stageName, steps: [{plugin: {name, filter: {isDefault: true}}, ...}]}
   - Every plugin reference MUST include filter with at minimum isDefault: true
   - A plugin listed with [publisher: "x"] MUST be referenced with publisher: "x" next to its name; never add publisher to any other plugin
   - Optional filter fields: version, visibility ("public"|"private"), isActive
4. For source, default to "github" if the user mentions a repo. Default branch to "main" unless specified.
5. trigger values: "NONE" (default, manual), "AUTO" (automatic on changes), or "SCHEDULE" (cron-based).
6. Step position is "pre" (before deploy, default) or "post" (after deploy).
7. Only include fields the user explicitly or implicitly requested. Omit optional fields with no value.
8. If the user mentions environment variables, include them in the env field of the relevant step.
9. If the user does not specify a pipeline name, omit it (the system will auto-generate one).
10. Choose the most appropriate plugin based on description, keywords, category, and env vars. The list is ordered best-first: when several plugins fit equally, prefer trust "own", then "official", then "verified", then the higher health score; avoid PAUSED or UNMAINTAINED plugins unless the user asks for them by name. Prefer plugins whose keywords match the user's technology stack. Use category to select appropriate plugins for each pipeline stage purpose (e.g., "testing" plugins for test stages, "security" for scan stages). Use failureBehavior on steps when the user indicates a step is optional or should not block the pipeline. Use "defaults.network" when the user mentions VPC, private subnets, or network isolation for CodeBuild. Use "codecommit" source type when the user references an AWS CodeCommit repository.
11. When the user needs Docker in builds (e.g., building Docker images, running containers), include Docker metadata in the global field:
   - "aws:cdk:pipelines:codepipeline:dockerenabledforsynth": true
   - "aws:cdk:codebuild:buildenvironment:privileged": true
12. When the user wants pipeline notifications, include in global metadata:
   - "aws:cdk:notifications:topic:arn": "<SNS topic ARN>"
   - "aws:cdk:notifications:events": "FAILED,SUCCEEDED" (comma-separated list of events)
13. When the user wants a PARAMETERIZED pipeline (values they can change per run/deploy without editing the config), declare those values in the "vars" field with sensible defaults and reference them as {{ pipeline.vars.NAME }} in step commands and env. Omit "vars" entirely for a concrete, non-parameterized pipeline.
14. If the user's description is too vague, make reasonable assumptions and proceed.`;
}

// -- Shared request prelude ---------------------------------------------------

/**
 * Resolve the model and build the system prompt for a generation, logging the
 * request. A BYO key never falls back to a platform provider (see
 * `resolveModelSelection`).
 */
function prepareGeneration(request: GenerationRequest, logMessage: string) {
  const { model, provider, modelId, fallbackFrom } = resolveModelSelection({
    provider: request.provider,
    model: request.model,
    apiKey: request.apiKey,
    fallbacks: request.fallbackProviders,
  });
  if (fallbackFrom) {
    logger.info('Using fallback AI provider', { primary: fallbackFrom, fallback: provider, fallbackModel: modelId });
  }

  logger.info(logMessage, {
    orgId: request.orgId,
    provider,
    model: modelId,
    promptLength: request.prompt.length,
    pluginCount: request.plugins.length,
    promptVersion: PROMPT_VERSION,
    hasConversationContext: !!request.previousConfig,
  });

  return {
    model,
    servedBy: { provider, model: modelId },
    system: buildSystemPrompt(request.plugins, request.previousConfig),
  };
}

// -- Post-generation validation -----------------------------------------------

function validateGeneratedPlugins(
  props: Record<string, unknown>,
  availablePlugins: PluginSummary[],
): string[] {
  const warnings: string[] = [];
  const refKey = (name: string, publisher?: string) => `${publisher ?? ''}/${name}`;
  const pluginRefs = new Set(availablePlugins.map((p) => refKey(p.name, p.publisher)));

  // Enforce cdk-synth as the synth plugin with filter
  const synth = props.synth as { plugin?: { name?: string; filter?: Record<string, unknown> } } | undefined;
  const synthPlugin = synth?.plugin?.name;
  if (synth) {
    if (!synth.plugin) {
      (synth as Record<string, unknown>).plugin = { name: 'cdk-synth', filter: { isDefault: true } };
    } else {
      if (synthPlugin !== 'cdk-synth') {
        warnings.push(`Synth plugin changed from "${synthPlugin}" to "cdk-synth" (required for all pipelines)`);
        synth.plugin.name = 'cdk-synth';
      }
      if (!synth.plugin.filter) {
        synth.plugin.filter = { isDefault: true };
      } else if (synth.plugin.filter.isDefault === undefined) {
        synth.plugin.filter.isDefault = true;
      }
    }
  }

  // Check stage step plugins and enforce filter.isDefault
  const stages = props.stages as Array<{ steps?: Array<{ plugin?: { name?: string; publisher?: string; filter?: Record<string, unknown> } }> }> | undefined;
  if (stages) {
    for (const stage of stages) {
      for (const step of stage.steps ?? []) {
        const name = step.plugin?.name;
        const publisher = step.plugin?.publisher || undefined;
        if (name && !pluginRefs.has(refKey(name, publisher))) {
          warnings.push(`Stage plugin "${publisher ? `${publisher}/` : ''}${name}" not found in available plugins`);
        }
        if (step.plugin) {
          if (!step.plugin.filter) {
            step.plugin.filter = { isDefault: true };
          } else if (step.plugin.filter.isDefault === undefined) {
            step.plugin.filter.isDefault = true;
          }
        }
      }
    }
  }

  return warnings;
}

// -- Main generation function -------------------------------------------------

export async function generatePipelineConfig(request: GenerationRequest): Promise<GenerationResult> {
  const { model, servedBy, system } = prepareGeneration(request, 'Generating pipeline config via AI');

  const result = await generateText({
    model,
    system,
    prompt: request.prompt,
    output: Output.object({ schema: PipelineGenerationSchema }),
  });

  if (!result.output) {
    // Provider round-trip completed but returned nothing usable. Signal
    // provider-contact so the route keeps (does not refund) the aiCalls slot.
    throw new AIEmptyOutputError();
  }

  const { description, keywords, ...props } = result.output;
  const validationWarnings = validateGeneratedPlugins(props, request.plugins);
  const usage = result.usage ?? undefined;

  logger.info('AI pipeline generation completed', {
    orgId: request.orgId,
    provider: servedBy.provider,
    model: servedBy.model,
    project: props.project,
    organization: props.organization,
    stageCount: props.stages?.length ?? 0,
    promptVersion: PROMPT_VERSION,
    ...(usage && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
    ...(validationWarnings.length > 0 && { validationWarnings }),
  });

  return {
    props,
    description: description ?? undefined,
    keywords: keywords ?? undefined,
    usage: usage ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) } : undefined,
    servedBy,
    promptVersion: PROMPT_VERSION,
    validationWarnings: validationWarnings.length > 0 ? validationWarnings : undefined,
  };
}

// -- Streaming generation -----------------------------------------------------

export interface StreamingGenerationResult {
  partialOutputStream: AsyncIterable<Record<string, unknown>>;
  output: PromiseLike<z.infer<typeof PipelineGenerationSchema> | undefined>;
  /** Provider/model that served this request. */
  servedBy: { provider: string; model: string };
  /** Prompt template version used. */
  promptVersion: string;
}

export function streamPipelineConfig(request: GenerationRequest): StreamingGenerationResult {
  const { model, servedBy, system } = prepareGeneration(request, 'Streaming pipeline config via AI');

  const result = streamText({
    model,
    system,
    prompt: request.prompt,
    output: Output.object({ schema: PipelineGenerationSchema }),
  });

  // Enforce the same post-generation guarantees the non-streaming path applies
  // (forces synth.plugin = cdk-synth, injects filter.isDefault). Without this,
  // streamed configs bypass the cdk-synth enforcement before the route's `done`
  // event / autoCreateMissingPlugins. validateGeneratedPlugins mutates in place,
  // so the resolved object the route reads is the enforced one.
  const enforcedOutput = Promise.resolve(result.output).then((resolved) => {
    if (resolved) {
      validateGeneratedPlugins(resolved as Record<string, unknown>, request.plugins);
    }
    return resolved;
  });

  return {
    partialOutputStream: result.partialOutputStream as AsyncIterable<Record<string, unknown>>,
    output: enforcedOutput,
    servedBy,
    promptVersion: PROMPT_VERSION,
  };
}
