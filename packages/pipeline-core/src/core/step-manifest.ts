// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Step manifest (plugin-ecosystem W0.1): which plugin each CodePipeline action
 * of a deployed pipeline runs. CDK-free half — the shapes and helpers shared by
 * the synth (which records it, see `pipeline/step-manifest-recorder.ts`), the
 * CLI (which ships it with the registry registration) and the pipeline service
 * (which validates and stores it in `pipeline_step_manifests`).
 *
 * Event ingest joins `pipeline_events` on (pipeline_id, stage_name,
 * action_name), so `stageName`/`actionName` here are read off the BUILT
 * CodePipeline, never recomputed from our own ids — they are exactly the names
 * CodePipeline state-change events report.
 */

import { SYSTEM_ORG_ID } from '@pipeline-builder/api-core';

/**
 * File the synth app writes the manifest to, inside the cloud assembly
 * directory (`cdk deploy --output=<dir>`). The CLI reads it back after a
 * successful deploy and forwards it on the registry POST.
 */
export const STEP_MANIFEST_FILE = 'pb-step-manifest.json';

/**
 * `id` of every synthesized placeholder plugin (PluginLookup `fallback()` /
 * `bootstrap()`) — a record standing in for a lookup that could not resolve at
 * synth. Never a real `plugins` row, so the step manifest never records it.
 */
export const PLACEHOLDER_PLUGIN_ID = '00000000-0000-0000-0000-000000000000';

/**
 * One manifest entry as the synth records it. Carries the resolved plugin
 * record's id so the pipeline service can re-resolve the authoritative
 * name/version/digest/owner itself — the CLI's claim is never trusted for
 * anything that feeds cross-org stats (publisher, verified use).
 */
export interface StepManifestEntry {
  /** CodePipeline stage name, as the built pipeline names it. */
  readonly stageName: string;
  /** CodePipeline action name, as the built pipeline names it. */
  readonly actionName: string;
  /** `plugins.id` of the resolved plugin record. */
  readonly pluginId: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  /** Signed image digest the step is pinned to; null for image-less plugins. */
  readonly imageDigest: string | null;
}

/** The plugin fields {@link pluginImageRepository} reads. */
export interface PluginImageRef {
  readonly orgId: string;
  readonly name: string;
  readonly buildType?: string | null;
}

/**
 * Registry repository an org-owned plugin ROW's image lives at
 * (`<namespace>/<name>`, no host, no digest): the system org's under
 * `system/`, a tenant's under `org-<orgId>/`. Must match the push side
 * (api/plugin `pluginUri`). Returns null for a `metadata_only` plugin.
 *
 * Only for rows the caller's org resolves as its OWN (or its parent's): the
 * plugin lookup stamps it as the record's `imageRepository`. A listed plugin's
 * repository is its listing version's `public/<publisher>/<name>` copy —
 * synth never derives a repository itself (G30).
 */
export function pluginImageRepository(plugin: PluginImageRef): string | null {
  if (plugin.buildType === 'metadata_only') return null;
  const namespace = plugin.orgId === SYSTEM_ORG_ID ? 'system' : `org-${plugin.orgId}`;
  return `${namespace}/${plugin.name}`;
}

/** A plugin image repository lookup may return: `public/<publisher>/<name>`, `org-<id>/<name>` or `system/<name>`. */
export const PLUGIN_IMAGE_REPOSITORY_RE = /^(?:public\/[a-z0-9]+(?:-[a-z0-9]+)*|org-[a-z0-9][a-z0-9-]*|system)\/[a-z0-9][a-z0-9._-]*$/;
