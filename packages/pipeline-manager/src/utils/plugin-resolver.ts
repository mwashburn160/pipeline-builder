// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, errorMessage } from '@pipeline-builder/api-core';
import { pluginArtifactAlias, pluginLookupFilter } from '@pipeline-builder/pipeline-core';
import { ApiClient } from './api-client.js';
import { printWarning } from './output-utils.js';

/** Minimal plugin reference shape — matches PluginOptions from pipeline-core. */
interface PluginRef {
  name: string;
  /** Publisher handle of an installed listing (plugin ecosystem §3.5). */
  publisher?: string;
  alias?: string;
  filter?: Record<string, unknown>;
}

/**
 * Cache key matching `PluginLookup.normalize()`: the explicit alias when set,
 * otherwise `[<publisher>-]<name>-alias` — pipeline-core's
 * `pluginArtifactAlias`, the one rule every consumer of this map uses.
 */
function cacheKey(ref: PluginRef): string {
  return pluginArtifactAlias(ref);
}

/**
 * Walk the pipeline props tree to collect every plugin reference. Plugins
 * appear at `synth.plugin` and at `stages[].steps[].plugin`. Entries are
 * de-duplicated by `cacheKey()` — the same key `PluginLookup.plugin()` uses,
 * so the resolved-plugins map lookups match downstream.
 */
function collectPluginRefs(props: Record<string, unknown>): PluginRef[] {
  const refs: PluginRef[] = [];
  const seen = new Map<string, string>();

  const push = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as PluginRef;
    if (!r.name) return;
    const key = cacheKey(r);
    // The name the lookup will TARGET — an explicit `filter.name` wins (see
    // below), so two refs that resolve to the same plugin are not a collision.
    const name = (r.filter?.name as string | undefined) ?? r.name;
    const target = r.publisher ? `${r.publisher}/${name}` : name;
    const holder = seen.get(key);
    if (holder !== undefined) {
      // One alias can only ever mean one plugin. Deduplicating on the alias
      // alone kept the FIRST plugin and silently dropped the second, so a step
      // declaring `{ name: 'maven-build', alias: 'build' }` after another
      // declaring `{ name: 'nodejs-build', alias: 'build' }` ran nodejs-build's
      // image and commands — no error, just the wrong build.
      if (holder !== target) {
        throw new Error(
          `Plugin alias "${key}" is used for two different plugins ("${holder}" and "${target}"). `
          + 'Give each plugin its own alias.',
        );
      }
      return;
    }
    seen.set(key, target);
    refs.push(r);
  };

  const synth = props.synth as { plugin?: unknown } | undefined;
  push(synth?.plugin);

  const stages = props.stages as Array<{ steps?: Array<{ plugin?: unknown }> }> | undefined;
  for (const stage of stages ?? []) {
    for (const step of stage.steps ?? []) {
      push(step.plugin);
    }
  }

  return refs;
}

/**
 * The lifecycle warning messages a `/plugins/lookup` answer carries
 * (`warnings: [{ code, message }]` beside `plugin`). Tolerates the same
 * envelopes as the plugin unwrap; anything malformed yields none.
 */
export function lookupWarningsOf(body: unknown): string[] {
  const warnings = (body as { warnings?: unknown } | undefined)?.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings
    .map((w) => (w && typeof w === 'object' ? (w as { message?: unknown }).message : undefined))
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
}

/**
 * Lookup refusals that must STOP the synth rather than fall back to
 * deploy-time resolution: an image whose signature doesn't verify, and a
 * listing the org can't use (not installed, blocked by its policy, yanked or
 * suspended — plugin ecosystem §3.2, §3.4). Falling back would quietly turn
 * each into an unresolved step that fails at run time instead of now.
 */
const FATAL_LOOKUP_CODES: readonly string[] = [
  ErrorCode.IMAGE_VERIFICATION_FAILED,
  ErrorCode.PLUGIN_NOT_INSTALLED,
  ErrorCode.PLUGIN_BLOCKED_BY_POLICY,
  ErrorCode.PLUGIN_UNAVAILABLE,
];

/** The error code of a plugin service answer, when it is one of {@link FATAL_LOOKUP_CODES}. */
function fatalLookupCode(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } } | undefined)?.response?.data;
  const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined;
  return typeof code === 'string' && FATAL_LOOKUP_CODES.includes(code) ? code : null;
}

/**
 * Pre-resolve plugins by calling the same `POST /api/plugins/lookup` endpoint
 * the deploy-time custom resource Lambda uses. Returning the full Plugin
 * record at synth time is what allows the resulting CFN template to ship
 * with real CodeBuild image URIs (`<host>/<ns>/<name>:<version>`) rather than
 * the `aws/codebuild/standard:7.0` fallback that the synth-time token path
 * forces.
 *
 * Failures are non-fatal: a missing plugin or unreachable API logs a warning
 * and falls through to the deploy-time custom resource path so partial
 * platform outages don't block synth/deploy. The exception is an image that
 * fails signature verification — that aborts the synth.
 *
 * Keyed by `alias || name` to match `PluginLookup.plugin()`.
 */
export async function resolvePluginsForProps(
  client: ApiClient,
  props: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const refs = collectPluginRefs(props);
  if (refs.length === 0) return {};

  const resolved: Record<string, unknown> = {};

  await Promise.all(refs.map(async (ref) => {
    const key = cacheKey(ref);
    const label = ref.publisher ? `${ref.publisher}/${ref.name}` : ref.name;
    // The plugin NAME lives on the ref (a sibling of `filter`), NOT inside the
    // filter object — but the lookup matches on the filter. A filter without
    // `name` (e.g. `{version, visibility, isActive, isDefault}`) matches ANY
    // plugin with those attributes, and the endpoint returns an arbitrary one
    // (seen: `dockerfile-multi-provider`). That made the synth and every step
    // resolve to the WRONG plugin. So when the filter omits `name`, fall back to
    // the ref's plugin name; an explicit filter `name` still takes precedence.
    // Shared with the pipeline service's contract check (same filter, same plugin).
    const filter = pluginLookupFilter(ref);
    try {
      const res = await client.post<unknown>('/api/plugins/lookup', { filter });
      // Unwrap the plugin record from whatever envelope the response middleware
      // applied. The platform's standard success envelope is
      // `{ success, statusCode, data: { plugin: Plugin } }` (note the DOUBLE
      // nesting: data.plugin), but tolerate `{ data: Plugin }`, `{ plugin }`,
      // and a bare Plugin too. Only stopping at `res.data` (which is
      // `{ plugin: ... }`) made `.name` undefined → every lookup fell back to
      // deploy-time resolution even though the catalog had the plugin.
      const data = (res as { data?: unknown }).data;
      const plugin =
        (data as { plugin?: unknown } | undefined)?.plugin // { data: { plugin } }
        ?? (res as { plugin?: unknown }).plugin // { plugin }
        ?? data // { data: Plugin }
        ?? res; // bare Plugin
      // Lifecycle warnings (deprecated / yanked-but-pinned) ride next to the
      // plugin in the same envelope: `{ data: { plugin, warnings } }`.
      for (const warning of lookupWarningsOf(data ?? res)) {
        printWarning(`Plugin "${label}": ${warning}`);
      }
      if (plugin && typeof plugin === 'object' && (plugin as { name?: string }).name) {
        resolved[key] = plugin;
      } else {
        printWarning(`Plugin "${label}" lookup returned no record — falling back to deploy-time resolution`);
      }
    } catch (err) {
      // A plugin whose image signature doesn't verify, or a listing the org
      // can't use, is NOT an outage to ride out: falling back would quietly
      // turn it into an unresolved step. Stop.
      const fatal = fatalLookupCode(err);
      if (fatal === ErrorCode.IMAGE_VERIFICATION_FAILED) {
        throw new Error(`Plugin "${label}" image failed signature verification: ${errorMessage(err)}`);
      }
      if (fatal) throw new Error(`Plugin "${label}" can't be used (${fatal}): ${errorMessage(err)}`);
      const msg = errorMessage(err);
      printWarning(`Plugin "${label}" pre-resolution failed (${msg}) — falling back to deploy-time resolution`);
    }
  }));

  return resolved;
}
