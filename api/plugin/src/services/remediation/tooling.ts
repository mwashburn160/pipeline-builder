// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The production {@link RemediationPorts}: buildctl / crane against the
 * platform registry and buildkitd, the same scan + floor + compliance the build
 * worker runs (helpers/image-facts, image-gates), kept sources (plugin-sources),
 * the ask-agent fallback and the shared-base pass.
 *
 * Builds differ from an upload build in exactly the two ways the plan asks for:
 * `--no-cache` and `image-resolve-mode=pull` (a fresh base of the same tag).
 * Lockfile regeneration runs in its own throwaway buildkit build (the tool image
 * for the ecosystem, the context copied in, the lockfile exported with
 * `--output type=local`), so no package manager runs in the plugin service.
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { createLogger, errorMessage, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import YAML from 'yaml';

import { draftAskAgentPatch } from './ask-agent-patch.js';
import { ensureSharedBaseRebuilt } from './base-pass.js';
import type { ToolRun } from './patchers/index.js';
import type { GatedScan, ImageRef, RemediationPorts } from './ports.js';
import type { ImageConfigFacts, PluginContractShape } from './verify.js';
import { baseImageLocations } from '../../helpers/base-image.js';
import { run } from '../../helpers/build-process.js';
import { getBuildkitAddrForBuild, PUBLISH_PLATFORM } from '../../helpers/docker-build.js';
import { establishImageFacts } from '../../helpers/image-facts.js';
import { complianceRefusal, vulnFloor } from '../../helpers/image-gates.js';
import { parsePluginZip, specContractFields } from '../../helpers/plugin-spec.js';
import { imageRepository, writeAuthConfig, type RegistryInfo } from '../../helpers/registry-auth.js';
import { attachSupplyChain, DIGEST_RE, discardPluginImage, SUPPLY_CHAIN_STEPS } from '../../helpers/supply-chain.js';
import { fetchPluginSource } from '../plugin-sources.js';

const logger = createLogger('plugin-remediation-tooling');

const registry = (): RegistryInfo => Config.get('registry') as RegistryInfo;
const dockerCfg = () => Config.get('dockerConfig');

/** Tool images for lockfile regeneration (pulled through the in-cluster mirror like any base). */
export const TOOL_IMAGES: Readonly<Record<ToolRun['ecosystem'], string>> = {
  npm: 'node:lts-alpine',
  go: 'golang:1',
  cargo: 'rust:1',
  bundler: 'ruby:3',
  dotnet: 'mcr.microsoft.com/dotnet/sdk:8.0',
  gradle: 'gradle:8-jdk17',
};

const repoOf = (ref: Pick<ImageRef, 'orgId' | 'name'>): string => imageRepository(ref.name, registry(), ref.orgId);

function outputSpec(image: string): string {
  return ['type=image', `name=${image}`, 'push=true', ...(registry().http ? ['registry.insecure=true'] : [])].join(',');
}

async function withDockerConfig<T>(orgId: string, access: 'push' | 'pull', fn: (dir: string) => Promise<T>): Promise<T> {
  const ttl = Math.ceil((dockerCfg().timeoutMs + SUPPLY_CHAIN_STEPS * dockerCfg().pushTimeoutMs) / 1000);
  const dir = writeAuthConfig(registry(), orgId, ttl, access);
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function crane(args: string[], orgId: string): Promise<string> {
  return withDockerConfig(orgId, 'pull', (dir) => run('crane', [...(registry().http ? ['--insecure'] : []), ...args], dockerCfg().pushTimeoutMs,
    { DOCKER_CONFIG: dir }, { captureStdout: true }));
}

/** A bare `name:tag` resolves through the in-cluster mirror first, like a build's FROM. */
function resolvable(imageRef: string): string[] {
  const locations = baseImageLocations(imageRef, registry());
  return locations.length > 0 ? locations : [imageRef];
}

async function firstOk<T>(refs: string[], fn: (ref: string) => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (const r of refs) {
    try { return await fn(r); } catch (err) { last = err; }
  }
  throw last ?? new Error('no location');
}

async function imageConfigOf(ref: string, orgId: string): Promise<{ config?: { User?: string; Entrypoint?: string[] | null; Cmd?: string[] | null; WorkingDir?: string }; rootfs?: { diff_ids?: string[] } }> {
  return JSON.parse(await crane(['config', '--platform', PUBLISH_PLATFORM, ref], orgId)) as never;
}

async function remediationBuild(input: { orgId: string; name: string; version: string; contextDir: string; dockerfile: string; buildArgs: Record<string, string> }): Promise<string> {
  const repository = repoOf(input);
  const image = `${repository}:${input.version}`;
  const meta = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-rem-meta-'));
  const metadataFile = path.join(meta, 'metadata.json');
  try {
    return await withDockerConfig(input.orgId, 'push', async (dockerConfigDir) => {
      await run('buildctl', [
        '--addr', getBuildkitAddrForBuild(undefined, '1x'),
        'build',
        '--frontend', 'dockerfile.v0',
        '--local', `context=${input.contextDir}`,
        '--local', `dockerfile=${path.dirname(path.join(input.contextDir, input.dockerfile))}`,
        '--opt', `filename=${path.basename(input.dockerfile)}`,
        '--opt', `platform=${PUBLISH_PLATFORM}`,
        '--opt', 'attest:provenance=mode=min',
        // The two differences from an upload build: no cache, a freshly pulled base.
        '--no-cache',
        '--opt', 'image-resolve-mode=pull',
        ...Object.entries(input.buildArgs).flatMap(([k, v]) => ['--opt', `build-arg:${k}=${v}`]),
        '--output', outputSpec(image),
        '--metadata-file', metadataFile,
      ], dockerCfg().timeoutMs, { DOCKER_CONFIG: dockerConfigDir });
      const digest = (JSON.parse(fs.readFileSync(metadataFile, 'utf8')) as Record<string, unknown>)['containerimage.digest'];
      if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) throw Object.assign(new Error('buildctl reported no pushed digest'), { code: 'BUILD_NO_DIGEST' });
      await attachSupplyChain({ repository, digest, registry: registry(), orgId: input.orgId, dockerConfigDir, platform: PUBLISH_PLATFORM });
      return digest;
    });
  } finally {
    fs.rmSync(meta, { recursive: true, force: true });
  }
}

async function remediationScan(ref: ImageRef, record: Parameters<RemediationPorts['scan']>[1]): Promise<GatedScan> {
  const facts = await establishImageFacts({ orgId: ref.orgId, name: ref.name, imageDigest: ref.digest }, registry(), record.dockerfile);
  if (!facts.scan || !facts.scannedAt) {
    return { scan: { findings: [], waivedKeys: new Set(), refusal: 'IMAGE_SCAN_UNAVAILABLE' }, facts, summary: null };
  }
  const floor = vulnFloor({ orgId: ref.orgId, userId: null, pluginRecord: record, imageDigest: ref.digest, facts: { ...facts, scan: facts.scan }, trigger: 'build', emit: () => undefined });
  const compliance = floor.refusal ? null : await complianceRefusal(ref.orgId, record, ref.digest, facts);
  return {
    scan: { findings: facts.findings, waivedKeys: new Set(floor.summary.waived), refusal: floor.refusal?.code ?? compliance?.code ?? null },
    facts,
    summary: floor.summary,
  };
}

async function smokeTest(ref: ImageRef, command: string): Promise<void> {
  if (command.length === 0 || command.length > 4096) throw new Error('smokeTest must be 1–4096 characters');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-rem-smoke-'));
  try {
    fs.writeFileSync(path.join(dir, 'Dockerfile'), `FROM ${repoOf(ref)}@${ref.digest}\nRUN --network=none ${JSON.stringify(['/bin/sh', '-c', command])}\n`);
    await withDockerConfig(ref.orgId, 'pull', (cfg) => run('buildctl', [
      '--addr', getBuildkitAddrForBuild(undefined, '1x'), 'build', '--frontend', 'dockerfile.v0',
      '--local', `context=${dir}`, '--local', `dockerfile=${dir}`, '--opt', `platform=${PUBLISH_PLATFORM}`, '--no-cache',
    ], dockerCfg().timeoutMs, { DOCKER_CONFIG: cfg }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a lockfile regeneration in an isolated tool build and copy the outputs back. */
async function runTool(spec: ToolRun, contextDir: string, orgId: string): Promise<void> {
  if (spec.dir.split('/').includes('..') || spec.outputs.some((o) => o.includes('/') || o.includes('..'))) throw new Error('invalid tool run');
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-rem-tool-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-rem-tool-out-'));
  try {
    const work = spec.dir ? `/src/${spec.dir}` : '/src';
    fs.writeFileSync(path.join(build, 'Dockerfile'), [
      `FROM ${TOOL_IMAGES[spec.ecosystem]} AS work`,
      'COPY . /src',
      `WORKDIR ${work}`,
      `RUN ${JSON.stringify(['/bin/sh', '-c', spec.command])}`,
      'FROM scratch',
      ...spec.outputs.map((o) => `COPY --from=work ${work}/${o} /${o}`),
    ].join('\n'));
    await withDockerConfig(orgId, 'pull', (cfg) => run('buildctl', [
      '--addr', getBuildkitAddrForBuild(undefined, '1x'), 'build', '--frontend', 'dockerfile.v0',
      '--local', `context=${contextDir}`, '--local', `dockerfile=${build}`, '--no-cache',
      '--output', `type=local,dest=${outDir}`,
    ], dockerCfg().timeoutMs, { DOCKER_CONFIG: cfg }));
    for (const o of spec.outputs) fs.copyFileSync(path.join(outDir, o), path.join(contextDir, spec.dir, o));
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** The contract a context's plugin-spec.yaml declares (same fields the stored record carries). */
async function contractOf(contextDir: string): Promise<PluginContractShape | null> {
  const file = ['plugin-spec.yaml', 'plugin-spec.yml'].map((n) => path.join(contextDir, n)).find((p) => fs.existsSync(p));
  if (!file) return null;
  const spec = YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const c = specContractFields(spec as never);
  return {
    pluginType: typeof spec.pluginType === 'string' ? spec.pluginType : 'CodeBuildStep',
    commands: strings(spec.commands),
    installCommands: strings(spec.installCommands),
    requiredMetadata: c.requiredMetadata,
    requiredVars: c.requiredVars,
    metadataTypes: c.metadataTypes,
    varsTypes: c.varsTypes,
    secrets: Array.isArray(spec.secrets) ? spec.secrets : [],
    env: record(spec.env),
  };
}

/** The live ports. */
export function liveRemediationPorts(): RemediationPorts {
  return {
    fetchSource: (row, dest) => fetchPluginSource(row, dest),
    async openSource(zipPath, workRoot) {
      const parsed = await parsePluginZip(zipPath, { extractRoot: workRoot });
      return { dir: parsed.extractDir, dockerfile: parsed.dockerfile, buildType: parsed.buildType, buildArgs: (parsed.pluginSpec as { buildArgs?: Record<string, string> }).buildArgs ?? {} };
    },
    contractOf,
    build: remediationBuild,
    scan: remediationScan,
    async imageConfig(ref): Promise<ImageConfigFacts> {
      const cfg = (await imageConfigOf(`${repoOf(ref)}@${ref.digest}`, ref.orgId)).config ?? {};
      return { user: cfg.User ?? '', entrypoint: cfg.Entrypoint ?? null, cmd: cfg.Cmd ?? null, workingDir: cfg.WorkingDir ?? '' };
    },
    layerIds: (imageRef) => firstOk(resolvable(imageRef), async (r) => (await imageConfigOf(r, SYSTEM_ORG_ID)).rootfs?.diff_ids ?? []),
    smokeTest,
    resolveDigest: (imageWithTag) => firstOk(resolvable(imageWithTag), async (r) => (await crane(['digest', '--platform', PUBLISH_PLATFORM, r], SYSTEM_ORG_ID)).trim())
      .catch((err) => { logger.debug('Base digest not resolvable', { error: errorMessage(err) }); return null; }),
    runTool: (spec, dir) => runTool(spec, dir, SYSTEM_ORG_ID),
    async discardImage(ref) {
      await discardPluginImage({ repository: repoOf(ref), digest: ref.digest, registry: registry(), orgId: ref.orgId, context: { refusalCode: 'REMEDIATION_CANDIDATE' } });
    },
    imageReference: (ref) => `${repoOf(ref)}@${ref.digest}`,
    askAgent: (input) => draftAskAgentPatch(input),
    ensureSharedBase: (base, findings) => ensureSharedBaseRebuilt(base, findings, liveRemediationPorts()),
  };
}
