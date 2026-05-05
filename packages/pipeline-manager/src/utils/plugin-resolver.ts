// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ApiClient } from './api-client';
import { printWarning } from './output-utils';

/** Minimal plugin reference shape — matches PluginOptions from pipeline-core. */
interface PluginRef {
  name: string;
  alias?: string;
  filter?: Record<string, unknown>;
}

/**
 * Cache key matching `PluginLookup.normalize()`: explicit alias when set,
 * otherwise `${name}-alias`. Must stay in sync with the consumers in
 * pipeline-core/plugin-lookup.ts and pipeline-builder.ts that read this map.
 */
function cacheKey(ref: PluginRef): string {
  return ref.alias || `${ref.name}-alias`;
}

/**
 * Walk the pipeline props tree to collect every plugin reference. Plugins
 * appear at `synth.plugin` and at `stages[].steps[].plugin`. Entries are
 * de-duplicated by `cacheKey()` — the same key `PluginLookup.plugin()` uses,
 * so the resolved-plugins map lookups match downstream.
 */
function collectPluginRefs(props: Record<string, unknown>): PluginRef[] {
  const refs: PluginRef[] = [];
  const seen = new Set<string>();

  const push = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as PluginRef;
    if (!r.name) return;
    const key = cacheKey(r);
    if (seen.has(key)) return;
    seen.add(key);
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
 * Pre-resolve plugins by calling the same `POST /api/plugins/lookup` endpoint
 * the deploy-time custom resource Lambda uses. Returning the full Plugin
 * record at synth time is what allows the resulting CFN template to ship
 * with real CodeBuild image URIs (`<host>/<imageTag>:latest`) rather than
 * the `aws/codebuild/standard:7.0` fallback that the synth-time token path
 * forces.
 *
 * Failures are non-fatal: a missing plugin or unreachable API logs a warning
 * and falls through to the deploy-time custom resource path so partial
 * platform outages don't block synth/deploy.
 *
 * Keyed by `alias || name` to match `PluginLookup.plugin()`.
 */
export async function resolvePluginsForProps(
  client: ApiClient,
  props: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const refs = collectPluginRefs(props);
  if (refs.length === 0) return {};

  const defaultFilter = (name: string) => ({ name, isActive: true, isDefault: true });
  const resolved: Record<string, unknown> = {};

  await Promise.all(refs.map(async (ref) => {
    const key = cacheKey(ref);
    const filter = ref.filter ?? defaultFilter(ref.name);
    try {
      const res = await client.post<unknown>('/api/plugins/lookup', { filter });
      // Lambda's handler calls `api.post<Plugin>(...)` and consumes the body
      // directly; the platform may wrap it as `{ data: Plugin }` or
      // `{ plugin: Plugin }` depending on the response middleware.
      const plugin = (res as { plugin?: unknown }).plugin
        ?? (res as { data?: unknown }).data
        ?? res;
      if (plugin && typeof plugin === 'object' && (plugin as { name?: string }).name) {
        resolved[key] = plugin;
      } else {
        printWarning(`Plugin "${ref.name}" lookup returned no record — falling back to deploy-time resolution`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      printWarning(`Plugin "${ref.name}" pre-resolution failed (${msg}) — falling back to deploy-time resolution`);
    }
  }));

  return resolved;
}
