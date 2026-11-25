// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed toolchain release's GENERATED spec fields, computed exactly as
 * `deploy/bin/sync-image-tags.sh --toolchain-only` computes them (pure; the
 * digest resolver is injected):
 *
 *  - `sourceDigest`: a SHA-256 over both directories' build inputs — every
 *    top-level file except image.tar, plugin.zip, config.yaml, README.md and
 *    .DS_Store, pipeline-bootstrap first, names sorted, each framed as
 *    "<dir>/<file>\n" + its lines, with the specs' version / toolchain /
 *    sourceDigest / changelog and cdk-synth's `ARG BOOTSTRAP_IMAGE=` default
 *    normalised out (test/deploy-contracts toolchain-drift-contract holds the
 *    same rule; the tests here recompute the checked-in digest);
 *  - `toolchain`: the bootstrap Dockerfile's pinned ARGs (Node from the tag of
 *    the digest-pinned `ARG NODE_IMAGE`);
 *  - the rewrite: `version:` in both specs, the bootstrap spec's `toolchain` and
 *    `sourceDigest` blocks re-appended at its end, cdk-synth's
 *    `ARG BOOTSTRAP_IMAGE="pipeline-bootstrap:<release>"` — plain text edits of
 *    exactly those keys, never a YAML re-serialisation.
 *
 * The nightly toolchain fix uses it to record the spec change a release
 * candidate implies, as a patch the release workflow applies to
 * deploy/toolchain/** (GET /plugins/toolchain-fixes/:id/export).
 */

import { createHash } from 'crypto';

import type { PluginToolchain } from '@pipeline-builder/api-core';

import { treeDiff, type FileMap } from './diff.js';

export const TOOLCHAIN_DIRS = ['pipeline-bootstrap', 'cdk-synth'] as const;
export type ToolchainDir = typeof TOOLCHAIN_DIRS[number];
/** Both halves' build inputs (top-level file name → text). */
export type ToolchainTrees = Readonly<Record<ToolchainDir, FileMap>>;

/** Files that are never build inputs (build outputs, the build-flipped config.yaml, docs). */
export const TOOLCHAIN_INPUT_EXCLUDED: ReadonlySet<string> = new Set(['image.tar', 'plugin.zip', 'config.yaml', 'README.md', '.DS_Store']);

/** The repository path of each half's directory (the export's root). */
export const TOOLCHAIN_REPO_DIR = (d: ToolchainDir): string => `deploy/toolchain/${d}/`;

const GENERATED_SPEC_KEY = /^(version|toolchain|sourceDigest|changelog):/;
/** The cdk-synth spec's derived `pb:deploy-job:protocol` metadata line — excluded exactly as sync-image-tags.sh does. */
const DEPLOY_JOB_PROTOCOL_LINE = /^[ \t]+["']?pb:deploy-job:protocol["']?:/;

/** A tree's build inputs: top-level files only, minus {@link TOOLCHAIN_INPUT_EXCLUDED}. */
export function toolchainInputsOf(tree: FileMap): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of tree) if (!k.includes('/') && !TOOLCHAIN_INPUT_EXCLUDED.has(k)) out.set(k, v);
  return out;
}

/** awk's view of a file: its lines, each to be newline-terminated (a final newline adds no empty line). */
function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function normalised(dir: ToolchainDir, file: string, text: string): string[] {
  const mode = file === 'plugin-spec.yaml' ? 'spec' : (dir === 'cdk-synth' && file === 'Dockerfile' ? 'synth-dockerfile' : 'plain');
  const out: string[] = [];
  let skip = false;
  for (const line of linesOf(text)) {
    if (mode === 'spec') {
      if (skip) {
        if (/^[ \t]/.test(line) || line === '') continue;
        skip = false;
      }
      if (GENERATED_SPEC_KEY.test(line)) { skip = true; continue; }
      // cdk-synth metadata pb:deploy-job:protocol: what the image prints, not a
      // build input (build-plugin-images.sh refuses a value the image does not).
      if (DEPLOY_JOB_PROTOCOL_LINE.test(line)) continue;
    }
    if (mode === 'synth-dockerfile' && /^ARG BOOTSTRAP_IMAGE=/.test(line)) { out.push('ARG BOOTSTRAP_IMAGE=<generated>'); continue; }
    out.push(line);
  }
  return out;
}

/** `sha256:<hex>` over both halves' build inputs (generated fields excluded), as sync-image-tags.sh computes it. */
export function toolchainSourceDigest(trees: ToolchainTrees): string {
  const hash = createHash('sha256');
  for (const dir of TOOLCHAIN_DIRS) {
    const inputs = toolchainInputsOf(trees[dir]);
    // `ls -A | LC_ALL=C sort`: byte order.
    for (const file of [...inputs.keys()].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : Buffer.from(a) > Buffer.from(b) ? 1 : 0))) {
      hash.update(`${dir}/${file}\n`);
      hash.update(normalised(dir, file, inputs.get(file)!).map((l) => `${l}\n`).join(''));
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

/** One `ARG <name>=` value of a Dockerfile (exactly one such line, quoted or not), or null. */
function argValue(dockerfile: string, name: string): string | null {
  const re = new RegExp(`^ARG ${name}="?([^" ]+)"?[ \\t]*$`);
  const hits = linesOf(dockerfile).filter((l) => l.startsWith(`ARG ${name}=`));
  if (hits.length !== 1) return null;
  return re.exec(hits[0]!.replace(/\r$/, ''))?.[1] ?? null;
}

/** The toolchain the bootstrap Dockerfile pins (what sync-image-tags.sh writes into the spec), or null. */
export function toolchainFromDockerfile(dockerfile: string): PluginToolchain | null {
  const pipelineManager = argValue(dockerfile, 'PIPELINE_MANAGER_VERSION');
  const awsCdk = argValue(dockerfile, 'AWS_CDK_VERSION');
  const cdkAssets = argValue(dockerfile, 'CDK_ASSETS_VERSION');
  const node = /^node:(\d+\.\d+\.\d+)-/.exec(argValue(dockerfile, 'NODE_IMAGE') ?? '')?.[1] ?? null;
  return pipelineManager && awsCdk && cdkAssets && node ? { pipelineManager, awsCdk, cdkAssets, node } : null;
}

const PINNED_IMAGE = /^(ARG NODE_IMAGE=)("?)([^"\s@]+:[^"\s@]+)@(sha256:[0-9a-f]{64})("?)(\s*)$/;

/**
 * Stage 1's base refresh for the bootstrap's `FROM ${NODE_IMAGE}`: the
 * digest-pinned ARG default re-resolved to the CURRENT digest of the same
 * image and tag (never a new tag, so Node's version cannot move). The engine's
 * own refresh skips build-arg FROMs. Null when nothing changed.
 */
export async function refreshNodeImage(
  dockerfile: string,
  resolveDigest: (imageWithTag: string) => Promise<string | null>,
): Promise<{ dockerfile: string; from: string; to: string } | null> {
  const lines = dockerfile.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = PINNED_IMAGE.exec(lines[i]!.replace(/\r$/, ''));
    if (!m) continue;
    const current = await resolveDigest(m[3]!).catch(() => null);
    if (!current || !/^sha256:[0-9a-f]{64}$/.test(current) || current === m[4]) return null;
    const from = `${m[3]}@${m[4]}`;
    const to = `${m[3]}@${current}`;
    lines[i] = `${m[1]}${m[2]}${to}${m[5]}${m[6] ?? ''}${lines[i]!.endsWith('\r') ? '\r' : ''}`;
    return { dockerfile: lines.join('\n'), from, to };
  }
  return null;
}

/** The bootstrap spec with `version`, `toolchain` and `sourceDigest` rewritten exactly as the sync script writes them. */
export function rewriteBootstrapSpec(spec: string, release: string, toolchain: PluginToolchain, sourceDigest: string): string {
  const versioned = spec.split('\n').map((l) => (/^version:/.test(l) ? `version: ${release}` : l));
  if (versioned[versioned.length - 1] === '') versioned.pop();
  const kept: string[] = [];
  let skip = false;
  for (const line of versioned) {
    if (skip) {
      if (/^[ \t]/.test(line) || line === '') continue;
      skip = false;
    }
    if (/^(toolchain|sourceDigest):/.test(line)) { skip = true; continue; }
    kept.push(line);
  }
  return [
    ...kept,
    'toolchain:',
    `  pipelineManager: "${toolchain.pipelineManager}"`,
    `  awsCdk: "${toolchain.awsCdk}"`,
    `  cdkAssets: "${toolchain.cdkAssets}"`,
    `  node: "${toolchain.node}"`,
    `sourceDigest: "${sourceDigest}"`,
  ].map((l) => `${l}\n`).join('');
}

/** cdk-synth's spec with its `version` line moved to the release. */
export function rewriteSynthSpec(spec: string, release: string): string {
  return spec.split('\n').map((l) => (/^version:/.test(l) ? `version: ${release}` : l)).join('\n');
}

/** cdk-synth's out-of-script default base: the same release, by its version tag. */
export function rewriteSynthDockerfile(dockerfile: string, release: string): string {
  return dockerfile.split('\n').map((l) => (/^ARG BOOTSTRAP_IMAGE=/.test(l) ? `ARG BOOTSTRAP_IMAGE="pipeline-bootstrap:${release}"` : l)).join('\n');
}

export interface ToolchainSpecChange {
  /** Both halves' inputs as the release workflow should commit them. */
  final: Record<ToolchainDir, Map<string, string>>;
  sourceDigest: { from: string | null; to: string };
  /** The toolchain the patched bootstrap Dockerfile pins (null = unreadable). */
  toolchain: PluginToolchain | null;
  /** A unified diff rooted at the repository (deploy/toolchain/<half>/…), `git apply`-able. */
  diff: string;
}

/**
 * The spec change sync-image-tags.sh --toolchain-only would make for a
 * candidate: the patched inputs, the release bumped to `toRelease` (a fix is
 * always a new release, even a rebuild that changed no input), the toolchain
 * block from the patched ARGs and the recomputed sourceDigest.
 */
export function toolchainSpecChange(input: { original: ToolchainTrees; patched: ToolchainTrees; toRelease: string }): ToolchainSpecChange {
  const original = { 'pipeline-bootstrap': toolchainInputsOf(input.original['pipeline-bootstrap']), 'cdk-synth': toolchainInputsOf(input.original['cdk-synth']) };
  const patched = { 'pipeline-bootstrap': toolchainInputsOf(input.patched['pipeline-bootstrap']), 'cdk-synth': toolchainInputsOf(input.patched['cdk-synth']) };
  const sourceDigest = toolchainSourceDigest(patched);
  const bsDockerfile = patched['pipeline-bootstrap'].get('Dockerfile') ?? '';
  const toolchain = toolchainFromDockerfile(bsDockerfile);
  const final = { 'pipeline-bootstrap': new Map(patched['pipeline-bootstrap']), 'cdk-synth': new Map(patched['cdk-synth']) };
  const bsSpec = final['pipeline-bootstrap'].get('plugin-spec.yaml');
  if (bsSpec !== undefined && toolchain) final['pipeline-bootstrap'].set('plugin-spec.yaml', rewriteBootstrapSpec(bsSpec, input.toRelease, toolchain, sourceDigest));
  const synthSpec = final['cdk-synth'].get('plugin-spec.yaml');
  if (synthSpec !== undefined) final['cdk-synth'].set('plugin-spec.yaml', rewriteSynthSpec(synthSpec, input.toRelease));
  const synthDf = final['cdk-synth'].get('Dockerfile');
  if (synthDf !== undefined) final['cdk-synth'].set('Dockerfile', rewriteSynthDockerfile(synthDf, input.toRelease));
  const recorded = /^sourceDigest:\s*"?([^"\s]+)"?\s*$/m.exec(original['pipeline-bootstrap'].get('plugin-spec.yaml') ?? '')?.[1] ?? null;
  const diff = TOOLCHAIN_DIRS.map((d) => treeDiff(original[d], final[d], TOOLCHAIN_REPO_DIR(d))).join('');
  return { final, sourceDigest: { from: recorded, to: sourceDigest }, toolchain, diff };
}
