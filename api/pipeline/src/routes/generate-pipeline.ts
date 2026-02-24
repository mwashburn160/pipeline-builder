/**
 * @module routes/generate-pipeline
 * @description AI-powered pipeline configuration generation.
 *
 * Provides two endpoints for the pipeline AI builder workflow:
 *
 * - **GET /pipelines/providers** — List available AI providers and their models.
 * - **POST /pipelines/generate** — Generate BuilderProps JSON from a natural
 *   language description using the AI SDK.
 *
 * Request validation uses the shared Zod schema from api-core
 * ({@link AIGenerateBodySchema}).
 */

import {
  createLogger,
  errorMessage,
  sendBadRequest,
  sendInternalError,
  validateBody,
  AIGenerateBodySchema,
} from '@mwashburn160/api-core';
import { createRequestContext, createAuthenticatedWithOrgRoute, SSEManager } from '@mwashburn160/api-server';
import { db, schema } from '@mwashburn160/pipeline-core';
import { eq, or, and, isNull } from 'drizzle-orm';
import { Router, Request, Response } from 'express';
import { getAvailableProviders, generatePipelineConfig } from '../services/ai-generation-service';

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
 * @param sseManager - SSE connection manager for request context
 * @returns Express Router with AI generation endpoints
 */
export function createGeneratePipelineRoutes(sseManager: SSEManager): Router {
  const router: Router = Router();

  // -- GET /providers — list configured AI providers --------------------------
  /**
   * Returns the list of AI providers that have API keys configured via
   * environment variables on the pipeline service.
   */
  router.get(
    '/providers',
    ...createAuthenticatedWithOrgRoute(sseManager),
    (_req: Request, res: Response) => {
      const providers = getAvailableProviders();
      return res.status(200).json({
        success: true,
        statusCode: 200,
        data: { providers },
      });
    },
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
    ...createAuthenticatedWithOrgRoute(sseManager),
    async (req: Request, res: Response) => {
      const ctx = createRequestContext(req, res, sseManager);

      const validation = validateBody(req, AIGenerateBodySchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const { prompt, provider, model, apiKey } = validation.value;

      try {
        const orgId = ctx.identity.orgId?.toLowerCase() ?? '';
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

        return res.status(200).json({
          success: true,
          statusCode: 200,
          data: {
            props: result.props,
            description: result.description,
            keywords: result.keywords,
          },
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
    },
  );

  return router;
}
