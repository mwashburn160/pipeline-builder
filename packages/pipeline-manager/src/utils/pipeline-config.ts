// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared pipeline-config resolution used by both `synth` and `deploy` so the two
 * commands fetch, plugin-resolve, registry-bake, and template-preview identically
 * (they previously kept near-duplicate copies that could drift).
 */

import type { ApiClient } from './api-client.js';
import { extractSingleResponse, printInfo } from './output-utils.js';
import { resolvePluginsForProps } from './plugin-resolver.js';
import { bakePlatformRegistry } from './registry.js';
import type { Pipeline } from '../types/pipeline.js';

export interface FetchedPipeline {
  /** The raw pipeline record (id/org/project/flags) as returned by the platform. */
  readonly pipeline: Pipeline;
  /** props + pipelineId (+ orgId) + resolvedPlugins, with the registry pull-host baked in. */
  readonly propsWithIds: Record<string, unknown>;
  /** The resolved platform base URL the config was fetched against. */
  readonly baseUrl: string;
}

/**
 * Fetch a pipeline by id and build the synth/deploy props:
 *  - GET the pipeline and validate it has `props`,
 *  - assemble `propsWithIds` (props + pipelineId + orgId),
 *  - pre-resolve plugins so the template ships real CodeBuild image URIs
 *    (otherwise CDK falls back to standard:7.0 at deploy time),
 *  - bake the registry pull-host from the platform URL (no-op when
 *    IMAGE_REGISTRY_PULL_HOST is set).
 */
export async function fetchPipelineProps(client: ApiClient, pipelineId: string): Promise<FetchedPipeline> {
  const config = client.getConfig();
  const response = await client.get<Record<string, unknown>>(`${config.api.pipelineUrl}/${pipelineId}`);
  const pipeline = extractSingleResponse<Pipeline>(response, 'pipeline', 'props');
  if (!pipeline?.props) {
    throw new Error(`Failed to retrieve pipeline props for ID: ${pipelineId}`);
  }

  const propsWithIds: Record<string, unknown> = {
    ...(pipeline.props as Record<string, unknown>),
    ...(pipeline.orgId ? { orgId: pipeline.orgId } : {}),
    pipelineId: pipeline.id || pipelineId,
  };

  const resolvedPlugins = await resolvePluginsForProps(client, propsWithIds);
  if (Object.keys(resolvedPlugins).length > 0) {
    propsWithIds.resolvedPlugins = resolvedPlugins;
    printInfo('Pre-resolved plugins', { count: Object.keys(resolvedPlugins).length });
  }

  bakePlatformRegistry(propsWithIds, config.api.baseUrl);
  return { pipeline, propsWithIds, baseUrl: config.api.baseUrl };
}

/**
 * Apply pass-1 self-referencing template resolution to `propsWithIds` and print it
 * to stdout (used by `synth --show-resolved` / `deploy --show-resolved`). Exits with
 * code 1 if resolution reports errors. `resolveSelfReferencing` mutates the object
 * in place, so the printed JSON reflects the expanded templates.
 */
export async function printResolvedOrExit(propsWithIds: Record<string, unknown>): Promise<void> {
  const { resolveSelfReferencing } = await import('@pipeline-builder/pipeline-core');
  const scope = { metadata: propsWithIds.metadata ?? {}, vars: propsWithIds.vars ?? {} };
  const isTpl = (f: string) => f === 'projectName' || f.startsWith('metadata.') || f.startsWith('vars.');
  const result = resolveSelfReferencing(propsWithIds, scope, isTpl, (f: string) => (isTpl(f) ? f : null), 'pipeline');
  if (result.errors.length) {
    console.error('Resolution errors:');
    for (const e of result.errors) console.error(`  [${e.field ?? '?'}] ${e.message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(propsWithIds, null, 2));
}
