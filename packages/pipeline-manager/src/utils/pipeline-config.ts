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
 *    (otherwise CDK falls back to standard:7.0 at deploy time),
 *  - resolve the toolchain release's pipeline-bootstrap (FATAL on any
 *    failure, D2) with the same `toolchain.release` pin a managed cdk-synth
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
 * Apply pass-1 self-referencing template resolution to `propsWithIds` and print it
 * to stdout (used by `synth --show-resolved` / `deploy --show-resolved`). Exits with
 * code 1 if resolution reports errors. `resolveSelfReferencing` mutates the object
 * in place, so the printed JSON reflects the expanded templates.
 */
export async function printResolvedOrExit(propsWithIds: Record<string, unknown>): Promise<void> {
  const { resolveSelfReferencing } = await import('@pipeline-builder/pipeline-core');
  const scope = { metadata: propsWithIds.metadata ?? {}, vars: propsWithIds.vars ?? {} };
  const isTpl = (f: string) => f === 'projectName' || f.startsWith('metadata.') || f.startsWith('vars.');
  const result = resolveSelfReferencing(propsWithIds, scope, isTpl, (f: string) => (isTpl(f) ? f : null));
  if (result.errors.length) {
    console.error('Resolution errors:');
    for (const e of result.errors) console.error(`  [${e.field ?? '?'}] ${e.message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(propsWithIds, null, 2));
}
