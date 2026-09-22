// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  getAvailableProviders,
  getProviderModels,
  resolveModel,
  createModelWithKey,
  generateText,
  streamText,
  Output,
} from '@pipeline-builder/ai-core';
import { createLogger, isSystemOrgId } from '@pipeline-builder/api-core';

import { OFFICIAL_PUBLISHER_HANDLE, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, isNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { availablePluginConditions, findResolvableListings } from './plugin-lookup-service.js';

export { getAvailableProviders, getProviderModels };

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

// -- Types --------------------------------------------------------------------

export interface PluginSummary {
  name: string;
  /**
   * The publisher to write on the reference (plugin ecosystem §3.5): set for a
   * listing an unqualified name wouldn't reach — any non-Official listing, or
   * an Official one the org's own plugin of the same name shadows.
   */
  publisher?: string;
  description: string | null;
  version: string;
  pluginType: string;
  computeType: string;
  commands: string[];
  installCommands: string[];
  keywords: string[];
  category: string;
  metadata: Record<string, string | number | boolean>;
  env: Record<string, string>;
  /**
   * Who stands behind it (plugin ecosystem W7): `own` for the org's own (or
   * parent's shared) plugin, otherwise the trust tier — a system-org catalog
   * row or an Official listing is `official`.
   */
  tier?: PluginTrust;
  /** Bayesian rating (0–5) of a listing, null when unrated or not a listing. */
  ratingBayes?: number | null;
  /** 0–100 health score of a listing (W7), null when unknown. */
  healthScore?: number | null;
  /** `paused` (publisher paused new installs) and `unmaintained` listings are offered last and flagged. */
  lifecycle?: PluginLifecycle;
}

export type PluginTrust = 'own' | 'official' | 'verified' | 'community' | 'unverified';
export type PluginLifecycle = 'active' | 'paused' | 'unmaintained';

// -- Plugin ranking (W7) ------------------------------------------------------

const TRUST_RANK: Record<PluginTrust, number> = { own: 0, official: 1, verified: 2, community: 3, unverified: 4 };

/**
 * Order the candidates the model sees (plugin ecosystem W7): the org's own
 * plugins, then Official, then Verified, then everyone else; within a trust
 * rung, active before paused/unmaintained, then by health score (unknown last).
 * Stable, so equal candidates keep their catalog order. Pure.
 */
export function rankPlugins<T extends Pick<PluginSummary, 'tier' | 'healthScore' | 'lifecycle'>>(plugins: readonly T[]): T[] {
  const trust = (p: T) => (p.tier ? TRUST_RANK[p.tier] : 5);
  const winding = (p: T) => (p.lifecycle && p.lifecycle !== 'active' ? 1 : 0);
  const health = (p: T) => (typeof p.healthScore === 'number' ? p.healthScore : -1);
  return plugins
    .map((p, i) => ({ p, i }))
    .sort((a, b) => trust(a.p) - trust(b.p) || winding(a.p) - winding(b.p) || health(b.p) - health(a.p) || a.i - b.i)
    .map(({ p }) => p);
}

// -- Plugin context helpers ---------------------------------------------------

const UNIVERSAL_CATEGORIES = new Set(['deploy', 'infrastructure', 'notification', 'monitoring']);

const KNOWN_TECH_TERMS = [
  'nodejs', 'node', 'python', 'java', 'go', 'golang', 'ruby', 'dotnet', 'rust', 'php', 'cpp',
  'typescript', 'javascript', 'scala', 'kotlin', 'swift', 'elixir', 'dart',
  'react', 'nextjs', 'next.js', 'angular', 'vue', 'svelte', 'nuxt', 'remix', 'astro',
  'django', 'flask', 'spring', 'express', 'fastapi', 'rails', 'nestjs', 'gin', 'fiber', 'fastify',
  'docker', 'cdk', 'terraform', 'kubernetes', 'helm', 'serverless', 'lambda', 'ecs', 'fargate',
  'cloudformation', 'pulumi', 'aws', 'gcp', 'azure',
  'gradle', 'maven', 'npm', 'yarn', 'pnpm', 'cargo', 'pip', 'poetry', 'composer',
];

/** Filter plugins to those relevant for a detected project context. */
function filterPluginsByContext(plugins: PluginSummary[], terms: string[]): PluginSummary[] {
  const contextTerms = new Set(terms.map(t => t.toLowerCase()));
  if (contextTerms.size === 0) return plugins;

  const filtered = plugins.filter(p => {
    if (UNIVERSAL_CATEGORIES.has((p.category || '').toLowerCase())) return true;
    if ((p.keywords ?? []).some(k => contextTerms.has(k.toLowerCase()))) return true;
    const nameLower = p.name.toLowerCase();
    for (const term of contextTerms) {
      if (nameLower.includes(term)) return true;
    }
    return false;
  });

  return filtered.length > 0 ? filtered : plugins;
}

/**
 * The plugins the given organization can reference: its own (and its parent's
 * shared) rows, plus the LISTINGS it resolves — installed ones and the
 * implicit Official ones (G17). An Official listing is offered by bare name
 * unless the org's own plugin shadows it; every other listing carries its
 * publisher, which the generator must write on the reference.
 */
async function getAvailablePlugins(orgId: string): Promise<PluginSummary[]> {
  const [rows, listings] = await Promise.all([getAvailablePluginRows(orgId), findResolvableListings(orgId)]);
  const ownNames = new Set(rows.map((r) => r.name));
  const listed: PluginSummary[] = listings
    // Never OFFER a deprecated version (W0.4).
    .filter((l) => !l.deprecated)
    .map((l) => {
      const s = l.spec;
      const record = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, never> : {});
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      const qualified = l.publisher !== OFFICIAL_PUBLISHER_HANDLE || ownNames.has(l.name);
      const tier: PluginTrust = (['official', 'verified', 'community', 'unverified'] as const).find((t) => t === l.tier) ?? 'unverified';
      const lifecycle: PluginLifecycle = l.paused ? 'paused' : l.unmaintained ? 'unmaintained' : 'active';
      return {
        name: l.name,
        ...(qualified ? { publisher: l.publisher } : {}),
        description: l.description,
        version: l.version,
        pluginType: typeof s.pluginType === 'string' ? s.pluginType : 'CodeBuildStep',
        computeType: typeof s.computeType === 'string' ? s.computeType : 'SMALL',
        commands: strings(s.commands),
        installCommands: strings(s.installCommands),
        keywords: l.keywords,
        category: l.category,
        metadata: record(s.metadata),
        env: record(s.env),
        tier,
        ratingBayes: l.ratingBayes,
        healthScore: l.healthScore,
        lifecycle,
      };
    });
  return rankPlugins([...rows, ...listed]);
}

/** The org's own (and parent's shared) active plugin rows. */
async function getAvailablePluginRows(orgId: string): Promise<PluginSummary[]> {
  // withTenantTx sets `app.org_id` — the `plugins` table is FORCE ROW LEVEL
  // SECURITY, so a bare `db.select()` runs with a null GUC and the policy drops
  // the caller org's rows (AI context would miss the org's own plugins).
  const rows = await withTenantTx(async (tx) => tx
    .select({
      orgId: schema.plugin.orgId,
      name: schema.plugin.name,
      description: schema.plugin.description,
      version: schema.plugin.version,
      pluginType: schema.plugin.pluginType,
      computeType: schema.plugin.computeType,
      commands: schema.plugin.commands,
      installCommands: schema.plugin.installCommands,
      keywords: schema.plugin.keywords,
      category: schema.plugin.category,
      metadata: schema.plugin.metadata,
      env: schema.plugin.env,
    })
    .from(schema.plugin)
    .where(and(
      ...availablePluginConditions(orgId),
      // Never OFFER a deprecated or yanked version (plugin-ecosystem W0.4): the
      // AI would wire new pipelines onto something on its way out. Existing
      // references still resolve (with a warning) through /plugins/lookup.
      isNull(schema.plugin.deprecatedAt),
      isNull(schema.plugin.yankedAt),
      notInArray(schema.plugin.lifecycle, ['deprecated', 'yanked']),
    ))) as Array<Omit<PluginSummary, 'tier'> & { orgId?: string | null }>;
  // The system org's shared catalog rows are the Official plugins; the rest are the org's own.
  return rows.map(({ orgId: rowOrg, ...p }) => ({ ...p, tier: rowOrg && isSystemOrgId(rowOrg) ? 'official' : 'own', lifecycle: 'active' }));
}

/**
 * Fetch plugins for an org and filter by detected context.
 * For prompt-based routes, extracts tech terms from the prompt text.
 * For URL-based routes, uses repo analysis results.
 */
export async function getFilteredPlugins(
  orgId: string,
  context: { prompt: string } | { languages: string[]; frameworks: string[]; projectType: string },
): Promise<PluginSummary[]> {
  const allPlugins = await getAvailablePlugins(orgId);

  const terms = 'prompt' in context
    ? KNOWN_TECH_TERMS.filter(t => context.prompt.toLowerCase().includes(t))
    : [...context.languages, ...context.frameworks, context.projectType].filter(Boolean);

  return terms.length > 0 ? filterPluginsByContext(allPlugins, terms) : allPlugins;
}

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

// Zod Schema — BuilderProps structure for structured AI output

const PluginFilterSchema = z.object({
  version: z.string().optional().describe('Semantic version of the plugin'),
  visibility: z.enum(['public', 'private']).optional().describe('Plugin visibility'),
  isActive: z.boolean().optional().describe('Whether the plugin is active'),
  isDefault: z.boolean().optional().describe('Whether to use the default version of this plugin'),
}).optional().describe('Optional filter criteria for plugin resolution');

const PluginOptionsSchema = z.object({
  name: z.string().describe('Plugin name (must match an available plugin)'),
  publisher: z.string().optional().describe('The plugin\'s publisher, exactly as listed — ONLY for a plugin listed with a publisher'),
  alias: z.string().optional().describe('Optional alias for the plugin instance'),
  filter: PluginFilterSchema.describe('Plugin filter — set isDefault: true to use the default version'),
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
      trigger: z.enum(['NONE', 'AUTO', 'SCHEDULE']).optional().describe('Trigger behavior'),
    }),
  }),
  z.object({
    type: z.literal('s3'),
    options: z.object({
      bucketName: z.string().describe('S3 bucket name'),
      objectKey: z.string().optional().describe('Object key, defaults to "source.zip"'),
      trigger: z.enum(['NONE', 'AUTO', 'SCHEDULE']).optional(),
    }),
  }),
  z.object({
    type: z.literal('codestar'),
    options: z.object({
      repo: z.string().describe('Repository in format "owner/repo"'),
      branch: z.string().optional().describe('Branch name, defaults to "main"'),
      connectionArn: z.string().describe('CodeStar connection ARN'),
      trigger: z.enum(['NONE', 'AUTO', 'SCHEDULE']).optional(),
      codeBuildCloneOutput: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('codecommit'),
    options: z.object({
      repositoryName: z.string().describe('CodeCommit repository name'),
      branch: z.string().optional().describe('Branch name, defaults to "main"'),
      trigger: z.enum(['NONE', 'AUTO', 'SCHEDULE']).optional(),
    }),
  }),
]);

const StageStepSchema = StepCustomizationSchema.extend({
  plugin: PluginOptionsSchema,
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  position: z.enum(['pre', 'post']).optional().describe('Step position: "pre" (before deploy) or "post" (after deploy)'),
  timeout: z.number().optional().describe('CodeBuild timeout in minutes'),
  failureBehavior: z.enum(['fail', 'warn', 'ignore']).optional().describe('What happens when this step fails: fail (stop), warn (log and continue), ignore (silent continue)'),
  inputArtifact: z.string().optional().describe('Name of a previous stage step to use as input artifact for cross-stage file passing'),
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
  vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Pipeline-level variables referenced as {{ pipeline.vars.NAME }} in step commands/env — populate ONLY when the user asks for a parameterized pipeline, declaring each variable here with a sensible default'),
  role: z.object({
    roleArn: z.string().optional().describe('ARN of an existing IAM role for the pipeline'),
    roleName: z.string().optional().describe('Name of an existing IAM role to look up'),
  }).optional().describe('Custom IAM role for the CodePipeline'),
  schedule: z.string().optional().describe('Cron or rate expression for scheduled pipeline execution (e.g., "rate(1 day)" or "cron(0 0 * * ? *)")'),
  defaults: z.object({
    network: z.object({
      vpcId: z.string().optional().describe('VPC ID for CodeBuild actions'),
      subnetIds: z.array(z.string()).optional().describe('Subnet IDs for CodeBuild'),
    }).optional(),
  }).optional().describe('Pipeline-level CodeBuild defaults'),
});

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

// -- Model resolution with fallback -------------------------------------------

function resolveModelWithFallback(
  provider: string,
  model: string,
  apiKey?: string,
  fallbacks?: string[],
): { model: ReturnType<typeof resolveModel>; provider: string; model_id: string } {
  // Try primary provider
  try {
    const resolved = apiKey
      ? createModelWithKey(provider, model, apiKey)
      : resolveModel(provider, model);
    return { model: resolved, provider, model_id: model };
  } catch (primaryError) {
    // BYO key: NEVER fall back to a platform-configured provider. The fallback
    // path below resolves models from the platform's env-configured keys
    // (`resolveModel`), which would silently spend the platform's AI budget on a
    // request the caller intended to bill to their own key. A BYO failure is
    // terminal — surface it rather than quietly switching to a platform key.
    if (apiKey) throw primaryError;
    if (!fallbacks?.length) throw primaryError;

    // Try fallback providers with their default model
    for (const fallbackProvider of fallbacks) {
      try {
        const providers = getAvailableProviders();
        const providerInfo = providers.find(p => p.id === fallbackProvider);
        if (!providerInfo?.models?.length) continue;
        const fallbackModel = providerInfo.models[0].id;
        const resolved = resolveModel(fallbackProvider, fallbackModel);
        logger.info('Using fallback AI provider', { primary: provider, fallback: fallbackProvider, fallbackModel });
        return { model: resolved, provider: fallbackProvider, model_id: fallbackModel };
      } catch {
        continue;
      }
    }
    throw primaryError;
  }
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
  const { model, provider, model_id } = resolveModelWithFallback(
    request.provider, request.model, request.apiKey, request.fallbackProviders,
  );
  const systemPrompt = buildSystemPrompt(request.plugins, request.previousConfig);

  logger.info('Generating pipeline config via AI', {
    orgId: request.orgId,
    provider,
    model: model_id,
    promptLength: request.prompt.length,
    pluginCount: request.plugins.length,
    promptVersion: PROMPT_VERSION,
    hasConversationContext: !!request.previousConfig,
  });

  const result = await generateText({
    model,
    system: systemPrompt,
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
    provider,
    model: model_id,
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
    servedBy: { provider, model: model_id },
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
  const { model, provider, model_id } = resolveModelWithFallback(
    request.provider, request.model, request.apiKey, request.fallbackProviders,
  );
  const systemPrompt = buildSystemPrompt(request.plugins, request.previousConfig);

  logger.info('Streaming pipeline config via AI', {
    orgId: request.orgId,
    provider,
    model: model_id,
    promptLength: request.prompt.length,
    pluginCount: request.plugins.length,
    promptVersion: PROMPT_VERSION,
    hasConversationContext: !!request.previousConfig,
  });

  const result = streamText({
    model,
    system: systemPrompt,
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
    servedBy: { provider, model: model_id },
    promptVersion: PROMPT_VERSION,
  };
}
