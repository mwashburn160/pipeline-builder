// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getAvailableProviders } from '@pipeline-builder/ai-core';
import {
  audited,
  clientAbortSignal,
  createLogger,
  envInt,
  errorMessage,
  handleAIError,
  initSSEStream,
  requireFeature,
  requireOrgAIEnabled,
  sendBadRequest,
  sendSuccess,
  validateBody,
  AIGenerateBodySchema,
  AIGenerateFromUrlBodySchema,
  AnalyzeFromUrlBodySchema,
  requirePermission,
} from '@pipeline-builder/api-core';
import type { QuotaService, SseStream } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute, rateLimitByOrg, withAiCallReservation } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { GenerationRun, type GenerationRoute } from '../services/ai-generation-run.js';
import {
  generatePipelineConfig,
  streamPipelineConfig,
  type GenerationRequest,
  type GenerationResult,
  type GenerationUsage,
  type StreamingGenerationResult,
} from '../services/ai-generation-service.js';
import { createPlaceholderPlugins, planMissingPlugins } from '../services/auto-plugin-service.js';
import { parseGitUrl, analyzeRepository, buildEnhancedPrompt } from '../services/git-analysis-service.js';
import { getFilteredPlugins } from '../services/plugin-catalog.js';

const logger = createLogger('generate-pipeline');

/**
 * Body of `POST /generate/missing-plugins`: the placeholder names the user
 * confirmed from a `missing-plugins` event. Bounded — a generated config has a
 * handful of stage plugins, never hundreds.
 */
const ConfirmPlaceholderPluginsSchema = z.object({
  plugins: z.array(z.string().min(1).max(100)).min(1).max(25),
});

/**
 * The client-facing summary of a repository analysis — what the from-URL routes
 * return (streamed as the `analyzed` event, or inline in the JSON response).
 */
function summarizeAnalysis(analysis: Awaited<ReturnType<typeof analyzeRepository>>) {
  return {
    owner: analysis.owner,
    repo: analysis.repo,
    provider: analysis.provider,
    defaultBranch: analysis.defaultBranch,
    projectType: analysis.projectType,
    languages: analysis.languages,
    frameworks: analysis.frameworks,
    packageManager: analysis.packageManager,
    hasDockerfile: analysis.hasDockerfile,
    hasCdkJson: analysis.hasCdkJson,
    description: analysis.description,
  };
}

type ExpressResponse = import('express').Response;

/** Stream partial objects from an AI generation result. */
async function streamPartials(stream: AsyncIterable<unknown>, sse: SseStream, requestId: string): Promise<void> {
  for await (const partialObject of stream) {
    if (sse.aborted()) break;
    try {
      sse.send({ type: 'partial', data: partialObject });
    } catch (serializeError) {
      logger.warn('Failed to serialize partial object', { requestId, error: errorMessage(serializeError) });
    }
  }
}

/**
 * Stream the provider's partials and then, unless the client left first, the
 * final `done` event. `completed: false` means the client aborted before the
 * final output. The `aiCalls` slot needs no handling here: it was marked
 * consumed on the provider's first chunk (`onProviderResponse`), so it is kept
 * once the provider responded and refunded by the reservation helper otherwise.
 * `props` is null when the provider produced no final object.
 */
async function streamGeneration(
  result: StreamingGenerationResult,
  sse: SseStream,
  requestId: string,
): Promise<{ completed: false } | { completed: true; props: Record<string, unknown> | null; usage: GenerationUsage }> {
  await streamPartials(result.partialOutputStream, sse, requestId);
  if (sse.aborted()) return { completed: false };

  const final = await result.final;
  const usage = await result.usage;
  if (!final) return { completed: true, props: null, usage };

  sse.send({
    type: 'done',
    data: {
      props: final.props,
      description: final.description,
      keywords: final.keywords,
      validationWarnings: final.validationWarnings,
      usage,
      servedBy: result.servedBy,
      promptVersion: result.promptVersion,
    },
  });
  return { completed: true, props: final.props, usage };
}

/** JSON body of a non-streaming generation (plus any route-specific extras). */
function generationResponse(result: GenerationResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    props: result.props,
    description: result.description,
    keywords: result.keywords,
    ...extra,
    usage: result.usage,
    servedBy: result.servedBy,
    promptVersion: result.promptVersion,
    validationWarnings: result.validationWarnings,
  };
}

/**
 * Failure handler for a guarded generation: settle the run (metrics + audit),
 * log, then answer with the classified error. Takes the ERROR — the provider's
 * HTTP status decides the answer (429/503 with Retry-After, AI_DISABLED, …).
 */
function onGenerationError(run: GenerationRun, requestId: string, logMessage: string, clientMessage: string, res: ExpressResponse) {
  return (error: unknown): void => {
    run.fail({ error });
    logger.error(logMessage, { requestId, error: errorMessage(error) });
    handleAIError(res, error, clientMessage);
  };
}

/** Plugin selection for a repo-analysis prompt. */
function pluginsForAnalysis(orgId: string, analysis: Awaited<ReturnType<typeof analyzeRepository>>) {
  return getFilteredPlugins(orgId, {
    languages: Object.keys(analysis.languages),
    frameworks: analysis.frameworks,
    projectType: analysis.projectType,
  });
}

/** The caller's tier, for the token metric's label. */
function tierOf(req: Request): string | undefined {
  return (req.user as { tier?: string } | undefined)?.tier;
}

/**
 * Create and register AI pipeline generation routes.
 *
 * Every generation:
 *  - is refused outright for an org whose administrators switched AI off
 *    (`requireOrgAIEnabled`, mounted BEFORE the quota reservation so a disabled
 *    org is never charged);
 *  - runs on the model `resolveOrgModelSelection` picks — the caller's own key
 *    (`apiKey`), else the org's configured key, else the platform's — with
 *    platform-key failover (`fallbackProviders`, else the platform chain);
 *  - resolves that model BEFORE reserving, then consumes its `aiCalls` slot
 *    ({@link withAiCallReservation}: the model's weight in units, or nothing for
 *    a BYOK key / impersonation session / weight-0 model), KEPT once the provider
 *    responded and refunded only when it was never reached;
 *  - is bounded by the shared per-call policy (timeout + the client's disconnect,
 *    output cap, retries) and recorded as one `pipeline.ai.generate` audit row.
 *
 * @returns Express Router with AI generation endpoints
 */
export function createGeneratePipelineRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  // Guard chain for every /generate* route. The per-org burst cap on the
  // expensive LLM path (spend protection, on top of the aiCalls quota) is ONE
  // limiter instance shared by all variants, so a tenant can't fan a burst
  // across them — separate instances would each get their own in-memory bucket
  // when no Redis store is configured.
  const generateGuards = [
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:write'),
    requireFeature('ai_generation'),
    requireOrgAIEnabled,
    rateLimitByOrg({
      name: 'pipeline-generate',
      max: envInt('PIPELINE_GENERATE_RATE_LIMIT_PER_MIN', 20, { min: 1 }),
      windowMs: 60_000,
      message: 'Too many pipeline generation requests, please slow down.',
    }),
  ];

  /** A run for this request, labelled with its route. */
  const newRun = (req: Request, route: GenerationRoute, orgId: string, userId: string, promptLength: number, log: GenerationRunLog) =>
    new GenerationRun({ route, orgId, userId, tier: tierOf(req), promptLength, log });

  // -- GET /providers — list configured AI providers ------------------------
  /**
   * Returns the list of AI providers that have API keys configured via
   * environment variables on the pipeline service.
   */
  router.get( '/providers',
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:read'),
    requireFeature('ai_generation'),
    withRoute(async ({ res }) => {
      const providers = getAvailableProviders();
      return sendSuccess(res, 200, { providers });
    }),
  );

  // -- POST /generate — generate pipeline config from natural language ------
  /**
   * Accepts a natural language prompt and returns an AI-generated pipeline
   * configuration (BuilderProps), optional description, and keywords.
   *
   * Validated with {@link AIGenerateBodySchema}.
   */
  router.post( '/generate',
    ...generateGuards,
    audited('pipeline.ai.generate'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const validation = validateBody(req, AIGenerateBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { prompt, previousConfig, ...modelRequest } = validation.value;
      const run = newRun(req, 'generate', orgId, userId, prompt.length, ctx.log);
      const signal = clientAbortSignal(res);

      await withAiCallReservation({ quotaService, orgId, res, logWarn: ctx.log.bind(null, 'WARN'), req, feature: 'pipeline-generate', resolve: () => run.resolve(modelRequest) }, async (slot) => {
        run.bind(slot);
        ctx.log('INFO', 'AI pipeline generation requested', { promptLength: prompt.length, provider: modelRequest.provider, model: modelRequest.model });

        const plugins = await getFilteredPlugins(orgId, { prompt });
        const request: GenerationRequest = { prompt: prompt.trim(), plugins, orgId, ...(previousConfig ? { previousConfig } : {}) };
        const result = await run.run(modelRequest, (selection) =>
          generatePipelineConfig(request, { selection, signal, onProviderResponse: run.markResponded }));

        run.succeed(result.usage, { stageCount: stageCount(result.props) });
        ctx.log('COMPLETED', 'AI pipeline generation completed', { pluginCount: plugins.length, servedBy: result.servedBy, tokens: result.usage.totalTokens });
        sendSuccess(res, 200, generationResponse(result));
      }, onGenerationError(run, ctx.requestId, 'AI pipeline generation failed', 'Failed to generate pipeline configuration', res));
    }),
  );

  // -- POST /generate/stream — stream pipeline config as SSE events --------
  /**
   * Accepts a natural language prompt and streams AI-generated pipeline
   * configuration as SSE events. Each event contains a partial JSON object
   * that progressively builds toward the final configuration.
   *
   * Events: {type:"partial", data:{...}} → {type:"done", data:{props,...}} → [DONE]
   */
  router.post( '/generate/stream',
    ...generateGuards,
    audited('pipeline.ai.generate'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const validation = validateBody(req, AIGenerateBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { prompt, previousConfig, ...modelRequest } = validation.value;
      const run = newRun(req, 'generate-stream', orgId, userId, prompt.length, ctx.log);

      await withAiCallReservation({ quotaService, orgId, res, logWarn: ctx.log.bind(null, 'WARN'), req, feature: 'pipeline-generate', resolve: () => run.resolve(modelRequest) }, async (slot) => {
        run.bind(slot);
        ctx.log('INFO', 'AI pipeline streaming generation requested', { promptLength: prompt.length, provider: modelRequest.provider, model: modelRequest.model });

        const plugins = await getFilteredPlugins(orgId, { prompt });
        const request: GenerationRequest = { prompt: prompt.trim(), plugins, orgId, ...(previousConfig ? { previousConfig } : {}) };

        const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);
        // The whole stream runs inside the failover: a platform provider that
        // fails retryably BEFORE its first chunk is retried on the next one.
        const outcome = await run.run(modelRequest, (selection) =>
          streamGeneration(streamPipelineConfig(request, { selection, signal: sse.signal, onProviderResponse: run.markResponded }), sse, ctx.requestId));

        if (outcome.completed) {
          run.succeed(outcome.usage, { stageCount: stageCount(outcome.props), emptyOutput: outcome.props === null });
          sse.done();
        } else {
          // The client left before the final output: refund — a no-op when the
          // provider already responded (the slot was marked consumed).
          slot.refund();
          run.fail({ aborted: true });
        }
        res.end();
      }, onGenerationError(run, ctx.requestId, 'AI pipeline streaming generation failed', 'Failed to stream pipeline configuration', res));
    }),
  );

  // -- POST /generate/from-url — analyze Git URL + generate (JSON) ---------
  /**
   * Non-streaming counterpart of `/generate/from-url/stream` for server-side
   * callers — the Ask agent's `propose_pipeline_from_repo` tool (its
   * `propose_plugin_from_repo` uses the AI-free `/analyze/from-url`). Analyzes the
   * repository and returns the generated config plus the analysis summary in
   * one JSON response. No side effects: its callers produce reviewable DRAFTS.
   *
   * Validated with {@link AIGenerateFromUrlBodySchema}.
   */
  router.post( '/generate/from-url',
    ...generateGuards,
    audited('pipeline.ai.generate'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const validation = validateBody(req, AIGenerateFromUrlBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { gitUrl, repoToken, ...modelRequest } = validation.value;

      const parsed = parseGitUrl(gitUrl);
      if (!parsed) {
        return sendBadRequest(res, 'Invalid Git URL format. Supported: HTTPS, SSH, git@ formats.');
      }
      const run = newRun(req, 'from-url', orgId, userId, 0, ctx.log);
      const signal = clientAbortSignal(res);

      await withAiCallReservation({ quotaService, orgId, res, logWarn: ctx.log.bind(null, 'WARN'), req, feature: 'pipeline-generate', resolve: () => run.resolve(modelRequest) }, async (slot) => {
        run.bind(slot);
        // Log only the parsed host/owner/repo — never the raw `gitUrl`, which may
        // embed credentials (parseGitUrl accepts https://user:token@host/...).
        ctx.log('INFO', 'AI pipeline generation from URL requested (JSON)', {
          host: parsed.host,
          owner: parsed.owner,
          repo: parsed.repo,
          provider: modelRequest.provider,
          model: modelRequest.model,
          gitProvider: parsed.provider,
        });

        let analysis;
        try {
          analysis = await analyzeRepository(parsed, repoToken);
        } catch (analyzeError) {
          const msg = errorMessage(analyzeError);
          logger.warn('Repository analysis failed', { requestId: ctx.requestId, error: msg });
          // Failed before any LLM call — give the slot back.
          slot.refund();
          run.fail({ analysisFailed: true });
          sendBadRequest(res, `Repository analysis failed: ${msg}`);
          return;
        }

        const plugins = await pluginsForAnalysis(orgId, analysis);
        const prompt = buildEnhancedPrompt(analysis);
        const result = await run.run(modelRequest, (selection) =>
          generatePipelineConfig({ prompt, plugins, orgId }, { selection, signal, onProviderResponse: run.markResponded }));

        run.succeed(result.usage, { gitProvider: parsed.provider, stageCount: stageCount(result.props) });
        ctx.log('COMPLETED', 'AI pipeline generation from URL completed (JSON)', { pluginCount: plugins.length, servedBy: result.servedBy, tokens: result.usage.totalTokens });
        sendSuccess(res, 200, generationResponse(result, { analysis: summarizeAnalysis(analysis) }));
      }, onGenerationError(run, ctx.requestId, 'AI pipeline generation from URL failed', 'Failed to generate pipeline from URL', res));
    }),
  );

  // -- POST /analyze/from-url — repository analysis ONLY (no AI) -----------
  /**
   * The repository analysis the from-URL generators start with — languages,
   * frameworks, package manager, Dockerfile/CDK — WITHOUT a generation: no model
   * call, no `aiCalls` slot (the request is metered on apiCalls like any other,
   * and a call forwarded by the Ask agent carries its on-behalf marker). Exists
   * for the agent's `propose_plugin_from_repo`, which used to run a whole
   * pipeline generation only to keep its `analysis`.
   *
   * Same gate as the generators it feeds (`pipelines:write` + `ai_generation`) —
   * the summary is an input to an AI draft — with its own per-org burst cap
   * (it calls out to the Git provider).
   *
   * Validated with {@link AnalyzeFromUrlBodySchema}.
   */
  router.post( '/analyze/from-url',
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:write'),
    requireFeature('ai_generation'),
    rateLimitByOrg({
      name: 'pipeline-analyze',
      max: envInt('PIPELINE_GENERATE_RATE_LIMIT_PER_MIN', 20, { min: 1 }),
      windowMs: 60_000,
      message: 'Too many repository analysis requests, please slow down.',
    }),
    withRoute(async ({ req, res, ctx }) => {
      const validation = validateBody(req, AnalyzeFromUrlBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { gitUrl, repoToken } = validation.value;
      const parsed = parseGitUrl(gitUrl);
      if (!parsed) {
        return sendBadRequest(res, 'Invalid Git URL format. Supported: HTTPS, SSH, git@ formats.');
      }
      try {
        const analysis = await analyzeRepository(parsed, repoToken);
        // Never the raw `gitUrl` — it may embed credentials.
        ctx.log('COMPLETED', 'Repository analyzed', { host: parsed.host, owner: parsed.owner, repo: parsed.repo, gitProvider: parsed.provider });
        return sendSuccess(res, 200, { analysis: summarizeAnalysis(analysis) });
      } catch (analyzeError) {
        const msg = errorMessage(analyzeError);
        logger.warn('Repository analysis failed', { requestId: ctx.requestId, error: msg });
        return sendBadRequest(res, `Repository analysis failed: ${msg}`);
      }
    }),
  );

  // -- POST /generate/from-url/stream — analyze Git URL + stream pipeline --
  /**
   * Accepts a Git URL, analyzes the repository via the appropriate provider API
   * (GitHub, GitLab, Bitbucket), then streams an AI-generated pipeline config
   * as SSE events.
   *
   * Events
   * - `{type:"analyzing"}` — fetching repo metadata
   * - `{type:"analyzed", data:{...}}` — repo analysis summary
   * - `{type:"partial", data:{...}}` — streaming AI generation partial
   * - `{type:"done", data:{props,...}}` — final generated config
   * - `{type:"checking-plugins"}` → `{type:"missing-plugins", data:{existing, proposed, refused}}` —
   *   which referenced plugins the org lacks. NOTHING is created here: the user
   *   reviews `proposed` and confirms with `POST /generate/missing-plugins`.
   * - `{type:"error", message:"..."}` — error during processing
   *
   * Validated with {@link AIGenerateFromUrlBodySchema}.
   */
  router.post( '/generate/from-url/stream',
    ...generateGuards,
    audited('pipeline.ai.generate'),
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const validation = validateBody(req, AIGenerateFromUrlBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { gitUrl, repoToken, ...modelRequest } = validation.value;

      const parsed = parseGitUrl(gitUrl);
      if (!parsed) {
        return sendBadRequest(res, 'Invalid Git URL format. Supported: HTTPS, SSH, git@ formats.');
      }
      const run = newRun(req, 'from-url-stream', orgId, userId, 0, ctx.log);

      await withAiCallReservation({ quotaService, orgId, res, logWarn: ctx.log.bind(null, 'WARN'), req, feature: 'pipeline-generate', resolve: () => run.resolve(modelRequest) }, async (slot) => {
        run.bind(slot);
        // Log only the parsed host/owner/repo — never the raw `gitUrl`, which
        // may embed credentials (parseGitUrl accepts https://user:token@host/...).
        ctx.log('INFO', 'AI pipeline generation from URL requested', {
          host: parsed.host,
          owner: parsed.owner,
          repo: parsed.repo,
          provider: modelRequest.provider,
          model: modelRequest.model,
          gitProvider: parsed.provider,
        });

        const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);

        // Step 1: analyze the repository.
        sse.send({ type: 'analyzing' });

        let analysis;
        try {
          analysis = await analyzeRepository(parsed, repoToken);
        } catch (analyzeError) {
          const msg = errorMessage(analyzeError);
          logger.warn('Repository analysis failed', { requestId: ctx.requestId, error: msg });
          // Repo analysis failed before any LLM call — roll back the slot.
          slot.refund();
          run.fail({ analysisFailed: true });
          sse.send({ type: 'error', message: `Repository analysis failed: ${msg}` });
          res.end();
          return;
        }

        if (sse.aborted()) {
          slot.refund();
          run.fail({ aborted: true });
          res.end();
          return;
        }

        sse.send({ type: 'analyzed', data: summarizeAnalysis(analysis) });

        // Step 2: stream the generation from the analysis-enhanced prompt.
        const plugins = await pluginsForAnalysis(orgId, analysis);
        const prompt = buildEnhancedPrompt(analysis);
        const outcome = await run.run(modelRequest, (selection) =>
          streamGeneration(streamPipelineConfig({ prompt, plugins, orgId }, { selection, signal: sse.signal, onProviderResponse: run.markResponded }), sse, ctx.requestId));

        if (outcome.completed) {
          // Step 3: report the plugins the config references but the org lacks.
          // A model's output never creates anything by itself — the user confirms.
          let missing: Awaited<ReturnType<typeof planMissingPlugins>> | undefined;
          if (outcome.props && !sse.aborted()) {
            missing = await planMissingPlugins(outcome.props, orgId);
            if (missing.referenced.length > 0) {
              sse.send({ type: 'checking-plugins', data: { plugins: missing.referenced } });
              sse.send({ type: 'missing-plugins', data: { existing: missing.existing, proposed: missing.proposed, refused: missing.refused } });
            }
          }
          run.succeed(outcome.usage, {
            gitProvider: parsed.provider,
            stageCount: stageCount(outcome.props),
            emptyOutput: outcome.props === null,
            proposedPlugins: missing?.proposed.length ?? 0,
          });
          sse.done();
        } else {
          // The client left before the final output: refund — a no-op when the
          // provider already responded (the slot was marked consumed).
          slot.refund();
          run.fail({ aborted: true });
        }

        res.end();
      }, onGenerationError(run, ctx.requestId, 'AI pipeline generation from URL failed', 'Failed to generate pipeline from URL', res));
    }),
  );

  // -- POST /generate/missing-plugins — create CONFIRMED placeholder plugins --
  /**
   * The explicit follow-up to a from-URL generation's `missing-plugins` event:
   * creates placeholder plugins for the names the USER confirmed. The names are
   * re-checked server-side (exists / listed / unsafe are refused whatever the
   * client sent), and each is created through the plugin service AS THE USER —
   * so its own `plugins:write` gate and `plugin.deploy` audit apply. No AI call,
   * no `aiCalls` slot.
   */
  router.post( '/generate/missing-plugins',
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('plugins:write'),
    requireFeature('ai_generation'),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const validation = validateBody(req, ConfirmPlaceholderPluginsSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const result = await createPlaceholderPlugins(validation.value.plugins, orgId, {
        authToken: req.headers.authorization || '',
        requestId: ctx.requestId,
      });
      ctx.log('COMPLETED', 'Confirmed placeholder plugins created', { created: result.created.length, refused: result.builds.filter((b) => b.error).length });
      return sendSuccess(res, 200, result);
    }),
  );

  return router;
}

type GenerationRunLog = (level: 'WARN', message: string, meta?: Record<string, unknown>) => void;

/** Stage count of a generated config, for the audit row. */
function stageCount(props: Record<string, unknown> | null): number {
  return Array.isArray(props?.stages) ? props.stages.length : 0;
}
