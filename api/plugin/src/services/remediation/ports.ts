// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the remediation engine needs from the outside world, as one injectable
 * object: kept sources, image builds (`--pull --no-cache`), the full build
 * gate's scan, image config reads, the smokeTest, digest resolution, lockfile
 * tool runs, image discard, the ask-agent fallback and the shared-base pass.
 * Production wiring is {@link liveRemediationPorts} (tooling.ts); tests pass fakes.
 */

import type { PluginScanFinding, PluginScanSummary, PluginBaseImage } from '@pipeline-builder/api-core';

import type { ToolRun } from './patchers/index.js';
import type { CandidateScan, ImageConfigFacts, PluginContractShape } from './verify.js';
import type { ImageFacts } from '../../helpers/image-facts.js';
import type { PluginRecordData } from '../../helpers/plugin-helpers.js';

/** An image of a plugin in its org's namespace, by digest. */
export interface ImageRef { orgId: string; name: string; digest: string }

/** A kept source, extracted and validated like an upload. */
export interface OpenedSource {
  /** The context root on disk. */
  dir: string;
  /** The Dockerfile path inside it ('' when the build type has none). */
  dockerfile: string;
  buildType: 'build_image' | 'prebuilt' | 'metadata_only';
  buildArgs: Record<string, string>;
}

/** The candidate's scan through the full build gate, with what persisting it needs. */
export interface GatedScan {
  scan: CandidateScan;
  /** Facts + summary for `persistVersion` (opaque to the engine). */
  facts: ImageFacts | null;
  summary: PluginScanSummary | null;
}

export interface RemediationPorts {
  fetchSource(row: { id?: string; sourceKey: string | null; sourceSha256: string | null; sourceKind: string }, destZip: string): Promise<'ok' | 'missing'>;
  openSource(zipPath: string, workRoot: string): Promise<OpenedSource>;
  /** The contract the (patched) context's plugin-spec declares; null when unreadable. */
  contractOf(contextDir: string): Promise<PluginContractShape | null>;
  /** Build and push (no cache, always pull) to the plugin's own repository under `version`; returns the digest. */
  build(input: { orgId: string; name: string; version: string; contextDir: string; dockerfile: string; buildArgs: Record<string, string> }): Promise<string>;
  /** Scan the pushed image and run the same floor (waivers, VEX) and compliance rules as a build. */
  scan(ref: ImageRef, record: PluginRecordData): Promise<GatedScan>;
  imageConfig(ref: ImageRef): Promise<ImageConfigFacts>;
  /** The image's layer ids (rootfs diff_ids), to tell a base layer's packages apart. */
  layerIds(imageRef: string): Promise<string[]>;
  smokeTest(ref: ImageRef, command: string): Promise<void>;
  /** The current digest of `image:tag` in the same registry, or null. */
  resolveDigest(imageWithTag: string): Promise<string | null>;
  /** Regenerate lockfiles in an isolated tool build; copies `outputs` back into `contextDir/dir`. */
  runTool(run: ToolRun, contextDir: string): Promise<void>;
  /** Remove a candidate image nobody will use (best-effort). */
  discardImage(ref: ImageRef): Promise<void>;
  /** `<registry>/<namespace>/<name>@<digest>`. */
  imageReference(ref: ImageRef): string;
  /** The ask-agent fallback (ECOSYSTEM's draftAskAgentPatch). */
  askAgent(input: { remediationId: string; orgId: string; workdir: string; findings: Parameters<typeof import('./ask-agent-patch.js').draftAskAgentPatch>[0]['findings'] }): Promise<{ diff: string } | null>;
  /**
   * The system-org shared-base pass: the rebuilt `base` (once per base and
   * findings set, under PLUGIN_REMEDIATION_BASE_CONCURRENCY), by digest — or
   * null when it could not be rebuilt (the dependant then continues without it).
   */
  ensureSharedBase(base: PluginBaseImage, findings: readonly PluginScanFinding[]): Promise<string | null>;
}
