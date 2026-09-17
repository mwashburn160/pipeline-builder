// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createSafeClient, errorMessage, runConcurrent } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { findExistingPluginNames } from './plugin-lookup-service.js';

const logger = createLogger('auto-plugin');

/**
 * Strict allowlist for AI/repo-derived plugin names before they are used to
 * build shell commands / a Dockerfile downstream. `PluginOptionsSchema.name` is
 * only `z.string()`, so an AI (or a poisoned repo analysis) could emit a name
 * like `"; rm -rf / #` that would break out of the `echo "..."` command or the
 * `RUN echo "Plugin ..."` Dockerfile line. Only lowercase alphanumerics and
 * hyphens are safe to interpolate; anything else is rejected, never escaped.
 */
const SAFE_PLUGIN_NAME_RE = /^[a-z0-9-]+$/;

/** Timeout for the pipeline service's calls into the plugin service.
 * 30s by default — these calls are sometimes slow because plugin upload
 * responses include build queue results. Override via
 * `PIPELINE_PLUGIN_SERVICE_TIMEOUT_MS`. */
const parsedTimeout = parseInt(process.env.PIPELINE_PLUGIN_SERVICE_TIMEOUT_MS || '30000', 10);
const PLUGIN_SERVICE_TIMEOUT_MS = Number.isFinite(parsedTimeout) ? parsedTimeout : 30000;

let _pluginClient: ReturnType<typeof createSafeClient> | undefined;
/** Lazily construct the plugin service client — defers Config.get() until first
 * request so module load doesn't fail before env is initialized in tests. */
function getPluginClient(): ReturnType<typeof createSafeClient> {
  if (!_pluginClient) {
    const { pluginHost, pluginPort } = Config.get('server').services;
    _pluginClient = createSafeClient({ host: pluginHost, port: pluginPort, timeout: PLUGIN_SERVICE_TIMEOUT_MS });
  }
  return _pluginClient;
}

/** An SSE-shaped progress event emitted while checking / creating plugins. */
export type AutoPluginEvent =
  | { type: 'checking-plugins'; data: { plugins: string[] } }
  | { type: 'creating-plugins'; data: { creating: string[]; existing: string[]; builds: Array<Record<string, unknown>> } };

/**
 * Extract plugin names referenced in a generated pipeline config.
 * Walks `stages[].steps[].plugin.name` and `stages[].actions[].pluginName` to
 * match the shapes produced by `PipelineGenerationSchema` (see ai-generation-service).
 *
 * @param props - Generated pipeline props (partial BuilderProps)
 * @returns Unique list of plugin names
 */
export function extractPluginNames(props: Record<string, unknown>): string[] {
  const names = new Set<string>();

  // Only stage plugins are subject to auto-creation. The synth plugin (build
  // tool for the synth step) is provisioned out-of-band; including it here
  // would trigger creating-plugins on every generated pipeline and break the
  // "skip auto-creation when no stages" guarantee.
  const stages = props.stages as Array<{
    steps?: Array<{ plugin?: { name?: unknown } }>;
    actions?: Array<{ pluginName?: unknown }>;
  }> | undefined;
  if (!Array.isArray(stages)) return [];
  for (const stage of stages) {
    // Two AI-output shapes are accepted: stages[].steps[].plugin.name
    // (BuilderProps) and stages[].actions[].pluginName (legacy / alt schema).
    if (Array.isArray(stage.steps)) {
      for (const step of stage.steps) {
        const name = step.plugin?.name;
        if (typeof name === 'string' && name) names.add(name);
      }
    }
    if (Array.isArray(stage.actions)) {
      for (const action of stage.actions) {
        const name = action.pluginName;
        if (typeof name === 'string' && name) names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * The deploy-generated body for an auto-created PLACEHOLDER plugin.
 *
 * The placeholder has no real build logic, so its build command FAILS (non-zero
 * exit, message on stderr). A placeholder that echoed and exited 0 turned every
 * pipeline step using it into a false-positive green build.
 *
 * `name` MUST already satisfy {@link SAFE_PLUGIN_NAME_RE} — it is interpolated
 * into shell / Dockerfile text.
 */
export function buildPlaceholderPluginRequest(name: string): Record<string, unknown> {
  return {
    name,
    description: 'Auto-generated plugin for pipeline',
    version: '1.0.0',
    pluginType: 'CodeBuildStep',
    computeType: 'MEDIUM',
    installCommands: [],
    commands: [`echo "plugin ${name} is a placeholder — implement it" >&2; exit 1`],
    dockerfile: `FROM public.ecr.aws/codebuild/amazonlinux-x86_64-standard:6.0\nRUN echo "Plugin ${name}"`,
    visibility: 'private',
  };
}

/**
 * Check which referenced plugins already exist (visible to the caller) and
 * auto-create the missing ones as placeholders via the plugin service's
 * deploy-generated endpoint.
 *
 * Emits (via `emit`)
 * - `{type:"checking-plugins", data:{plugins:[...]}}` — list of referenced plugins
 * - `{type:"creating-plugins", data:{creating:[...], existing:[...], builds:[...]}}` — creation results
 *
 * @param props - Generated pipeline props
 * @param orgId - Organization ID
 * @param context - Auth context (bearer + request id) forwarded to the plugin service
 * @param emit - Progress sink (the route writes each event to its SSE stream)
 */
export async function autoCreateMissingPlugins(
  props: Record<string, unknown>,
  orgId: string,
  context: { authToken: string; requestId: string },
  emit: (event: AutoPluginEvent) => void,
): Promise<void> {
  const pluginNames = extractPluginNames(props);
  if (pluginNames.length === 0) return;

  emit({ type: 'checking-plugins', data: { plugins: pluginNames } });

  // Check which plugins already exist (single batched query)
  const existingSet = await findExistingPluginNames(pluginNames, orgId);
  const existing: string[] = pluginNames.filter(n => existingSet.has(n));
  const missing: string[] = pluginNames.filter(n => !existingSet.has(n));

  if (missing.length === 0) {
    emit({ type: 'creating-plugins', data: { creating: [], existing, builds: [] } });
    return;
  }

  // Auto-create missing plugins via plugin service — cap concurrency so a
  // generation with many plugins doesn't fan out unbounded requests.
  const pluginClient = getPluginClient();
  const builds = await runConcurrent(missing, 5, async (name) => {
    // Reject any name that isn't a strict `[a-z0-9-]+` token BEFORE it reaches
    // the shell command / Dockerfile interpolation. This is validate-and-reject,
    // not escape: an out-of-allowlist name is never sent to the plugin service.
    if (!SAFE_PLUGIN_NAME_RE.test(name)) {
      logger.warn('Rejected unsafe auto-plugin name', { plugin: name });
      return { name, error: 'invalid plugin name' };
    }
    try {
      // Idempotency-Key scopes the deploy to (requestId, plugin name) so a
      // client retrying a failed /generate/from-url/stream call doesn't enqueue
      // duplicate plugin builds. Plugin service should treat the same key
      // within a short window as a no-op.
      const deployResponse = await pluginClient.post<{ data?: { requestId?: string } }>(
        '/plugins/deploy-generated',
        buildPlaceholderPluginRequest(name),
        {
          headers: {
            'Authorization': context.authToken,
            'x-org-id': orgId,
            'x-request-id': context.requestId,
            'Idempotency-Key': `${context.requestId}:${name}`,
          },
        },
      );

      if (deployResponse && (deployResponse.statusCode === 202 || deployResponse.statusCode === 200)) {
        return { name, requestId: deployResponse.body?.data?.requestId };
      }
      return { name, error: `HTTP ${deployResponse?.statusCode ?? 'unknown'}` };
    } catch (err) {
      logger.warn('Auto-plugin creation failed', { plugin: name, error: errorMessage(err) });
      return { name, error: errorMessage(err) };
    }
  });

  emit({ type: 'creating-plugins', data: { creating: missing, existing, builds } });
}
