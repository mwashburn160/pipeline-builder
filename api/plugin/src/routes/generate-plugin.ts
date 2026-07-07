// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  createLogger,
  decrementQuota,
  errorMessage,
  handleAIError,
  initSSEStream,
  reserveQuota,
  sendBadRequest,
  sendQuotaExceeded,
  sendSuccess,
  validateBody,
  AIGenerateBodySchema,
} from '@pipeline-builder/api-core';
import type { QuotaService } from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Router } from 'express';

import { getAvailableProviders, generatePluginConfig, streamPluginConfig } from '../services/ai-plugin-generation-service.js';

const logger = createLogger('generate-plugin');

/**
 * Create and register AI plugin generation routes.
 *
 * AI calls consume the org's `apiCalls` quota  until a dedicated `aiCalls`
 * quota type is added, AI usage is bounded by the same per-org budget that
 * gates regular API calls. This prevents an org from spamming the platform
 * AI provider key beyond their tier.
 *
 * @returns Express Router with AI generation endpoints
 */
export function createGeneratePluginRoutes(quotaService: QuotaService): Router {
  const router: Router = Router();

  // -- GET /providers  list configured AI providers --------------------------
  router.get('/providers', withRoute(async ({ res }) => {
    const providers = getAvailableProviders();
    return sendSuccess(res, 200, { providers });
  }, { requireOrgId: false }));

  // -- POST /generate  generate plugin config from natural language ----------
  router.post('/generate', withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, AIGenerateBodySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error);
    }
    const { prompt, provider, model, apiKey } = validation.value;
    const authHeader = req.headers.authorization || '';

    // reserve the aiCalls slot atomically; roll back on LLM failure.
    const reservation = await reserveQuota(quotaService, orgId, 'aiCalls', authHeader);
    if (reservation.exceeded) {
      return sendQuotaExceeded(res, 'aiCalls', reservation.quota, reservation.quota.resetAt);
    }

    try {
      ctx.log('INFO', 'AI plugin generation requested', {
        promptLength: prompt.length,
        provider,
        model,
      });

      const result = await generatePluginConfig({
        prompt: prompt.trim(),
        orgId,
        provider,
        model,
        ...(apiKey ? { apiKey }: {}),
      });

      ctx.log('COMPLETED', 'AI plugin generation completed');

      return sendSuccess(res, 200, {
        config: result.config,
        dockerfile: result.dockerfile,
      });
    } catch (error) {
      const message = errorMessage(error);
      logger.error('AI plugin generation failed', { requestId: ctx.requestId, error: message });
      decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
      return handleAIError(res, message, 'Failed to generate plugin configuration');
    }
  }));

  // -- POST /generate/stream  stream plugin config as SSE events -------------
  router.post('/generate/stream', withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, AIGenerateBodySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error);
    }
    const { prompt, provider, model, apiKey } = validation.value;
    const authHeader = req.headers.authorization || '';

    const reservation = await reserveQuota(quotaService, orgId, 'aiCalls', authHeader);
    if (reservation.exceeded) {
      return sendQuotaExceeded(res, 'aiCalls', reservation.quota, reservation.quota.resetAt);
    }
    let reserved = true;

    try {
      ctx.log('INFO', 'AI plugin streaming generation requested', {
        promptLength: prompt.length,
        provider,
        model,
      });

      const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);

      const result = streamPluginConfig({
        prompt: prompt.trim(),
        orgId,
        provider,
        model,
        ...(apiKey ? { apiKey }: {}),
      });

      for await (const partialObject of result.partialOutputStream) {
        if (sse.aborted()) break;
        try {
          res.write(`data: ${JSON.stringify({ type: 'partial', data: partialObject })}\n\n`);
        } catch (serializeError) {
          logger.warn('Failed to serialize partial object', { requestId: ctx.requestId, error: errorMessage(serializeError) });
        }
      }

      if (!sse.aborted()) {
        // Get final validated output
        const finalOutput = await result.output;
        if (finalOutput) {
          const { dockerfile, ...config } = finalOutput;
          res.write(`data: ${JSON.stringify({
            type: 'done',
            data: {
              config: {
                ...config,
                description: config.description ?? undefined,
                primaryOutputDirectory: config.primaryOutputDirectory ?? undefined,
                env: config.env ?? undefined,
              },
              dockerfile,
            },
          })}\n\n`);
        } else {
          // AI produced no output — refund the reserved aiCalls slot rather than
          // charging the org for an empty generation (mirrors the aborted case).
          decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
          reserved = false;
        }
        res.write('data: [DONE]\n\n');
      } else {
        decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
        reserved = false;
      }

      res.end();
    } catch (error) {
      const message = errorMessage(error);
      logger.error('AI plugin streaming generation failed', { requestId: ctx.requestId, error: message });
      if (reserved) {
        decrementQuota(quotaService, orgId, 'aiCalls', authHeader, ctx.log.bind(null, 'WARN'), 1, reservation.quota.resetAt);
      }
      handleAIError(res, message, 'Failed to stream plugin configuration');
    }
  }));

  return router;
}
