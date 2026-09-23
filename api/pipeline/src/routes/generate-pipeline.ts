// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getAvailableProviders } from '@pipeline-builder/ai-core';
import {
  createLogger,
  envInt,
  errorMessage,
  handleAIError,
  initSSEStream,
  requireFeature,
  sendBadRequest,
  sendSuccess,
  validateBody,
  AIGenerateBodySchema,
  AIGenerateFromUrlBodySchema,
  requirePermission,
} from '@pipeline-builder/api-core';
import type { QuotaService, SseStream } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute, rateLimitByOrg, withQuotaReservation, type QuotaSlot } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import {
  generatePipelineConfig,
  streamPipelineConfig,
  type GenerationResult,
  type StreamingGenerationResult,
} from '../services/ai-generation-service.js';
import { autoCreateMissingPlugins } from '../services/auto-plugin-service.js';
import { parseGitUrl, analyzeRepository, buildEnhancedPrompt } from '../services/git-analysis-service.js';
import { getFilteredPlugins } from '../services/plugin-catalog.js';

const logger = createLogger('generate-pipeline');

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
type CompletionLog = (level: 'COMPLETED', message: string, meta?: Record<string, unknown>) => void;

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

/** Yield every partial from the provider stream, marking the slot's provider
 *  contact on the FIRST one — proof the provider responded (and its $ cost was
 *  incurred). */
async function* markingContact<T>(stream: AsyncIterable<T>, markProviderContacted: () => void): AsyncIterable<T> {
  for await (const p of stream) {
    markProviderContacted();
    yield p;
  }
}

/**
 * Stream the provider's partials and then, unless the client left first, the
 * final `done` event. `completed: false` means the client aborted before the
 * final output — it never consumed the LLM output, so the caller refunds the
 * slot. `props` is null when the provider produced no final object.
 */
async function streamGeneration(
  result: StreamingGenerationResult,
  sse: SseStream,
  slot: QuotaSlot,
  requestId: string,
): Promise<{ completed: false } | { completed: true; props: Record<string, unknown> | null }> {
  await streamPartials(markingContact(result.partialOutputStream, slot.markConsumed), sse, requestId);
  if (sse.aborted()) return { completed: false };

  const finalOutput = await result.output;
  if (!finalOutput) return { completed: true, props: null };

  const { description, keywords, ...props } = finalOutput;
  sse.send({
    type: 'done',
    data: {
      props,
      description: description ?? undefined,
      keywords: keywords ?? undefined,
      servedBy: result.servedBy,
      promptVersion: result.promptVersion,
    },
  });
  return { completed: true, props };
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

/** Completion log line for a non-streaming generation. */
function logGenerationCompleted(log: CompletionLog, message: string, pluginCount: number, result: GenerationResult): void {
  log('COMPLETED', message, {
    pluginCount,
    ...(result.servedBy && { servedBy: result.servedBy }),
    ...(result.usage && { tokens: result.usage.totalTokens }),
  });
}

/** Failure handler for a guarded generation: log, then map to the client error. */
function onGenerationError(requestId: string, logMessage: string, clientMessage: string, res: ExpressResponse) {
  return (error: unknown): void => {
    const message = errorMessage(error);
    logger.error(logMessage, { requestId, error: message });
    handleAIError(res, message, clientMessage);
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

/**
 * Create and register AI pipeline generation routes.
 *
 * AI calls consume the org's dedicated `aiCalls` quota (reserved atomically
 * per generate via {@link withQuotaReservation}), bounding AI usage by the
 * per-org, per-tier budget so an org can't spam the platform AI provider key
 * beyond their tier.
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
    rateLimitByOrg({
      name: 'pipeline-generate',
      max: envInt('PIPELINE_GENERATE_RATE_LIMIT_PER_MIN', 20, { min: 1 }),
      windowMs: 60_000,
      message: 'Too many pipeline generation requests, please slow down.',
    }),
  ];

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
    withRoute(async ({ req, res, ctx, orgId }) => {
      const validation = validateBody(req, AIGenerateBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { prompt, provider, model, apiKey, previousConfig, fallbackProviders } = validation.value;

      // Non-streaming: the provider is contacted inside generatePipelineConfig, so
      // a failure there refunds — except AIEmptyOutputError, which carries
      // `providerContacted` (round-trip completed, $ incurred) and keeps the slot.
      await withQuotaReservation({ quotaService, orgId, type: 'aiCalls', res, logWarn: ctx.log.bind(null, 'WARN') }, async () => {
        ctx.log('INFO', 'AI pipeline generation requested', { promptLength: prompt.length, provider, model });

        const plugins = await getFilteredPlugins(orgId, { prompt });

        const result = await generatePipelineConfig({
          prompt: prompt.trim(),
          plugins,
          orgId,
          provider,
          model,
          ...(apiKey ? { apiKey }: {}),
          ...(previousConfig ? { previousConfig }: {}),
          ...(fallbackProviders ? { fallbackProviders }: {}),
        });

        logGenerationCompleted(ctx.log, 'AI pipeline generation completed', plugins.length, result);
        sendSuccess(res, 200, generationResponse(result));
      }, onGenerationError(ctx.requestId, 'AI pipeline generation failed', 'Failed to generate pipeline configuration', res));
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
    withRoute(async ({ req, res, ctx, orgId }) => {
      const validation = validateBody(req, AIGenerateBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { prompt, provider, model, apiKey } = validation.value;

      await withQuotaReservation({ quotaService, orgId, type: 'aiCalls', res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
        ctx.log('INFO', 'AI pipeline streaming generation requested', { promptLength: prompt.length, provider, model });

        const plugins = await getFilteredPlugins(orgId, { prompt });

        const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);

        const result = streamPipelineConfig({
          prompt: prompt.trim(),
          plugins,
          orgId,
          provider,
          model,
          ...(apiKey ? { apiKey }: {}),
        });

        const outcome = await streamGeneration(result, sse, slot, ctx.requestId);
        if (outcome.completed) {
          sse.done();
        } else {
          slot.refund();
        }

        res.end();
      }, onGenerationError(ctx.requestId, 'AI pipeline streaming generation failed', 'Failed to stream pipeline configuration', res));
    }),
  );

  // -- POST /generate/from-url — analyze Git URL + generate (JSON) ---------
  /**
   * Non-streaming counterpart of `/generate/from-url/stream` for server-side
   * callers — the Ask agent's `propose_pipeline_from_repo` tool. Analyzes the
   * repository and returns the generated config plus the analysis summary in
   * one JSON response.
   *
   * Unlike the streaming route it does NOT auto-create missing plugins: its
   * callers produce reviewable DRAFTS, so this path must have no side effects.
   *
   * Validated with {@link AIGenerateFromUrlBodySchema}.
   */
  router.post( '/generate/from-url',
    ...generateGuards,
    withRoute(async ({ req, res, ctx, orgId }) => {
      const validation = validateBody(req, AIGenerateFromUrlBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { gitUrl, provider, model, apiKey, repoToken } = validation.value;

      const parsed = parseGitUrl(gitUrl);
      if (!parsed) {
        return sendBadRequest(res, 'Invalid Git URL format. Supported: HTTPS, SSH, git@ formats.');
      }

      await withQuotaReservation({ quotaService, orgId, type: 'aiCalls', res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
        // Log only the parsed host/owner/repo — never the raw `gitUrl`, which may
        // embed credentials (parseGitUrl accepts https://user:token@host/...).
        ctx.log('INFO', 'AI pipeline generation from URL requested (JSON)', {
          host: parsed.host,
          owner: parsed.owner,
          repo: parsed.repo,
          provider,
          model,
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
          sendBadRequest(res, `Repository analysis failed: ${msg}`);
          return;
        }

        const plugins = await pluginsForAnalysis(orgId, analysis);

        const result = await generatePipelineConfig({
          prompt: buildEnhancedPrompt(analysis),
          plugins,
          orgId,
          provider,
          model,
          ...(apiKey ? { apiKey } : {}),
        });

        logGenerationCompleted(ctx.log, 'AI pipeline generation from URL completed (JSON)', plugins.length, result);
        sendSuccess(res, 200, generationResponse(result, { analysis: summarizeAnalysis(analysis) }));
      }, onGenerationError(ctx.requestId, 'AI pipeline generation from URL failed', 'Failed to generate pipeline from URL', res));
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
   * - `{type:"checking-plugins"}` / `{type:"creating-plugins"}` — auto-plugin creation
   * - `{type:"error", message:"..."}` — error during processing
   *
   * Validated with {@link AIGenerateFromUrlBodySchema}.
   */
  router.post( '/generate/from-url/stream',
    ...generateGuards,
    withRoute(async ({ req, res, ctx, orgId }) => {
      const validation = validateBody(req, AIGenerateFromUrlBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { gitUrl, provider, model, apiKey, repoToken } = validation.value;

      const parsed = parseGitUrl(gitUrl);
      if (!parsed) {
        return sendBadRequest(res, 'Invalid Git URL format. Supported: HTTPS, SSH, git@ formats.');
      }

      await withQuotaReservation({ quotaService, orgId, type: 'aiCalls', res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
        // Log only the parsed host/owner/repo — never the raw `gitUrl`, which
        // may embed credentials (parseGitUrl accepts https://user:token@host/...).
        ctx.log('INFO', 'AI pipeline generation from URL requested', {
          host: parsed.host,
          owner: parsed.owner,
          repo: parsed.repo,
          provider,
          model,
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
          sse.send({ type: 'error', message: `Repository analysis failed: ${msg}` });
          res.end();
          return;
        }

        if (sse.aborted()) {
          slot.refund();
          res.end();
          return;
        }

        sse.send({ type: 'analyzed', data: summarizeAnalysis(analysis) });

        // Step 2: stream the generation from the analysis-enhanced prompt.
        const plugins = await pluginsForAnalysis(orgId, analysis);

        const result = streamPipelineConfig({
          prompt: buildEnhancedPrompt(analysis),
          plugins,
          orgId,
          provider,
          model,
          ...(apiKey ? { apiKey }: {}),
        });

        const outcome = await streamGeneration(result, sse, slot, ctx.requestId);
        if (outcome.completed) {
          // Step 3: auto-create plugins the config references but the org lacks.
          if (outcome.props && !sse.aborted()) {
            await autoCreateMissingPlugins(outcome.props, orgId, {
              authToken: req.headers.authorization || '',
              requestId: ctx.requestId,
            }, sse.send);
          }
          sse.done();
          // A COMPLETED stream keeps the reserved `aiCalls` slot even when the
          // final output is empty/unparseable — the provider round-trip (and its
          // external $ cost) was incurred. Only an ABORT refunds.
        } else {
          slot.refund();
        }

        res.end();
      }, onGenerationError(ctx.requestId, 'AI pipeline generation from URL failed', 'Failed to generate pipeline from URL', res));
    }),
  );

  return router;
}
