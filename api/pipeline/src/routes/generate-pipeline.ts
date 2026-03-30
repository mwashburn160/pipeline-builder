import {
  createLogger,
  createSafeClient,
  errorMessage,
  handleAIError,
  initSSEStream,
  sendBadRequest,
  sendSuccess,
  validateBody,
  AIGenerateBodySchema,
  AIGenerateFromUrlBodySchema,
  SYSTEM_ORG_ID,
  AccessModifier,
} from '@mwashburn160/api-core';
import { createAuthenticatedWithOrgRoute, withRoute } from '@mwashburn160/api-server';
import { Config, CoreConstants, db, schema } from '@mwashburn160/pipeline-core';
import { eq, or, and, isNull } from 'drizzle-orm';
import { Router } from 'express';
import { getAvailableProviders, getFilteredPlugins, generatePipelineConfig, streamPipelineConfig } from '../services/ai-generation-service';
import { parseGitUrl, analyzeRepository, buildEnhancedPrompt } from '../services/git-analysis-service';

const logger = createLogger('generate-pipeline');

/** Stream partial objects from an AI generation result. */
async function streamPartials(
  stream: AsyncIterable<unknown>,
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

const PLUGIN_SERVICE_TIMEOUT_MS = 30_000;
const { pluginHost, pluginPort } = Config.get('server').services;
const pluginClient = createSafeClient({
  host: pluginHost,
  port: pluginPort,
  timeout: PLUGIN_SERVICE_TIMEOUT_MS,
});

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
      const { prompt, provider, model, apiKey, previousConfig, fallbackProviders } = validation.value;

      try {
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
          ...(apiKey ? { apiKey } : {}),
          ...(previousConfig ? { previousConfig } : {}),
          ...(fallbackProviders ? { fallbackProviders } : {}),
        });

        ctx.log('COMPLETED', 'AI pipeline generation completed', {
          pluginCount: plugins.length,
          ...(result.servedBy && { servedBy: result.servedBy }),
          ...(result.usage && { tokens: result.usage.totalTokens }),
        });

        return sendSuccess(res, 200, {
          props: result.props,
          description: result.description,
          keywords: result.keywords,
          usage: result.usage,
          servedBy: result.servedBy,
          promptVersion: result.promptVersion,
          validationWarnings: result.validationWarnings,
        });
      } catch (error) {
        const message = errorMessage(error);
        logger.error('AI pipeline generation failed', { requestId: ctx.requestId, error: message });
        handleAIError(res, message, 'Failed to generate pipeline configuration');
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

        const plugins = await getFilteredPlugins(orgId, { prompt });

        const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);

        const result = streamPipelineConfig({
          prompt: prompt.trim(),
          plugins,
          orgId,
          provider,
          model,
          ...(apiKey ? { apiKey } : {}),
        });

        await streamPartials(result.partialOutputStream, res, sse.aborted, ctx.requestId);

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
        }

        res.end();
      } catch (error) {
        const message = errorMessage(error);
        logger.error('AI pipeline streaming generation failed', { requestId: ctx.requestId, error: message });
        handleAIError(res, message, 'Failed to stream pipeline configuration');
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

        const sse = initSSEStream(req, res, CoreConstants.SSE_STREAM_TIMEOUT_MS);

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

        if (sse.aborted()) { res.end(); return; }

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
          ...(apiKey ? { apiKey } : {}),
        });

        await streamPartials(result.partialOutputStream, res, sse.aborted, ctx.requestId);

        if (!sse.aborted()) {
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

            // Phase 3: Auto-create missing plugins
            if (!sse.aborted()) {
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
        logger.error('AI pipeline generation from URL failed', { requestId: ctx.requestId, error: message });
        handleAIError(res, message, 'Failed to generate pipeline from URL');
      }
    }),
  );

  return router;
}

// Auto-Plugin Creation

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
          eq(schema.plugin.accessModifier, AccessModifier.PUBLIC),
          or(
            eq(schema.plugin.orgId, orgId),
            eq(schema.plugin.orgId, SYSTEM_ORG_ID),
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
        accessModifier: AccessModifier.PRIVATE,
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
