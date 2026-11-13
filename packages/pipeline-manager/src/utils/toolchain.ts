// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline's toolchain release (docs/plans/bootstrap-image-versioning.md §2, D2).
 *
 * `pipeline-bootstrap` (the default CodeBuild image) and `cdk-synth` (the synth
 * step) are one release. The bootstrap is not a step, so nothing else resolves
 * it: {@link resolveBootstrapImage} looks it up with the pipeline's
 * `toolchain.release` pin, and ANY failure stops the synth — the template has
 * no other image to fall back to.
 *
 * `pipeline deploy --local-spec` never contacts the platform, so it reads the
 * release from a file `pipeline-manager toolchain export` wrote instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ErrorCode, errorMessage } from '@pipeline-builder/api-core';
import {
  type LookupToolchain, type LookupWarning, type ResolvedBootstrap, parseLookupToolchain, pluginArtifactAlias, unwrapLookup,
} from '@pipeline-builder/pipeline-core';
import type { ApiClient } from './api-client.js';
import { PluginResolutionError, isManagedToolchainRef, printLookupWarning, serviceErrorCode, toolchainReleasePin } from './plugin-resolver.js';
import { bakePlatformRegistry } from './registry.js';

export const BOOTSTRAP_PLUGIN = 'pipeline-bootstrap';
export const SYNTH_PLUGIN = 'cdk-synth';

/** The step key the bootstrap's lookup warnings are recorded against (the pipeline's "Build image" row). */
export const BUILD_IMAGE_STEP_KEY = 'build-image';

/** `toolchain export` file format version. */
export const TOOLCHAIN_FILE_FORMAT = 1;

/** A plugin record as the lookup returned it (opaque here; pipeline-core reads it). */
type PluginRecord = ResolvedBootstrap['plugin'];

/** One half of an exported release. */
export interface ToolchainFileHalf {
  readonly name: string;
  readonly version: string;
  readonly imageRepository: string;
  readonly imageDigest: string;
  /** The full lookup record — what the synth consumes. */
  readonly plugin: PluginRecord;
}

/** What `pipeline-manager toolchain export` writes and `--toolchain-file` reads. */
export interface ToolchainFile {
  readonly format: typeof TOOLCHAIN_FILE_FORMAT;
  readonly releaseVersion: string;
  readonly resolvedVia: LookupToolchain['resolvedVia'];
  readonly toolchain: LookupToolchain['versions'];
  readonly exportedAt: string;
  /**
   * The platform the release was exported from. Its host is the registry
   * CodeBuild pulls both images from, so a local-spec deploy bakes it as the
   * pull host (unless IMAGE_REGISTRY_PULL_HOST is set), like a platform deploy.
   */
  readonly platformBaseUrl?: string;
  readonly bootstrap: ToolchainFileHalf;
  readonly synth: ToolchainFileHalf;
}

/** The refusal every failure here raises — one code, so `PB_SYNTH_FAILURE` reports it uniformly. */
export function bootstrapUnresolved(message: string, code: string = ErrorCode.BOOTSTRAP_IMAGE_UNRESOLVED): PluginResolutionError {
  return new PluginResolutionError([{ plugin: BOOTSTRAP_PLUGIN, code, message }]);
}

/** Look up one managed half. Throws {@link bootstrapUnresolved} on any failure. */
async function lookupManaged(
  client: ApiClient,
  name: string,
  releasePin: string | undefined,
  context?: { pipelineId: string; stepKeys: string[] },
): Promise<{ plugin: PluginRecord; toolchain: LookupToolchain; warnings: LookupWarning[] }> {
  const what = `${name}${releasePin ? ` (release ${releasePin})` : ''}`;
  let res: unknown;
  try {
    res = await client.post<unknown>('/api/plugins/lookup', {
      filter: { name },
      ...(releasePin ? { releasePin } : {}),
      ...(context ? { context } : {}),
    });
  } catch (err) {
    const code = serviceErrorCode(err);
    const status = (err as { response?: { status?: unknown } } | undefined)?.response?.status;
    const why = code === ErrorCode.TOOLCHAIN_NO_DEFAULT
      ? 'the platform has no default toolchain release (an operator sets one with `deploy/bin/init-platform.sh` or the Toolchain console)'
      : status === 404 && releasePin
        ? `release ${releasePin} does not exist (deleted) — pin another release or clear the pipeline's toolchain.release`
        : errorMessage(err);
    throw bootstrapUnresolved(`Toolchain ${what} could not be resolved: ${why}`);
  }
  const { plugin, warnings, toolchain } = unwrapLookup(res);
  if (!plugin || plugin.name !== name) throw bootstrapUnresolved(`Toolchain ${what} could not be resolved: the lookup returned no ${name} record`);
  if (!toolchain) throw bootstrapUnresolved(`Toolchain ${what} could not be resolved: the answer carried no toolchain release`);
  if (releasePin && toolchain.releaseVersion !== releasePin) {
    throw bootstrapUnresolved(`Toolchain ${what} resolved to release ${toolchain.releaseVersion}, not the pinned ${releasePin}`, ErrorCode.TOOLCHAIN_PAIR_MISMATCH);
  }
  return { plugin, toolchain, warnings };
}

/**
 * Resolve the pipeline's `pipeline-bootstrap` through `/plugins/lookup` with
 * `releasePin = props.toolchain?.release`. FATAL on any failure
 * (`BOOTSTRAP_IMAGE_UNRESOLVED`): unreachable platform, no default (409
 * `TOOLCHAIN_NO_DEFAULT`), a deleted pin (404), a refused signature, or an
 * answer without a release. Warnings are printed, appended to `warningSink`,
 * and — with a `pipelineId` — recorded by the platform on the pipeline's
 * "Build image" row (`context.stepKeys: ['build-image']`).
 */
export async function resolveBootstrapImage(
  client: ApiClient,
  props: Record<string, unknown>,
  warningSink?: LookupWarning[],
): Promise<ResolvedBootstrap> {
  const pipelineId = typeof props.pipelineId === 'string' && props.pipelineId.length > 0 ? props.pipelineId : undefined;
  const { plugin, toolchain, warnings } = await lookupManaged(
    client, BOOTSTRAP_PLUGIN, toolchainReleasePin(props),
    pipelineId ? { pipelineId, stepKeys: [BUILD_IMAGE_STEP_KEY] } : undefined,
  );
  for (const warning of warnings) {
    printLookupWarning(BOOTSTRAP_PLUGIN, warning);
    warningSink?.push(warning);
  }
  return { plugin, toolchain };
}

/** The managed synth reference of a pipeline's props, when its synth plugin is `cdk-synth`. */
export function managedSynthKey(props: Record<string, unknown>): string | null {
  const ref = (props.synth as { plugin?: { name?: string; publisher?: string; alias?: string; filter?: Record<string, unknown> } } | undefined)?.plugin;
  if (!ref?.name || !isManagedToolchainRef(ref)) return null;
  return pluginArtifactAlias(ref as { name: string });
}

/**
 * Both halves of one release must agree. A managed `cdk-synth` that resolved
 * to a different release than the bootstrap is refused (never served).
 */
export function assertOneRelease(bootstrap: ResolvedBootstrap, synthToolchains: Record<string, LookupToolchain>): void {
  for (const [key, synth] of Object.entries(synthToolchains)) {
    if (synth.releaseVersion !== bootstrap.toolchain.releaseVersion) {
      throw bootstrapUnresolved(
        `Toolchain halves disagree: pipeline-bootstrap is release ${bootstrap.toolchain.releaseVersion} but "${key}" is ${synth.releaseVersion}`,
        ErrorCode.TOOLCHAIN_PAIR_MISMATCH,
      );
    }
  }
}

function half(plugin: PluginRecord): ToolchainFileHalf {
  const rec = plugin as PluginRecord & { imageRepository?: string | null; imageDigest?: string | null };
  return {
    name: rec.name,
    version: rec.version,
    imageRepository: rec.imageRepository ?? '',
    imageDigest: rec.imageDigest ?? '',
    plugin,
  };
}

/**
 * Resolve both halves of a release for export: `release` when given, else
 * whatever the caller's org resolves to now (its default, canary or the
 * platform default). Both lookups send the same pin; when no pin is given the
 * bootstrap's release becomes the synth's pin, so the halves always match.
 */
export async function exportToolchain(client: ApiClient, release?: string): Promise<ToolchainFile> {
  const bootstrap = await lookupManaged(client, BOOTSTRAP_PLUGIN, release);
  const synth = await lookupManaged(client, SYNTH_PLUGIN, release ?? bootstrap.toolchain.releaseVersion);
  assertOneRelease({ plugin: bootstrap.plugin, toolchain: bootstrap.toolchain }, { [SYNTH_PLUGIN]: synth.toolchain });
  return {
    format: TOOLCHAIN_FILE_FORMAT,
    releaseVersion: bootstrap.toolchain.releaseVersion,
    resolvedVia: bootstrap.toolchain.resolvedVia,
    toolchain: { ...synth.toolchain.versions, ...bootstrap.toolchain.versions },
    exportedAt: new Date().toISOString(),
    ...(client.getConfig().api.baseUrl ? { platformBaseUrl: client.getConfig().api.baseUrl } : {}),
    bootstrap: half(bootstrap.plugin),
    synth: half(synth.plugin),
  };
}

const HOW_TO_EXPORT = 'Produce one with `pipeline-manager toolchain export --output toolchain.json` (add `--release <V>` to pin a release) '
  + 'against the platform, then pass `--toolchain-file toolchain.json`.';

/** The local-spec refusal when no `--toolchain-file` was given. */
export function toolchainFileRequired(): PluginResolutionError {
  return bootstrapUnresolved(`--local-spec deploys without the platform, so the toolchain release must come from --toolchain-file. ${HOW_TO_EXPORT}`);
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Read and check a `toolchain export` file: both halves present, named right,
 * digest-pinned, and of one release. Any problem is `BOOTSTRAP_IMAGE_UNRESOLVED`.
 */
export function readToolchainFile(file: string): { bootstrap: ResolvedBootstrap; synth: PluginRecord; platformBaseUrl?: string } {
  const abs = path.resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch (err) {
    throw bootstrapUnresolved(`Can't read --toolchain-file ${abs}: ${errorMessage(err)}. ${HOW_TO_EXPORT}`);
  }
  const bad = (why: string): never => { throw bootstrapUnresolved(`--toolchain-file ${abs} is not a toolchain export: ${why}. ${HOW_TO_EXPORT}`); };
  const f = raw as Partial<ToolchainFile> | null;
  if (!f || typeof f !== 'object') bad('not a JSON object');
  if (f!.format !== TOOLCHAIN_FILE_FORMAT) bad(`unsupported format ${String(f!.format)}`);
  const toolchain = parseLookupToolchain({ releaseVersion: f!.releaseVersion, resolvedVia: f!.resolvedVia, versions: f!.toolchain });
  if (!toolchain) bad('missing releaseVersion / resolvedVia');
  const check = (h: ToolchainFileHalf | undefined, name: string): PluginRecord => {
    if (!h?.plugin || h.plugin.name !== name || h.name !== name) bad(`missing the ${name} half`);
    if (h!.version !== toolchain!.releaseVersion || h!.plugin.version !== toolchain!.releaseVersion) bad(`${name} is not release ${toolchain!.releaseVersion}`);
    const rec = h!.plugin as PluginRecord & { imageDigest?: string | null; imageRepository?: string | null };
    if (!rec.imageDigest || !DIGEST_RE.test(rec.imageDigest) || rec.imageDigest !== h!.imageDigest) bad(`${name} has no signed image digest`);
    if (rec.imageRepository !== `system/${name}` || h!.imageRepository !== rec.imageRepository) bad(`${name} is not system/${name}`);
    return h!.plugin;
  };
  const bootstrap = check(f!.bootstrap, BOOTSTRAP_PLUGIN);
  const synth = check(f!.synth, SYNTH_PLUGIN);
  const platformBaseUrl = typeof f!.platformBaseUrl === 'string' && f!.platformBaseUrl.length > 0 ? f!.platformBaseUrl : undefined;
  return { bootstrap: { plugin: bootstrap, toolchain: toolchain! }, synth, ...(platformBaseUrl && { platformBaseUrl }) };
}

/**
 * Apply a toolchain file to local-spec props: the bootstrap as
 * `resolvedBootstrap`, the exporting platform as the registry pull host, and —
 * when the synth plugin is the managed `cdk-synth` — the exported synth half
 * as its pre-resolved plugin.
 */
export function applyToolchainFile(props: Record<string, unknown>, file: string): ToolchainFile['releaseVersion'] {
  const { bootstrap, synth, platformBaseUrl } = readToolchainFile(file);
  const pin = toolchainReleasePin(props);
  if (pin && pin !== bootstrap.toolchain.releaseVersion) {
    throw bootstrapUnresolved(
      `The pipeline pins toolchain release ${pin} but --toolchain-file holds ${bootstrap.toolchain.releaseVersion}. `
      + `Export the pinned one: \`pipeline-manager toolchain export --release ${pin}\`.`,
      ErrorCode.TOOLCHAIN_PAIR_MISMATCH,
    );
  }
  props.resolvedBootstrap = bootstrap;
  bakePlatformRegistry(props, platformBaseUrl);
  const synthKey = managedSynthKey(props);
  if (synthKey) {
    props.resolvedPlugins = { ...(props.resolvedPlugins as Record<string, unknown> | undefined), [synthKey]: synth };
  }
  return bootstrap.toolchain.releaseVersion;
}
