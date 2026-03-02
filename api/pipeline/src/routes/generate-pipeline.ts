/**
 * @module routes/generate-pipeline
 * @description AI-powered pipeline configuration generation.
 *
 * Provides four endpoints for the pipeline AI builder workflow:
 *
 * - **GET /pipelines/providers** — List available AI providers and their models.
 * - **POST /pipelines/generate** — Generate BuilderProps JSON from a natural
 *   language description using the AI SDK.
 * - **POST /pipelines/generate/stream** — Same as above but streams partial
 *   results as SSE events for real-time progressive output.
 * - **POST /pipelines/generate/from-url/stream** — Analyze a Git URL and
 *   stream AI-generated pipeline config as SSE events.
 *
 * Request validation uses the shared Zod schemas from api-core
 * ({@link AIGenerateBodySchema}, {@link AIGenerateFromUrlBodySchema}).
 */

import {
  createLogger,
  createSafeClient,
  errorMessage,
  sendBadRequest,
  sendInternalError,
  sendSuccess,
  validateBody,
  AIGenerateBodySchema,
  AIGenerateFromUrlBodySchema,
} from '@mwashburn160/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@mwashburn160/api-server';
import { db, schema } from '@mwashburn160/pipeline-core';
import { eq, or, and, isNull } from 'drizzle-orm';
import { Router } from 'express';
import { getAvailableProviders, generatePipelineConfig, streamPipelineConfig } from '../services/ai-generation-service';
import { parseGitUrl, analyzeRepository, buildEnhancedPrompt } from '../services/git-analysis-service';

const logger = createLogger('generate-pipeline');

/** SSE stream timeout in ms (default 5 minutes). */
const SSE_STREAM_TIMEOUT_MS = parseInt(process.env.SSE_STREAM_TIMEOUT_MS || '300000', 10);

/** Internal HTTP client for the plugin service (auto-plugin creation). */
const pluginClient = createSafeClient({
  host: process.env.PLUGIN_SERVICE_HOST || 'plugin',
  port: parseInt(process.env.PLUGIN_SERVICE_PORT || '3000', 10),
  timeout: 30_000,
});

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
        res.setTimeout(SSE_STREAM_TIMEOUT_MS);
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

  // -- POST /generate/from-url/stream — analyze Git URL + stream pipeline ----
  /**
   * Accepts a Git URL, analyzes the repository via the appropriate provider API
   * (GitHub, GitLab, Bitbucket), then streams an AI-generated pipeline config
   * as SSE events.
   *
   * Events:
   * - `{type:"analyzing"}` — fetching repo metadata
   * - `{type:"analyzed", data:{...}}` — repo analysis summary
   * - `{type:"partial", data:{...}}` — streaming AI generation partial
   * - `{type:"done", data:{props,...}}` — final generated config
   * - `{type:"error", message:"..."}` — error during processing
   *
   * Validated with {@link AIGenerateFromUrlBodySchema}.
   */
  router.post(
    '/generate/from-url/stream',
    ...createAuthenticatedWithOrgRoute(),
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

      try {
        ctx.log('INFO', 'AI pipeline generation from URL requested', {
          gitUrl,
          provider,
          model,
          gitProvider: parsed.provider,
        });

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setTimeout(SSE_STREAM_TIMEOUT_MS);
        res.flushHeaders();

        let aborted = false;
        req.on('close', () => { aborted = true; });

        // Phase 1: Analyze repository
        res.write(`data: ${JSON.stringify({ type: 'analyzing' })}\n\n`);

        let analysis;
        try {
          analysis = await analyzeRepository(parsed, repoToken);
        } catch (analyzeError) {
          const msg = errorMessage(analyzeError);
          logger.warn('Repository analysis failed', { requestId: ctx.requestId, error: msg });
          res.write(`data: ${JSON.stringify({ type: 'error', message: `Repository analysis failed: ${msg}` })}\n\n`);
          res.end();
          return;
        }

        if (aborted) { res.end(); return; }

        res.write(`data: ${JSON.stringify({
          type: 'analyzed',
          data: {
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
          },
        })}\n\n`);

        // Phase 2: Build enhanced prompt and stream AI generation
        const enhancedPrompt = buildEnhancedPrompt(analysis);
        const plugins = await getAvailablePlugins(orgId);

        const result = streamPipelineConfig({
          prompt: enhancedPrompt,
          plugins,
          orgId,
          provider,
          model,
          ...(apiKey ? { apiKey } : {}),
        });

        for await (const partialObject of result.partialOutputStream) {
          if (aborted) break;
          try {
            res.write(`data: ${JSON.stringify({ type: 'partial', data: partialObject })}\n\n`);
          } catch (serializeError) {
            logger.warn('Failed to serialize partial object', { requestId: ctx.requestId, error: errorMessage(serializeError) });
          }
        }

        if (!aborted) {
          const finalOutput = await result.output;
          if (finalOutput) {
            const { description, keywords, ...props } = finalOutput;
            res.write(`data: ${JSON.stringify({
              type: 'done',
              data: { props, description: description ?? undefined, keywords: keywords ?? undefined },
            })}\n\n`);

            // Phase 3: Auto-create missing plugins
            if (!aborted) {
              await autoCreateMissingPlugins(res, props, orgId, {
                provider,
                model,
                apiKey,
                authToken: req.headers.authorization || '',
                requestId: ctx.requestId,
              });
            }
          }
          res.write('data: [DONE]\n\n');
        }

        res.end();
      } catch (error) {
        const message = errorMessage(error);
        logger.error('AI pipeline generation from URL failed', {
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
          return sendInternalError(res, 'Failed to generate pipeline from URL');
        }

        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
        res.end();
      }
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// Auto-Plugin Creation
// ---------------------------------------------------------------------------

/**
 * Extract plugin names referenced in a generated pipeline config.
 * Scans `stages[].actions[].pluginName` from the BuilderProps structure.
 *
 * @param props - Generated pipeline props (partial BuilderProps)
 * @returns Unique list of plugin names
 */
function extractPluginNames(props: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const stages = props.stages as Array<{ actions?: Array<{ pluginName?: string }> }> | undefined;
  if (!Array.isArray(stages)) return [];

  for (const stage of stages) {
    if (!Array.isArray(stage.actions)) continue;
    for (const action of stage.actions) {
      if (action.pluginName && typeof action.pluginName === 'string') {
        names.add(action.pluginName);
      }
    }
  }
  return [...names];
}

/**
 * Check which plugins already exist in the database and auto-create
 * missing ones via the plugin service's deploy-generated endpoint.
 *
 * Emits SSE events:
 * - `{type:"checking-plugins", data:{plugins:[...]}}` — list of referenced plugins
 * - `{type:"creating-plugins", data:{creating:[...], existing:[...], builds:[...]}}` — creation results
 *
 * @param res - Express response (SSE stream)
 * @param props - Generated pipeline props
 * @param orgId - Organization ID
 * @param context - AI provider and auth context for plugin generation
 */
async function autoCreateMissingPlugins(
  res: import('express').Response,
  props: Record<string, unknown>,
  orgId: string,
  context: {
    provider: string;
    model: string;
    apiKey?: string;
    authToken: string;
    requestId: string;
  },
): Promise<void> {
  const pluginNames = extractPluginNames(props);
  if (pluginNames.length === 0) return;

  res.write(`data: ${JSON.stringify({ type: 'checking-plugins', data: { plugins: pluginNames } })}\n\n`);

  // Check which plugins already exist
  const existing: string[] = [];
  const missing: string[] = [];

  for (const name of pluginNames) {
    const found = await db
      .select({ name: schema.plugin.name })
      .from(schema.plugin)
      .where(
        and(
          eq(schema.plugin.name, name),
          eq(schema.plugin.isActive, true),
          isNull(schema.plugin.deletedAt),
          or(
            eq(schema.plugin.orgId, orgId),
            eq(schema.plugin.accessModifier, 'public'),
          ),
        ),
      )
      .limit(1);

    if (found.length > 0) {
      existing.push(name);
    } else {
      missing.push(name);
    }
  }

  if (missing.length === 0) {
    res.write(`data: ${JSON.stringify({
      type: 'creating-plugins',
      data: { creating: [], existing, builds: [] },
    })}\n\n`);
    return;
  }

  // Auto-create missing plugins via plugin service
  const builds: Array<{ name: string; requestId?: string; error?: string }> = [];

  for (const name of missing) {
    try {
      const deployResponse = await pluginClient.post<{ data?: { requestId?: string } }>('/plugins/deploy-generated', {
        name,
        description: 'Auto-generated plugin for pipeline',
        version: '1.0.0',
        pluginType: 'CodeBuildStep',
        computeType: 'MEDIUM',
        installCommands: [],
        commands: [`echo "Plugin ${name} — replace with real build commands"`],
        dockerfile: `FROM public.ecr.aws/codebuild/amazonlinux2-x86_64-standard:5.0\nRUN echo "Plugin ${name}"`,
        accessModifier: 'private',
      }, {
        headers: {
          'Authorization': context.authToken,
          'x-org-id': orgId,
          'x-request-id': context.requestId,
        },
      });

      if (deployResponse && (deployResponse.statusCode === 202 || deployResponse.statusCode === 200)) {
        builds.push({ name, requestId: deployResponse.body?.data?.requestId });
      } else {
        builds.push({ name, error: `HTTP ${deployResponse?.statusCode ?? 'unknown'}` });
      }
    } catch (err) {
      builds.push({ name, error: errorMessage(err) });
      logger.warn('Auto-plugin creation failed', { plugin: name, error: errorMessage(err) });
    }
  }

  res.write(`data: ${JSON.stringify({
    type: 'creating-plugins',
    data: { creating: missing, existing, builds },
  })}\n\n`);
}
