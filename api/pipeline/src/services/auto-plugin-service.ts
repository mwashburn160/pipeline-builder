// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createSafeClient, envInt, ErrorCode, errorMessage, onBehalfHeaders, runConcurrent } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { findExistingPluginNames, findListedNames } from './plugin-lookup-service.js';

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
const PLUGIN_SERVICE_TIMEOUT_MS = envInt('PIPELINE_PLUGIN_SERVICE_TIMEOUT_MS', 30000, { min: 1 });

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

/** One plugin that will not get a placeholder, and why. */
export interface RefusedPlugin { name: string; error: string }

/**
 * What creating placeholders for a generated config WOULD do — computed, never
 * acted on. The from-URL stream sends it as the `missing-plugins` event so the
 * user can review and confirm; creation is a separate, explicit request
 * ({@link createPlaceholderPlugins}). A model's output never creates anything
 * on its own.
 */
export interface MissingPluginPlan {
  /** Stage plugin names the config references (deduplicated). */
  referenced: string[];
  /** Already visible to the org — nothing to do. */
  existing: string[];
  /** Missing, safe-named and not listed: placeholders the user may confirm. */
  proposed: string[];
  /** Missing but not creatable: a listed plugin's name, or an unsafe name. */
  refused: RefusedPlugin[];
}

/**
 * Extract plugin names referenced in a generated pipeline config.
 * Walks `stages[].steps[].plugin.name` — the one shape `PipelineGenerationSchema`
 * produces (see ai-generation-service), and the BuilderProps shape the pipeline
 * service persists.
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
  const stages = props.stages as Array<{ steps?: Array<{ plugin?: { name?: unknown; publisher?: unknown } }> }> | undefined;
  if (!Array.isArray(stages)) return [];
  for (const stage of stages) {
    if (!Array.isArray(stage.steps)) continue;
    for (const step of stage.steps) {
      // A `publisher` reference names an ecosystem listing — resolved through an
      // install, never an org plugin — so it never gets a placeholder.
      if (typeof step.plugin?.publisher === 'string' && step.plugin.publisher) continue;
      const name = step.plugin?.name;
      if (typeof name === 'string' && name) names.add(name);
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
 * Classify plugin names for placeholder creation: which already exist (visible to
 * the caller), which are refused (a LISTED plugin's name — the org installs it or
 * references it with its publisher instead of getting a failing stand-in that
 * would shadow it — or a name outside {@link SAFE_PLUGIN_NAME_RE}), and which may
 * be created. Read-only.
 */
export async function planPlaceholderPlugins(pluginNames: string[], orgId: string): Promise<MissingPluginPlan> {
  const referenced = [...new Set(pluginNames)];
  if (referenced.length === 0) return { referenced, existing: [], proposed: [], refused: [] };

  // Check which plugins already exist (single batched query)
  const existingSet = await findExistingPluginNames(referenced, orgId);
  const existing = referenced.filter((n) => existingSet.has(n));
  const missing = referenced.filter((n) => !existingSet.has(n));
  if (missing.length === 0) return { referenced, existing, proposed: [], refused: [] };

  const refused: RefusedPlugin[] = [];
  const proposed: string[] = [];
  // Reject any name that isn't a strict `[a-z0-9-]+` token BEFORE it can reach
  // the shell command / Dockerfile interpolation. Validate-and-reject, not escape.
  const safe = missing.filter((name) => {
    if (SAFE_PLUGIN_NAME_RE.test(name)) return true;
    logger.warn('Rejected unsafe auto-plugin name', { plugin: name });
    refused.push({ name, error: 'invalid plugin name' });
    return false;
  });
  const listed = safe.length > 0 ? await findListedNames(safe) : new Map<string, string[]>();
  for (const name of safe) {
    const handles = listed.get(name);
    if (handles) {
      refused.push({
        name,
        error: `${ErrorCode.PLUGIN_NAME_LISTED}: "${name}" is a listed plugin (${handles.map((h) => `${h}/${name}`).join(', ')}). `
          + 'Install it, or reference it with its publisher, instead of creating a placeholder.',
      });
    } else {
      proposed.push(name);
    }
  }
  return { referenced, existing, proposed, refused };
}

/** The plan for a generated config's stage plugins (see {@link planPlaceholderPlugins}). */
export function planMissingPlugins(props: Record<string, unknown>, orgId: string): Promise<MissingPluginPlan> {
  return planPlaceholderPlugins(extractPluginNames(props), orgId);
}

/** Outcome of one placeholder creation. */
export type PlaceholderBuild = { name: string; requestId?: string; error?: string };

/**
 * Create placeholder plugins the USER CONFIRMED, via the plugin service's
 * deploy-generated endpoint (authenticated as the user, so its own
 * `plugins:write` gate and audit apply). The names are re-planned first — a name
 * that now exists, is listed, or is unsafe is refused here too, whatever the
 * client sent.
 *
 * @param names - The names the user confirmed (from a `missing-plugins` event)
 * @param orgId - Organization ID
 * @param context - Auth context (bearer + request id) forwarded to the plugin service
 */
export async function createPlaceholderPlugins(
  names: string[],
  orgId: string,
  context: { authToken: string; requestId: string },
): Promise<{ created: string[]; existing: string[]; builds: PlaceholderBuild[] }> {
  const plan = await planPlaceholderPlugins(names, orgId);
  if (plan.proposed.length === 0) {
    return { created: [], existing: plan.existing, builds: plan.refused };
  }

  // Cap concurrency so a confirmation with many plugins doesn't fan out
  // unbounded requests.
  const pluginClient = getPluginClient();
  const builds = await runConcurrent(plan.proposed, 5, async (name): Promise<PlaceholderBuild> => {
    try {
      // Idempotency-Key scopes the deploy to (requestId, plugin name) so a
      // client retrying a failed confirmation doesn't enqueue duplicate plugin
      // builds. Plugin service treats the same key within a short window as a no-op.
      const deployResponse = await pluginClient.post<{ data?: { requestId?: string } }>(
        '/plugins/deploy-generated',
        buildPlaceholderPluginRequest(name),
        {
          headers: {
            'Authorization': context.authToken,
            // The confirm request was metered when it reached this service; the
            // signed on-behalf marker (bound to the ambient verified caller) keeps
            // the plugin service from billing each placeholder as another apiCall.
            ...onBehalfHeaders(),
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

  // Only the names the plugin service accepted were created; a refused or
  // failed deploy is reported in `builds` with its error, never as created.
  const created = builds.filter((b) => !b.error).map((b) => b.name);
  return { created, existing: plan.existing, builds: [...plan.refused, ...builds] };
}
