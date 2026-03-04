/**
 * @module routes/generate-plugin
 * @description AI-powered plugin configuration generation and deployment.
 *
 * Provides four endpoints for the plugin AI builder workflow:
 *
 * - **GET /plugins/providers** — List available AI providers and their models.
 * - **POST /plugins/generate** — Generate plugin config + Dockerfile from
 *   a natural language description using the AI SDK.
 * - **POST /plugins/generate/stream** — Same as above but streams partial
 *   results as SSE events for real-time progressive output.
 * - **POST /plugins/deploy-generated** — Build Docker image from the
 *   generated Dockerfile and save the plugin to the database.
 *
 * Request validation uses shared Zod schemas from api-core
 * ({@link AIGenerateBodySchema}, {@link PluginDeployGeneratedSchema}).
 */

import * as fs from 'fs';
import path from 'path';

import {
  ErrorCode,
  createLogger,
  isSystemAdmin,
  resolveAccessModifier,
  errorMessage,
  sendBadRequest,
  sendInternalError,
  sendError,
  sendSuccess,
  validateBody,
  AIGenerateBodySchema,
  PluginDeployGeneratedSchema,
} from '@mwashburn160/api-core';
import { checkQuota, withRoute } from '@mwashburn160/api-server';
import type { QuotaService } from '@mwashburn160/api-server';
import { Config } from '@mwashburn160/pipeline-core';
import { Router, Request, Response, RequestHandler } from 'express';
import { v7 as uuid } from 'uuid';

import { BUILD_TEMP_ROOT } from '../helpers/docker-build';
import { validateBuildArgs } from '../helpers/manifest';
import { createBuildJobData, generateImageTag } from '../helpers/plugin-helpers';
import { getQueue } from '../queue/plugin-build-queue';
import { getAvailableProviders, generatePluginConfig, streamPluginConfig } from '../services/ai-plugin-generation-service';

const logger = createLogger('generate-plugin');

/** SSE stream timeout in ms (default 5 minutes). */
const SSE_STREAM_TIMEOUT_MS = parseInt(process.env.SSE_STREAM_TIMEOUT_MS || '300000', 10);

/**
 * Create and register AI plugin generation routes.
 *
 * @param quotaService - Quota service for usage tracking
 * @returns Express Router with AI generation endpoints
 */
export function createGeneratePluginRoutes(
  quotaService: QuotaService,
): Router {
  const router: Router = Router();

  // -- GET /providers — list configured AI providers --------------------------
  /**
   * Returns the list of AI providers that have API keys configured via
   * environment variables on the plugin service.
   */
  router.get('/providers', withRoute(async ({ res }) => {
    const providers = getAvailableProviders();
    return sendSuccess(res, 200, { providers });
  }, { requireOrgId: false }));

  // -- POST /generate — generate plugin config from natural language ----------
  /**
   * Accepts a natural language prompt and returns an AI-generated plugin
   * configuration (name, commands, etc.) along with a Dockerfile.
   *
   * Validated with {@link AIGenerateBodySchema}.
   */
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
      logger.error('AI plugin generation failed', {
        requestId: ctx.requestId,
        error: message,
      });

      if (message.includes('not configured') || message.includes('API key')) {
        return sendInternalError(res, 'AI generation is not configured for the requested provider');
      }
      if (message.includes('not available for provider')) {
        return sendBadRequest(res, message);
      }

      return sendInternalError(res, 'Failed to generate plugin configuration', {
        details: message,
      });
    }
  }));

  // -- POST /generate/stream — stream plugin config as SSE events -------------
  /**
   * Accepts a natural language prompt and streams AI-generated plugin
   * configuration as SSE events. Each event contains a partial JSON object
   * that progressively builds toward the final configuration.
   *
   * Events: {type:"partial", data:{...}} → {type:"done", data:{config,dockerfile}} → [DONE]
   */
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

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setTimeout(SSE_STREAM_TIMEOUT_MS);
      res.flushHeaders();

      // Track client disconnect
      let aborted = false;
      req.on('close', () => { aborted = true; });

      const result = streamPluginConfig({
        prompt: prompt.trim(),
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
      logger.error('AI plugin streaming generation failed', {
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
        return sendInternalError(res, 'Failed to stream plugin configuration');
      }

      // Headers already sent — send error as SSE event
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
    }
  }));

  // -- POST /deploy-generated — build Docker + save to DB ---------------------
  /**
   * Deploys an AI-generated plugin by building a Docker image from the
   * generated Dockerfile and persisting the plugin record to the database.
   *
   * Flow: validate → imageTag → tempDir → Dockerfile → buildAndPush →
   * DB transaction → quota increment → cleanup.
   *
   * Requires admin permissions. Validated with {@link PluginDeployGeneratedSchema}.
   */
  router.post(
    '/deploy-generated',
    // Admin check BEFORE quota
    ((req: Request, res: Response, next: () => void) => {
      if (!isSystemAdmin(req)) {
        return sendError(res, 403, 'Only administrators can create plugins', ErrorCode.INSUFFICIENT_PERMISSIONS);
      }
      next();
    }) as RequestHandler,
    checkQuota(quotaService, 'plugins') as RequestHandler,
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const registry = Config.get('registry');

      const validation = validateBody(req, PluginDeployGeneratedSchema);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }
      const {
        name, description, version, pluginType, computeType, keywords,
        primaryOutputDirectory, installCommands, commands, env, buildArgs,
        dockerfile, accessModifier: rawAccess,
      } = validation.value;

      const accessModifier = resolveAccessModifier(req, rawAccess || 'private');

      // Validate buildArgs (throws ValidationError → handled by withRoute)
      validateBuildArgs(buildArgs);

      const imageTag = generateImageTag(name);

      ctx.log('INFO', 'Deploying AI-generated plugin', {
        pluginName: name,
        version,
        imageTag,
        accessModifier,
      });

      // Create temp directory and write Dockerfile (worker will clean up)
      const tempDir = path.join(BUILD_TEMP_ROOT, uuid());
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'Dockerfile'), dockerfile, 'utf-8');

      // Queue build job (returns immediately)
      const jobData = createBuildJobData({
        requestId: ctx.requestId,
        orgId,
        userId: userId || 'system',
        authToken: req.headers.authorization || '',
        buildRequest: {
          contextDir: tempDir,
          dockerfile: 'Dockerfile',
          imageTag,
          registry,
          buildArgs: buildArgs || {},
        },
        pluginRecord: {
          orgId,
          name,
          description: description || null,
          version,
          pluginType: pluginType || 'CodeBuildStep',
          computeType: computeType || 'MEDIUM',
          primaryOutputDirectory: primaryOutputDirectory || null,
          dockerfile,
          env: env || {},
          buildArgs: buildArgs || {},
          keywords: keywords || [],
          installCommands: installCommands || [],
          commands,
          imageTag,
          accessModifier,
        },
      });

      await getQueue().add(`deploy-generated-${name}-${imageTag}`, jobData);

      ctx.log('INFO', 'Build queued', {
        pluginName: name,
        imageTag,
      });

      return sendSuccess(res, 202, {
        requestId: ctx.requestId,
        pluginName: name,
        imageTag,
      }, 'Plugin build queued');
    }),
  );

  return router;
}
