/**
 * @module routes/generate-pipeline
 * @description AI-powered pipeline configuration generation.
 *
 * Provides three endpoints for the pipeline AI builder workflow:
 *
 * - **GET /pipelines/providers** — List available AI providers and their models.
 * - **POST /pipelines/generate** — Generate BuilderProps JSON from a natural
 *   language description using the AI SDK.
 * - **POST /pipelines/generate/stream** — Same as above but streams partial
 *   results as SSE events for real-time progressive output.
 *
 * Request validation uses the shared Zod schema from api-core
 * ({@link AIGenerateBodySchema}).
 */

import {
  createLogger,
  errorMessage,
  sendBadRequest,
  sendInternalError,
  sendSuccess,
  validateBody,
  AIGenerateBodySchema,
} from '@mwashburn160/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@mwashburn160/api-server';
import { db, schema } from '@mwashburn160/pipeline-core';
import { eq, or, and, isNull } from 'drizzle-orm';
import { Router } from 'express';
import { getAvailableProviders, generatePipelineConfig, streamPipelineConfig } from '../services/ai-generation-service';

const logger = createLogger('generate-pipeline');

/**
 * Fetch active plugins visible to the given organization (org-scoped + public).
 *
 * These are passed as context to the AI so it can reference real plugin names
 * when generating pipeline configurations.
 *
 * @param orgId - Organization ID to scope the query
 * @returns Array of plugin summaries for AI context
 */
async function getAvailablePlugins(orgId: string) {
  return db
    .select({
      name: schema.plugin.name,
      description: schema.plugin.description,
      version: schema.plugin.version,
      pluginType: schema.plugin.pluginType,
      computeType: schema.plugin.computeType,
      commands: schema.plugin.commands,
      installCommands: schema.plugin.installCommands,
    })
    .from(schema.plugin)
    .where(
      and(
        eq(schema.plugin.isActive, true),
        isNull(schema.plugin.deletedAt),
        or(
          eq(schema.plugin.orgId, orgId),
          eq(schema.plugin.accessModifier, 'public'),
        ),
      ),
    );
}

/**
 * Create and register AI pipeline generation routes.
 *
 * @returns Express Router with AI generation endpoints
 */
export function createGeneratePipelineRoutes(): Router {
  const router: Router = Router();

  // -- GET /providers — list configured AI providers --------------------------
  /**
   * Returns the list of AI providers that have API keys configured via
   * environment variables on the pipeline service.
   */
  router.get(
    '/providers',
    ...createAuthenticatedWithOrgRoute(),
    withRoute(async ({ res }) => {
      const providers = getAvailableProviders();
      return sendSuccess(res, 200, { providers });
    }),
  );

  // -- POST /generate — generate pipeline config from natural language --------
  /**
   * Accepts a natural language prompt and returns an AI-generated pipeline
   * configuration (BuilderProps), optional description, and keywords.
   *
   * Validated with {@link AIGenerateBodySchema}.
   */
  router.post(
    '/generate',
    ...createAuthenticatedWithOrgRoute(),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const validation = validateBody(req, AIGenerateBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { prompt, provider, model, apiKey } = validation.value;

      try {
        ctx.log('INFO', 'AI pipeline generation requested', {
          promptLength: prompt.length,
          provider,
          model,
        });

        // Fetch available plugins for context
        const plugins = await getAvailablePlugins(orgId);

        const result = await generatePipelineConfig({
          prompt: prompt.trim(),
          plugins,
          orgId,
          provider,
          model,
          ...(apiKey ? { apiKey } : {}),
        });

        ctx.log('COMPLETED', 'AI pipeline generation completed');

        return sendSuccess(res, 200, {
          props: result.props,
          description: result.description,
          keywords: result.keywords,
        });
      } catch (error) {
        const message = errorMessage(error);
        logger.error('AI pipeline generation failed', {
          requestId: ctx.requestId,
          error: message,
        });

        if (message.includes('not configured') || message.includes('API key')) {
          return sendInternalError(res, 'AI generation is not configured for the requested provider');
        }
        if (message.includes('not available for provider')) {
          return sendBadRequest(res, message);
        }

        return sendInternalError(res, 'Failed to generate pipeline configuration', {
          details: message,
        });
      }
    }),
  );

  // -- POST /generate/stream — stream pipeline config as SSE events ----------
  /**
   * Accepts a natural language prompt and streams AI-generated pipeline
   * configuration as SSE events. Each event contains a partial JSON object
   * that progressively builds toward the final configuration.
   *
   * Events: {type:"partial", data:{...}} → {type:"done", data:{props,...}} → [DONE]
   */
  router.post(
    '/generate/stream',
    ...createAuthenticatedWithOrgRoute(),
    withRoute(async ({ req, res, ctx, orgId }) => {
      const validation = validateBody(req, AIGenerateBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { prompt, provider, model, apiKey } = validation.value;

      try {
        ctx.log('INFO', 'AI pipeline streaming generation requested', {
          promptLength: prompt.length,
          provider,
          model,
        });

        const plugins = await getAvailablePlugins(orgId);

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setTimeout(0);
        res.flushHeaders();

        // Track client disconnect
        let aborted = false;
        req.on('close', () => { aborted = true; });

        const result = streamPipelineConfig({
          prompt: prompt.trim(),
          plugins,
          orgId,
          provider,
          model,
          ...(apiKey ? { apiKey } : {}),
        });

        // Stream partial objects
        for await (const partialObject of result.partialOutputStream) {
          if (aborted) break;
          try {
            res.write(`data: ${JSON.stringify({ type: 'partial', data: partialObject })}\n\n`);
          } catch (serializeError) {
            logger.warn('Failed to serialize partial object', { requestId: ctx.requestId, error: errorMessage(serializeError) });
          }
        }

        if (!aborted) {
          // Get final validated output
          const finalOutput = await result.output;
          if (finalOutput) {
            const { description, keywords, ...props } = finalOutput;
            res.write(`data: ${JSON.stringify({
              type: 'done',
              data: { props, description: description ?? undefined, keywords: keywords ?? undefined },
            })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
        }

        res.end();
      } catch (error) {
        const message = errorMessage(error);
        logger.error('AI pipeline streaming generation failed', {
          requestId: ctx.requestId,
          error: message,
        });

        if (!res.headersSent) {
          if (message.includes('not configured') || message.includes('API key')) {
            return sendInternalError(res, 'AI generation is not configured for the requested provider');
          }
          if (message.includes('not available for provider')) {
            return sendBadRequest(res, message);
          }
          return sendInternalError(res, 'Failed to stream pipeline configuration');
        }

        // Headers already sent — send error as SSE event
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
        res.end();
      }
    }),
  );

  return router;
}
