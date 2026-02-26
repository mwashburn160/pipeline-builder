/**
 * @module routes/generate-plugin
 * @description AI-powered plugin configuration generation and deployment.
 *
 * Provides three endpoints for the plugin AI builder workflow:
 *
 * - **GET /plugins/providers** — List available AI providers and their models.
 * - **POST /plugins/generate** — Generate plugin config + Dockerfile from
 *   a natural language description using the AI SDK.
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
import { checkQuota } from '@mwashburn160/api-server';
import type { QuotaService } from '@mwashburn160/api-server';
import { Config } from '@mwashburn160/pipeline-core';
import { Router, Request, Response } from 'express';
import { v7 as uuid } from 'uuid';

import { getQueue } from '../queue/plugin-build-queue';
import { getAvailableProviders, generatePluginConfig } from '../services/ai-plugin-generation-service';

const logger = createLogger('generate-plugin');

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
  router.get('/providers', (_req: Request, res: Response) => {
    const providers = getAvailableProviders();
    return sendSuccess(res, 200, { providers });
  });

  // -- POST /generate — generate plugin config from natural language ----------
  /**
   * Accepts a natural language prompt and returns an AI-generated plugin
   * configuration (name, commands, etc.) along with a Dockerfile.
   *
   * Validated with {@link AIGenerateBodySchema}.
   */
  router.post('/generate', async (req: Request, res: Response) => {
    const ctx = req.context!;

    const validation = validateBody(req, AIGenerateBodySchema);
    if (!validation.ok) {
      return sendBadRequest(res, validation.error);
    }
    const { prompt, provider, model, apiKey } = validation.value;

    try {
      const orgId = ctx.identity.orgId?.toLowerCase() ?? '';
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
  });

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
    }) as import('express').RequestHandler,
    checkQuota(quotaService, 'plugins') as import('express').RequestHandler,
    async (req: Request, res: Response) => {
      const ctx = req.context!;
      const config = Config.get();

      try {
        if (!ctx.identity.orgId) return sendBadRequest(res, 'Organization ID is required');
        const orgId = ctx.identity.orgId.toLowerCase();

        const validation = validateBody(req, PluginDeployGeneratedSchema);
        if (!validation.ok) {
          return sendBadRequest(res, validation.error);
        }
        const {
          name, description, version, pluginType, computeType, keywords,
          primaryOutputDirectory, installCommands, commands, env,
          dockerfile, accessModifier: rawAccess,
        } = validation.value;

        const accessModifier = resolveAccessModifier(req, rawAccess || 'private');

        // Generate image tag
        const imageTag = `p-${name.replace(/[^a-z0-9]/gi, '')}-${uuid().slice(0, 8)}`.toLowerCase();

        ctx.log('INFO', 'Deploying AI-generated plugin', {
          pluginName: name,
          version,
          imageTag,
          accessModifier,
        });

        // Create temp directory and write Dockerfile (worker will clean up)
        const tempDir = path.join(process.cwd(), 'tmp', uuid());
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'Dockerfile'), dockerfile, 'utf-8');

        // Queue build job (returns immediately)
        const buildQueue = getQueue();
        await buildQueue.add(
          `deploy-generated-${name}-${imageTag}`,
          {
            requestId: ctx.requestId,
            orgId,
            userId: ctx.identity.userId || 'system',
            authToken: req.headers.authorization || '',
            buildRequest: {
              contextDir: tempDir,
              dockerfile: 'Dockerfile',
              imageTag,
              registry: config.registry,
            },
            pluginRecord: {
              orgId,
              name,
              description: description || null,
              version,
              metadata: {},
              pluginType: pluginType || 'CodeBuildStep',
              computeType: computeType || 'MEDIUM',
              primaryOutputDirectory: primaryOutputDirectory || null,
              dockerfile,
              env: env || {},
              keywords: keywords || [],
              installCommands: installCommands || [],
              commands,
              imageTag,
              accessModifier,
            },
          },
        );

        ctx.log('INFO', 'Build queued', {
          pluginName: name,
          imageTag,
        });

        return sendSuccess(res, 202, {
          requestId: ctx.requestId,
          pluginName: name,
          imageTag,
        }, 'Plugin build queued');
      } catch (error) {
        if (res.headersSent) {
          logger.error('Deployment failed (response already sent)', { requestId: ctx.requestId, error: errorMessage(error), orgId: ctx.identity.orgId });
          return;
        }

        logger.error('AI plugin deployment failed', { requestId: ctx.requestId, error: errorMessage(error), orgId: ctx.identity.orgId });

        return sendInternalError(res, 'Plugin deployment failed');
      }
    },
  );

  return router;
}
