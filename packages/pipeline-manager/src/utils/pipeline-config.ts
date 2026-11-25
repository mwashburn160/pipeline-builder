// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared pipeline-config resolution used by both `synth` and `deploy` so the two
 * commands fetch, plugin-resolve, registry-bake, and template-preview identically.
 */

import type { LookupToolchain, LookupWarning } from '@pipeline-builder/pipeline-core';
import type { ApiClient } from './api-client.js';
import { printInfo } from './output-utils.js';
import { resolvePluginsForProps } from './plugin-resolver.js';
import { bakePlatformRegistry } from './registry.js';
import { extractSingleResponse } from './response-utils.js';
import { assertOneRelease, resolveBootstrapImage } from './toolchain.js';
import type { Pipeline } from '../types/pipeline.js';

export interface FetchedPipeline {
  /** The raw pipeline record (id/org/project/flags) as returned by the platform. */
  readonly pipeline: Pipeline;
  /** props + pipelineId (+ orgId) + resolvedPlugins + resolvedBootstrap, with the registry pull-host baked in. */
  readonly propsWithIds: Record<string, unknown>;
  /** The resolved platform base URL the config was fetched against. */
  readonly baseUrl: string;
  /** Every graded lookup warning (already printed) — for the end-of-run summary. */
  readonly pluginWarnings: readonly LookupWarning[];
}

/**
 * Fetch a pipeline by id and build the synth/deploy props:
 *  - GET the pipeline and validate it has `props`,
 *  - assemble `propsWithIds` (props + pipelineId + orgId),
 *  - pre-resolve plugins so the template ships real CodeBuild image URIs
 *    (FATAL when any plugin does not resolve),
 *  - resolve the toolchain release's pipeline-bootstrap (FATAL on any
 *    failure, no fallback) with the same `toolchain.release` pin a managed cdk-synth
 *    reference sent, and check both halves are one release,
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

  const pluginWarnings: LookupWarning[] = [];
  const managedToolchains: Record<string, LookupToolchain> = {};
  const resolvedPlugins = await resolvePluginsForProps(client, propsWithIds, pluginWarnings, managedToolchains);
  if (Object.keys(resolvedPlugins).length > 0) {
    propsWithIds.resolvedPlugins = resolvedPlugins;
    printInfo('Pre-resolved plugins', { count: Object.keys(resolvedPlugins).length });
  }
  const resolvedBootstrap = await resolveBootstrapImage(client, propsWithIds, pluginWarnings);
  assertOneRelease(resolvedBootstrap, managedToolchains);
  propsWithIds.resolvedBootstrap = resolvedBootstrap;
  printInfo('Toolchain release', { release: resolvedBootstrap.toolchain.releaseVersion, via: resolvedBootstrap.toolchain.resolvedVia });

  bakePlatformRegistry(propsWithIds, config.api.baseUrl);
  return { pipeline, propsWithIds, baseUrl: config.api.baseUrl, pluginWarnings };
}

/**
 * Print `propsWithIds` as synth sees it (used by `synth --show-resolved` /
 * `deploy --show-resolved`): pipeline-core's `resolvePipelineProps` — the same
 * resolver PipelineBuilder runs at synth and the API's `?resolve=true` uses —
 * expands `project`, `vars.*` and metadata across `global` ←
 * `defaults.metadata` ← `synth.metadata`. Exits with code 1 when resolution
 * fails (unresolved reference or cycle).
 */
export async function printResolvedOrExit(propsWithIds: Record<string, unknown>): Promise<void> {
  const { resolvePipelineProps } = await import('@pipeline-builder/pipeline-core');
  let resolved: Record<string, unknown>;
  try {
    resolved = resolvePipelineProps(propsWithIds);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  console.log(JSON.stringify(resolved, null, 2));
}
