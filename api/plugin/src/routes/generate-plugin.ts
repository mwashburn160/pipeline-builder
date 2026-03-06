import {
  createLogger,
  errorMessage,
  sendBadRequest,
  sendInternalError,
  sendSuccess,
  validateBody,
  AIGenerateBodySchema,
} from '@mwashburn160/api-core';
import { withRoute } from '@mwashburn160/api-server';
import { CoreConstants } from '@mwashburn160/pipeline-core';
import { Router } from 'express';

import { getAvailableProviders, generatePluginConfig, streamPluginConfig } from '../services/ai-plugin-generation-service';

const logger = createLogger('generate-plugin');

const SSE_STREAM_TIMEOUT_MS = CoreConstants.SSE_STREAM_TIMEOUT_MS;

/** Set SSE response headers and flush. */
function initSSEStream(req: import('express').Request, res: import('express').Response): { aborted: () => boolean } {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setTimeout(SSE_STREAM_TIMEOUT_MS);
  res.flushHeaders();
  let _aborted = false;
  req.on('close', () => { _aborted = true; });
  return { aborted: () => _aborted };
}

/** Classify AI generation errors and send the appropriate HTTP response. */
function handleAIError(res: import('express').Response, message: string, fallbackMessage: string) {
  if (!res.headersSent) {
    if (message.includes('not configured') || message.includes('API key')) {
      return sendInternalError(res, 'AI generation is not configured for the requested provider');
    }
    if (message.includes('not available for provider')) {
      return sendBadRequest(res, message);
    }
    return sendInternalError(res, fallbackMessage, { details: message });
  }
  res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
  res.end();
}

/**
 * Create and register AI plugin generation routes.
 *
 * @returns Express Router with AI generation endpoints
 */
export function createGeneratePluginRoutes(): Router {
  const router: Router = Router();

  // -- GET /providers — list configured AI providers --------------------------
  router.get('/providers', withRoute(async ({ res }) => {
    const providers = getAvailableProviders();
    return sendSuccess(res, 200, { providers });
  }, { requireOrgId: false }));

  // -- POST /generate — generate plugin config from natural language ----------
  router.post('/generate', withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, AIGenerateBodySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error);
    }
    const { prompt, provider, model, apiKey } = validation.value;

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
        ...(apiKey ? { apiKey } : {}),
      });

      ctx.log('COMPLETED', 'AI plugin generation completed');

      return sendSuccess(res, 200, {
        config: result.config,
        dockerfile: result.dockerfile,
      });
    } catch (error) {
      const message = errorMessage(error);
      logger.error('AI plugin generation failed', { requestId: ctx.requestId, error: message });
      return handleAIError(res, message, 'Failed to generate plugin configuration');
    }
  }));

  // -- POST /generate/stream — stream plugin config as SSE events -------------
  router.post('/generate/stream', withRoute(async ({ req, res, ctx, orgId }) => {
    const validation = validateBody(req, AIGenerateBodySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error);
    }
    const { prompt, provider, model, apiKey } = validation.value;

    try {
      ctx.log('INFO', 'AI plugin streaming generation requested', {
        promptLength: prompt.length,
        provider,
        model,
      });

      const sse = initSSEStream(req, res);

      const result = streamPluginConfig({
        prompt: prompt.trim(),
        orgId,
        provider,
        model,
        ...(apiKey ? { apiKey } : {}),
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
        }
        res.write('data: [DONE]\n\n');
      }

      res.end();
    } catch (error) {
      const message = errorMessage(error);
      logger.error('AI plugin streaming generation failed', { requestId: ctx.requestId, error: message });
      handleAIError(res, message, 'Failed to stream plugin configuration');
    }
  }));

  return router;
}
