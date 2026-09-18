// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  createLogger,
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
import type { QuotaService } from '@pipeline-builder/api-core';
import { createAuthenticatedWithOrgRoute, withRoute, rateLimitByOrg } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';
import { withAiCallsReservation } from '../helpers/ai-calls-reservation.js';
import { getAvailableProviders, getFilteredPlugins, generatePipelineConfig, streamPipelineConfig } from '../services/ai-generation-service.js';
import { autoCreateMissingPlugins } from '../services/auto-plugin-service.js';
import { parseGitUrl, analyzeRepository, buildEnhancedPrompt } from '../services/git-analysis-service.js';

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

/** Stream partial objects from an AI generation result. */
async function streamPartials( stream: AsyncIterable<unknown>,
  res: import('express').Response,
  aborted: () => boolean,
  requestId: string,
): Promise<void> {
  for await (const partialObject of stream) {
    if (aborted()) break;
    try {
      res.write(`data: ${JSON.stringify({ type: 'partial', data: partialObject })}\n\n`);
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
 * Create and register AI pipeline generation routes.
 *
 * AI calls consume the org's dedicated `aiCalls` quota (reserved atomically
 * per generate via {@link withAiCallsReservation}), bounding AI usage by the
 * per-org, per-tier budget so an org can't spam the platform AI provider key
 * beyond their tier.
 *
 * @returns Express Router with AI generation endpoints
 */
export function createGeneratePipelineRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

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
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:write'),
    requireFeature('ai_generation'),
    // Per-org burst cap on the expensive LLM path (spend protection), on top of
    // the aiCalls quota. All /generate* variants share one 'pipeline-generate'
    // bucket so a tenant can't fan a burst across them.
    rateLimitByOrg({ name: 'pipeline-generate', max: 20, windowMs: 60_000, message: 'Too many pipeline generation requests, please slow down.' }),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const validation = validateBody(req, AIGenerateBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { prompt, provider, model, apiKey, previousConfig, fallbackProviders } = validation.value;

      // Non-streaming: the provider is contacted inside generatePipelineConfig, so
      // a failure there refunds — except AIEmptyOutputError, which carries
      // `providerContacted` (round-trip completed, $ incurred) and keeps the slot.
      await withAiCallsReservation({ quotaService, orgId, res, logWarn: ctx.log.bind(null, 'WARN') }, async () => {
        ctx.log('INFO', 'AI pipeline generation requested', {
          promptLength: prompt.length,
          provider,
          model,
        });

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

        ctx.log('COMPLETED', 'AI pipeline generation completed', {
          pluginCount: plugins.length,
          ...(result.servedBy && { servedBy: result.servedBy }),
          ...(result.usage && { tokens: result.usage.totalTokens }),
        });

        sendSuccess(res, 200, {
          props: result.props,
          description: result.description,
          keywords: result.keywords,
          usage: result.usage,
          servedBy: result.servedBy,
          promptVersion: result.promptVersion,
          validationWarnings: result.validationWarnings,
        });
      }, (error) => {
        const message = errorMessage(error);
        logger.error('AI pipeline generation failed', { requestId: ctx.requestId, error: message });
        handleAIError(res, message, 'Failed to generate pipeline configuration');
      });
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
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:write'),
    requireFeature('ai_generation'),
    // Per-org burst cap on the expensive LLM path (spend protection), on top of
    // the aiCalls quota. All /generate* variants share one 'pipeline-generate'
    // bucket so a tenant can't fan a burst across them.
    rateLimitByOrg({ name: 'pipeline-generate', max: 20, windowMs: 60_000, message: 'Too many pipeline generation requests, please slow down.' }),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const validation = validateBody(req, AIGenerateBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { prompt, provider, model, apiKey } = validation.value;

      await withAiCallsReservation({ quotaService, orgId, res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
        ctx.log('INFO', 'AI pipeline streaming generation requested', {
          promptLength: prompt.length,
          provider,
          model,
        });

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

        await streamPartials(markingContact(result.partialOutputStream, slot.markProviderContacted), res, sse.aborted, ctx.requestId);

        if (!sse.aborted()) {
          // Get final validated output
          const finalOutput = await result.output;
          if (finalOutput) {
            const { description, keywords, ...props } = finalOutput;
            res.write(`data: ${JSON.stringify({
              type: 'done',
              data: {
                props,
                description: description ?? undefined,
                keywords: keywords ?? undefined,
                servedBy: result.servedBy,
                promptVersion: result.promptVersion,
              },
            })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
        } else {
          // Aborted before completion — caller never consumed the LLM
          // output, so give the slot back.
          slot.refund();
        }

        res.end();
      }, (error) => {
        const message = errorMessage(error);
        logger.error('AI pipeline streaming generation failed', { requestId: ctx.requestId, error: message });
        handleAIError(res, message, 'Failed to stream pipeline configuration');
      });
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
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:write'),
    requireFeature('ai_generation'),
    // Shares the 'pipeline-generate' burst bucket with every /generate* variant.
    rateLimitByOrg({ name: 'pipeline-generate', max: 20, windowMs: 60_000, message: 'Too many pipeline generation requests, please slow down.' }),
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

      await withAiCallsReservation({ quotaService, orgId, res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
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

        const plugins = await getFilteredPlugins(orgId, {
          languages: Object.keys(analysis.languages),
          frameworks: analysis.frameworks,
          projectType: analysis.projectType,
        });

        const result = await generatePipelineConfig({
          prompt: buildEnhancedPrompt(analysis),
          plugins,
          orgId,
          provider,
          model,
          ...(apiKey ? { apiKey } : {}),
        });

        ctx.log('COMPLETED', 'AI pipeline generation from URL completed (JSON)', {
          pluginCount: plugins.length,
          ...(result.servedBy && { servedBy: result.servedBy }),
          ...(result.usage && { tokens: result.usage.totalTokens }),
        });

        sendSuccess(res, 200, {
          props: result.props,
          description: result.description,
          keywords: result.keywords,
          analysis: summarizeAnalysis(analysis),
          usage: result.usage,
          servedBy: result.servedBy,
          promptVersion: result.promptVersion,
          validationWarnings: result.validationWarnings,
        });
      }, (error) => {
        const message = errorMessage(error);
        logger.error('AI pipeline generation from URL failed', { requestId: ctx.requestId, error: message });
        handleAIError(res, message, 'Failed to generate pipeline from URL');
      });
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
    ...createAuthenticatedWithOrgRoute(),
    requirePermission('pipelines:write'),
    requireFeature('ai_generation'),
    // Per-org burst cap on the expensive LLM path (spend protection), on top of
    // the aiCalls quota. All /generate* variants share one 'pipeline-generate'
    // bucket so a tenant can't fan a burst across them.
    rateLimitByOrg({ name: 'pipeline-generate', max: 20, windowMs: 60_000, message: 'Too many pipeline generation requests, please slow down.' }),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const validation = validateBody(req, AIGenerateFromUrlBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { gitUrl, provider, model, apiKey, repoToken } = validation.value;

      // Parse the Git URL
      const parsed = parseGitUrl(gitUrl);
      if (!parsed) {
        return sendBadRequest(res, 'Invalid Git URL format. Supported: HTTPS, SSH, git@ formats.');
      }

      await withAiCallsReservation({ quotaService, orgId, res, logWarn: ctx.log.bind(null, 'WARN') }, async (slot) => {
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
        const writeEvent = (event: unknown): void => { res.write(`data: ${JSON.stringify(event)}\n\n`); };

        // Phase 1: Analyze repository
        writeEvent({ type: 'analyzing' });

        let analysis;
        try {
          analysis = await analyzeRepository(parsed, repoToken);
        } catch (analyzeError) {
          const msg = errorMessage(analyzeError);
          logger.warn('Repository analysis failed', { requestId: ctx.requestId, error: msg });
          // Repo analysis failed before any LLM call — roll back the slot.
          slot.refund();
          writeEvent({ type: 'error', message: `Repository analysis failed: ${msg}` });
          res.end();
          return;
        }

        if (sse.aborted()) {
          slot.refund();
          res.end();
          return;
        }

        writeEvent({ type: 'analyzed', data: summarizeAnalysis(analysis) });

        // Phase 2: Build enhanced prompt and stream AI generation
        const enhancedPrompt = buildEnhancedPrompt(analysis);
        const plugins = await getFilteredPlugins(orgId, {
          languages: Object.keys(analysis.languages),
          frameworks: analysis.frameworks,
          projectType: analysis.projectType,
        });

        const result = streamPipelineConfig({
          prompt: enhancedPrompt,
          plugins,
          orgId,
          provider,
          model,
          ...(apiKey ? { apiKey }: {}),
        });

        await streamPartials(markingContact(result.partialOutputStream, slot.markProviderContacted), res, sse.aborted, ctx.requestId);

        if (!sse.aborted()) {
          const finalOutput = await result.output;
          if (finalOutput) {
            const { description, keywords, ...props } = finalOutput;
            writeEvent({
              type: 'done',
              data: {
                props,
                description: description ?? undefined,
                keywords: keywords ?? undefined,
                servedBy: result.servedBy,
                promptVersion: result.promptVersion,
              },
            });

            // Phase 3: Auto-create missing plugins
            if (!sse.aborted()) {
              await autoCreateMissingPlugins(props, orgId, {
                authToken: req.headers.authorization || '',
                requestId: ctx.requestId,
              }, writeEvent);
            }
          }
          res.write('data: [DONE]\n\n');
          // Quota policy: a COMPLETED stream keeps the reserved `aiCalls` slot even
          // when `finalOutput` is empty/unparseable — the provider round-trip (and
          // its external $ cost) was incurred. Only an ABORT (client disconnect /
          // pre-provider failure) refunds the slot.
        } else {
          slot.refund();
        }

        res.end();
      }, (error) => {
        const message = errorMessage(error);
        logger.error('AI pipeline generation from URL failed', { requestId: ctx.requestId, error: message });
        handleAIError(res, message, 'Failed to generate pipeline from URL');
      });
    }),
  );

  return router;
}
