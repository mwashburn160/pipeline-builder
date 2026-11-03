// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
  requirePermission,
  sendBadRequest,
  sendSuccess,
  validateBody,
  AIGenerateBodySchema,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withAiCallReservation, withRoute, rateLimitByOrg } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router, type Request } from 'express';

import { GenerationRun, type GenerationModelRequest } from '../services/ai-generation-run.js';
import { getAvailableProviders, generatePluginConfig, streamPluginConfig } from '../services/ai-plugin-generation-service.js';
import { findSimilarPlugins } from '../services/similar-plugin-lookup.js';

const logger = createLogger('generate-plugin');

/**
 * Per-org burst cap on the expensive LLM generation routes
 * (env: `PLUGIN_GENERATE_RATE_LIMIT_PER_MIN`).
 *
 * ONE limiter instance, mounted on BOTH `/generate` and `/generate/stream`.
 * Two instances sharing the `plugin-generate` name agree only when a Redis
 * store backs them (they then address one namespaced bucket); with no Redis,
 * `createSharedRateLimitStore` returns undefined and each instance gets its own
 * in-memory store — two buckets, so twice the intended allowance. Sharing the
 * instance makes the ceiling identical with or without Redis, which is why this
 * is not a retune: against a configured Redis, behaviour is unchanged.
 *
 * To actually raise the ceiling, set the env var — never rely on the split.
 */
const generateRateLimit = rateLimitByOrg({
  name: 'plugin-generate',
  max: envInt('PLUGIN_GENERATE_RATE_LIMIT_PER_MIN', 20, { min: 1 }),
  windowMs: 60_000,
  message: 'Too many plugin generation requests, please slow down.',
});

/** The caller's parent-org id (org→team hierarchy), carried in the JWT; absent for root orgs. */
function parentOrgIdOf(req: Request): string | undefined {
  return (req.user as { parentOrganizationId?: string } | undefined)?.parentOrganizationId;
}

/** The caller's tier, for the token metric's label. */
function tierOf(req: Request): string | undefined {
  return (req.user as { tier?: string } | undefined)?.tier;
}

/**
 * Create and register AI plugin generation routes.
 *
 * Every generation:
 *  - is refused outright for an org whose administrators switched AI off
 *    (`requireOrgAIEnabled`, mounted BEFORE the quota reservation so a disabled
 *    org is never charged);
 *  - runs on the model `resolveOrgModelSelection` picks — the caller's own key
 *    (`apiKey`), else the org's configured key, else the platform's — with
 *    platform-key failover (`fallbackProviders`, else the platform chain);
 *  - resolves that model BEFORE reserving, then consumes its `aiCalls` slot via
 *    {@link withAiCallReservation} (a service-minted token — the quota
 *    `/increment` endpoint rejects user principals): the model's weight in units,
 *    or nothing for a BYOK key / impersonation session / weight-0 model. KEPT
 *    once the provider responded and refunded only when it was never reached;
 *  - is bounded by the shared per-call policy (timeout + the client's disconnect,
 *    output cap, retries) and recorded as one `plugin.ai.generate` audit row.
 *
 * The `ai_generation` feature gate and the permission gate (`plugins:read` to
 * list providers, `plugins:write` to generate a draft) are attached to each
 * route here, not to the parent '/plugins' mount, so they can't leak onto
 * sibling `GET /plugins` reads. Auth + orgId is still applied at the mount in
 * app-routes.ts, which reads require anyway.
 *
 * Both generate routes first look up the closest existing catalog plugins
 * (`findSimilarPlugins`, fail-soft to `[]`), tell the model not to duplicate
 * them, and return them as `similarPlugins` (the `done` event's data on the
 * stream) so the UI can point the user at a plugin to reuse.
 *
 * @returns Express Router with AI generation endpoints
 */
export function createGeneratePluginRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();
  const reservation = (req: Request, orgId: string, res: import('express').Response, logWarn: (message: string, data?: unknown) => void, run: GenerationRun, request: GenerationModelRequest) =>
    ({ quotaService, orgId, serviceName: 'plugin', res, logWarn, req, feature: 'plugin-generate' as const, resolve: () => run.resolve(request) });

  // -- GET /providers list configured AI providers --------------------------
  router.get('/providers', requireFeature('ai_generation'), requirePermission('plugins:read'), withRoute(async ({ res }) => {
    const providers = getAvailableProviders();
    return sendSuccess(res, 200, { providers });
  }));

  // -- POST /generate generate plugin config from natural language ----------
  router.post('/generate', requireFeature('ai_generation'), requirePermission('plugins:write'), requireOrgAIEnabled, generateRateLimit, audited('plugin.ai.generate'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, AIGenerateBodySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error);
    }
    const { prompt, provider, model, apiKey, fallbackProviders } = validation.value;
    const run = new GenerationRun({ route: 'generate', orgId, userId, tier: tierOf(req), promptLength: prompt.length, log: ctx.log });
    const signal = clientAbortSignal(res);

    const modelRequest: GenerationModelRequest = { provider, model, apiKey, fallbackProviders };
    await withAiCallReservation(reservation(req, orgId, res, ctx.log.bind(null, 'WARN'), run, modelRequest), async (slot) => {
      run.bind(slot);
      ctx.log('INFO', 'AI plugin generation requested', { promptLength: prompt.length, provider, model });

      const similarPlugins = await findSimilarPlugins(prompt, orgId, parentOrgIdOf(req));
      const result = await run.run(modelRequest, (selection) =>
        generatePluginConfig({ prompt: prompt.trim(), orgId, similarPlugins }, { selection, signal, onProviderResponse: run.markResponded }));

      run.succeed(result.usage, { dockerfileViolations: result.dockerfileViolations.length });
      ctx.log('COMPLETED', 'AI plugin generation completed', { servedBy: result.servedBy, tokens: result.usage.totalTokens });

      // The catalog Dockerfile rules the draft breaks (empty when compliant):
      // returned, never accepted silently.
      sendSuccess(res, 200, {
        config: result.config,
        dockerfile: result.dockerfile,
        dockerfileViolations: result.dockerfileViolations,
        similarPlugins,
        usage: result.usage,
        servedBy: result.servedBy,
        promptVersion: result.promptVersion,
      });
    }, (error) => {
      run.fail({ error });
      logger.error('AI plugin generation failed', { requestId: ctx.requestId, error: errorMessage(error) });
      handleAIError(res, error, 'Failed to generate plugin configuration');
    });
  }));

  // -- POST /generate/stream stream plugin config as SSE events -------------
  router.post('/generate/stream', requireFeature('ai_generation'), requirePermission('plugins:write'), requireOrgAIEnabled, generateRateLimit, audited('plugin.ai.generate'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const validation = validateBody(req, AIGenerateBodySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error);
    }
    const { prompt, provider, model, apiKey, fallbackProviders } = validation.value;
    const run = new GenerationRun({ route: 'generate-stream', orgId, userId, tier: tierOf(req), promptLength: prompt.length, log: ctx.log });

    const modelRequest: GenerationModelRequest = { provider, model, apiKey, fallbackProviders };
    await withAiCallReservation(reservation(req, orgId, res, ctx.log.bind(null, 'WARN'), run, modelRequest), async (slot) => {
      run.bind(slot);
      ctx.log('INFO', 'AI plugin streaming generation requested', { promptLength: prompt.length, provider, model });

      const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);
      const similarPlugins = await findSimilarPlugins(prompt, orgId, parentOrgIdOf(req));

      // The whole stream runs inside the failover: a platform provider that fails
      // retryably BEFORE its first chunk is retried on the next one.
      const outcome = await run.run(modelRequest, async (selection) => {
        const result = streamPluginConfig({ prompt: prompt.trim(), orgId, similarPlugins }, { selection, signal: sse.signal, onProviderResponse: run.markResponded });
        for await (const partialObject of result.partialOutputStream) {
          if (sse.aborted()) break;
          try {
            sse.send({ type: 'partial', data: partialObject });
          } catch (serializeError) {
            logger.warn('Failed to serialize partial object', { requestId: ctx.requestId, error: errorMessage(serializeError) });
          }
        }
        if (sse.aborted()) return { completed: false as const };
        const final = await result.final;
        const usage = await result.usage;
        if (final) {
          sse.send({
            type: 'done',
            data: { ...final, similarPlugins, usage, servedBy: result.servedBy, promptVersion: result.promptVersion },
          });
        }
        return { completed: true as const, usage, empty: !final };
      });

      // The slot needs no handling here: it was marked consumed on the provider's
      // first chunk, so a COMPLETED stream keeps it even when the final output is
      // empty/unparseable, and an abort refunds it only if the provider never responded.
      if (outcome.completed) {
        run.succeed(outcome.usage, { emptyOutput: outcome.empty });
        sse.done();
      } else {
        // The client left before the final output: refund — a no-op when the
        // provider already responded (the slot was marked consumed).
        slot.refund();
        run.fail({ aborted: true });
      }
      res.end();
    }, (error) => {
      run.fail({ error });
      logger.error('AI plugin streaming generation failed', { requestId: ctx.requestId, error: errorMessage(error) });
      handleAIError(res, error, 'Failed to stream plugin configuration');
    });
  }));

  return router;
}
