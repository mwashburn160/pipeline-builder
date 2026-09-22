// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { createLogger, SYSTEM_ORG_ID, ValidationError } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import type { ImageSource } from '@pipeline-builder/pipeline-data';

import { run } from './build-process.js';
import type { BuildStreamOptions } from './build-process.js';
import { imageRepository, writeAuthConfig } from './registry-auth.js';
import type { RegistryInfo } from './registry-auth.js';
import { attachSupplyChain, DIGEST_RE, SUPPLY_CHAIN_STEPS } from './supply-chain.js';

const logger = createLogger('docker-build');

// Platform the built plugin image is published for. Default linux/amd64 — the
// CodeBuild runtime that runs plugin images. On an amd64 buildkitd host this is
// native (no-op); on an arm64 host buildkit emulates amd64 via qemu so the
// registry artifact still matches the runtime. Override PUBLISH_PLATFORM (e.g.
// linux/arm64) for an all-Graviton stack — same env name the deploy scripts
// (build-plugin-images.sh / build-codebuild-bootstrap.sh) use.
export const PUBLISH_PLATFORM = process.env.PUBLISH_PLATFORM || 'linux/amd64';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type BuildType = 'build_image' | 'prebuilt' | 'metadata_only';

export interface BuildRequest {
  contextDir: string;
  dockerfile: string;
  /** Plugin name — used as the Docker repository (e.g. `nodejs-build`). */
  name: string;
  /** Plugin version — used as the Docker tag (e.g. `1.0.0`). */
  version: string;
  /**
   * Owning org of the plugin being built. Used to derive the registry
   * namespace: `system/<name>:<version>` for the system org,
   * `org-<orgId>/<name>:<version>` for tenant orgs. The token service grants
   * pull/push permissions per namespace based on the caller's identity.
   */
  orgId: string;
  registry: RegistryInfo;
  buildArgs?: Record<string, string>;
  buildType: BuildType;
  /**
   * Object-storage key of the uploaded build-context ZIP (see
   * plugin-artifact-storage). Present for `producesImage` builds so a worker on a
   * DIFFERENT replica than the uploader can re-materialize `contextDir` from S3
   * (the local scratch dir is per-pod, not shared). Absent for metadata-only
   * builds (no image, no build job).
   */
  s3Key?: string;
}

export interface BuildResult {
  /** `<repo>:<version>` — the human-readable tag. Never what CodeBuild pulls. */
  fullImage: string;
  /** The pushed, signed digest (`sha256:…`) synth pins CodeBuild to. */
  digest: string;
  imageSource: ImageSource;
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

function getConfig() {
  return Config.get('dockerConfig');
}

export const BUILD_TEMP_ROOT = getConfig().tempRoot;

/**
 * Resolve the buildkitd address for a tier. Short-circuits to the shared
 * `cfg.buildkitAddr` unless an operator has set a per-tier env override
 * (`PLUGIN_BUILDKIT_ADDR_<TIER>`); shipped deploys never do.
 */
export function getBuildkitAddrForTier(tier: string | undefined): string {
  const cfg = getConfig();
  if (tier) {
    const override = process.env[`PLUGIN_BUILDKIT_ADDR_${tier.toUpperCase()}`];
    if (override && override.length > 0) return override;
  }
  return cfg.buildkitAddr;
}

/**
 * The registry credential is minted before the operation and spent across all
 * of it — the push at the end of a build, then the SBOM scan's pull — so its
 * TTL covers the operation window plus the supply-chain steps (each bounded by
 * `pushTimeoutMs`). A shorter TTL lets a long build (gcloud-deploy, playwright)
 * outlive the token, and the push or SBOM pull fails with a 401 from
 * image-registry's /token endpoint.
 */
function credentialTtlSeconds(operationMs: number): number {
  return Math.ceil((operationMs + SUPPLY_CHAIN_STEPS * getConfig().pushTimeoutMs) / 1000);
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export async function buildAndPush(req: BuildRequest, opts?: { buildkitAddr?: string } & BuildStreamOptions): Promise<BuildResult> {
  validate(req);
  const cfg = getConfig();
  const repository = imageRepository(req.name, req.registry, req.orgId);
  const image = `${repository}:${req.version}`;
  // caller (the worker) supplies the per-tier buildkitd address;
  // fall back to the in-pod sidecar address when unset so the default
  // single-buildkitd deploy keeps working.
  const buildkitAddr = opts?.buildkitAddr ?? cfg.buildkitAddr;

  const dockerConfigDir = writeAuthConfig(req.registry, req.orgId, credentialTtlSeconds(cfg.timeoutMs));
  // buildctl writes the pushed digest here — the ONLY authoritative source for
  // it: re-resolving the tag afterwards would race any other push to that tag.
  const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-buildmeta-'));
  const metadataFile = path.join(metaDir, 'metadata.json');

  // EVERYTHING after the credential exists on disk belongs inside the try, so
  // the `finally` removes it on every outcome — including a throw from
  // `patchDockerfile` on an unreadable or malformed (attacker-influenced)
  // Dockerfile.
  try {
    patchDockerfile(req.contextDir, req.dockerfile);

    logger.info('Building image', { image, buildkitAddr });

    await run('buildctl', [
      '--addr', buildkitAddr,
      'build',
      '--frontend', 'dockerfile.v0',
      '--local', `context=${req.contextDir}`,
      '--local', `dockerfile=${path.dirname(path.join(req.contextDir, req.dockerfile))}`,
      '--opt', `filename=${path.basename(req.dockerfile)}`,
      // Pin the published plugin image platform (default linux/amd64 = the
      // CodeBuild runtime). The `FROM` base image must have a matching variant.
      '--opt', `platform=${PUBLISH_PLATFORM}`,
      // SLSA provenance, stored in the pushed image index and so covered by the
      // cosign signature over its digest. `min`, never `max`: max mode records
      // the build args, and those are free-form uploader input that may carry
      // credentials — max would publish them to every puller of the image.
      '--opt', 'attest:provenance=mode=min',
      ...flagBuildArgs(req.buildArgs),
      '--output', outputSpec(image, req.registry),
      '--metadata-file', metadataFile,
    ], cfg.timeoutMs, { DOCKER_CONFIG: dockerConfigDir }, { onLine: opts?.onLine });

    const digest = readBuildDigest(metadataFile);
    await attachSupplyChain({ repository, digest, registry: req.registry, orgId: req.orgId, dockerConfigDir, platform: PUBLISH_PLATFORM }, opts);
    return { fullImage: image, digest, imageSource: 'built' };
  } finally {
    fs.rmSync(dockerConfigDir, { recursive: true, force: true });
    fs.rmSync(metaDir, { recursive: true, force: true });
  }
}

/**
 * Push a prebuilt image tarball (produced by `docker save`) to the registry.
 * Uses `crane` — buildctl can build but cannot push a pre-existing tarball.
 * The platform never saw this image built, so it gets an SBOM and a signature
 * but no provenance (`imageSource: 'uploaded'`).
 */
export async function loadAndPush( tarPath: string, name: string, version: string, registry: RegistryInfo, orgId: string,
  opts?: BuildStreamOptions,
): Promise<BuildResult> {
  validateRegistryAndName(name, registry);
  if (!RE_TAG.test(version)) throw new ValidationError(`Invalid plugin version (must be a valid Docker tag): ${version}`);
  if (!fs.existsSync(tarPath)) {
    throw new ValidationError(`Tarball not found: ${tarPath}`);
  }
  const cfg = getConfig();
  const repository = imageRepository(name, registry, orgId);
  const image = `${repository}:${version}`;

  const dockerConfigDir = writeAuthConfig(registry, orgId, credentialTtlSeconds(cfg.pushTimeoutMs));

  logger.info('Pushing prebuilt image', { image, tarPath });

  try {
    // crane prints the pushed `<repo>@sha256:…` on stdout — captured raw, since
    // the log masker would redact the 64-hex digest.
    const stdout = await run('crane', [
      ...(registry.http ? ['--insecure']: []),
      'push', tarPath, image,
    ], cfg.pushTimeoutMs, { DOCKER_CONFIG: dockerConfigDir }, { onLine: opts?.onLine, captureStdout: true });

    const digest = parseCranePushDigest(stdout);
    await attachSupplyChain({ repository, digest, registry, orgId, dockerConfigDir }, opts);
    return { fullImage: image, digest, imageSource: 'uploaded' };
  } finally {
    fs.rmSync(dockerConfigDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Quarantine builds (anonymous submissions)
// -----------------------------------------------------------------------------

/** An anonymous submission's build: always a Dockerfile build, into `quarantine/<submissionId>`. */
export interface QuarantineBuildRequest {
  contextDir: string;
  dockerfile: string;
  version: string;
  buildArgs?: Record<string, string>;
  registry: RegistryInfo;
  /** Namespace-relative repository: `quarantine/<submissionId>`. */
  repository: string;
}

export interface QuarantineBuildOptions extends BuildStreamOptions {
  /** The ISOLATED quarantine buildkitd — never the tenant one. */
  buildkitAddr: string;
  timeoutMs: number;
  /** A `$DOCKER_CONFIG` holding the plugin service principal's quarantine credential. */
  dockerConfigDir: string;
}

const QUARANTINE_REPO_RE = /^quarantine\/[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * Build a submission on the quarantine buildkitd, push it to its
 * `quarantine/<id>` repository, then SBOM + sign it under the system org (so
 * its signed SBOM survives into the approved `public/community/*` copy). The
 * caller owns the credential directory.
 */
export async function buildAndPushQuarantine(req: QuarantineBuildRequest, opts: QuarantineBuildOptions): Promise<BuildResult & { repository: string }> {
  if (!QUARANTINE_REPO_RE.test(req.repository)) throw new ValidationError(`Invalid quarantine repository: ${req.repository}`);
  validate({ contextDir: req.contextDir, dockerfile: req.dockerfile, name: 'quarantine', version: req.version, orgId: SYSTEM_ORG_ID, registry: req.registry, buildArgs: req.buildArgs, buildType: 'build_image' });
  const repository = `${req.registry.host}:${req.registry.port}/${req.repository}`;
  const image = `${repository}:${req.version}`;
  const metaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-buildmeta-'));
  const metadataFile = path.join(metaDir, 'metadata.json');
  try {
    patchDockerfile(req.contextDir, req.dockerfile);
    logger.info('Building quarantined submission image', { image, buildkitAddr: opts.buildkitAddr });
    await run('buildctl', [
      '--addr', opts.buildkitAddr,
      'build',
      '--frontend', 'dockerfile.v0',
      '--local', `context=${req.contextDir}`,
      '--local', `dockerfile=${path.dirname(path.join(req.contextDir, req.dockerfile))}`,
      '--opt', `filename=${path.basename(req.dockerfile)}`,
      '--opt', `platform=${PUBLISH_PLATFORM}`,
      '--opt', 'attest:provenance=mode=min',
      ...flagBuildArgs(req.buildArgs),
      '--output', outputSpec(image, req.registry),
      '--metadata-file', metadataFile,
    ], opts.timeoutMs, { DOCKER_CONFIG: opts.dockerConfigDir }, { onLine: opts.onLine });
    const digest = readBuildDigest(metadataFile);
    await attachSupplyChain({ repository, digest, registry: req.registry, orgId: SYSTEM_ORG_ID, dockerConfigDir: opts.dockerConfigDir, platform: PUBLISH_PLATFORM }, opts);
    return { fullImage: image, digest, imageSource: 'built', repository: req.repository };
  } finally {
    fs.rmSync(metaDir, { recursive: true, force: true });
  }
}

/**
 * The server-side smoke test: a second, NO-PUSH build on the quarantine
 * buildkitd — `FROM <image@digest>` + `RUN --network=none bash -c <smokeTest>`.
 * Resolves when the command exits 0; throws (a `BuildProcessError`) otherwise.
 */
export async function runQuarantineSmokeTest(
  input: { imageRef: string; command: string },
  opts: QuarantineBuildOptions,
): Promise<void> {
  if (!/^[a-zA-Z0-9.:-]+\/quarantine\/[a-z0-9][a-z0-9-]*@sha256:[0-9a-f]{64}$/.test(input.imageRef)) {
    throw new ValidationError(`Invalid quarantine image reference: ${input.imageRef}`);
  }
  if (input.command.length === 0 || input.command.length > 4096) throw new ValidationError('smokeTest must be 1–4096 characters');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-smoke-'));
  try {
    // Exec (JSON) form: the command is ONE argument to bash, never re-parsed by
    // the Dockerfile frontend; network=none so a smoke test can't phone home.
    fs.writeFileSync(path.join(dir, 'Dockerfile'),
      `FROM ${input.imageRef}\nRUN --network=none ${JSON.stringify(['/bin/bash', '-c', input.command])}\n`);
    await run('buildctl', [
      '--addr', opts.buildkitAddr,
      'build',
      '--frontend', 'dockerfile.v0',
      '--local', `context=${dir}`,
      '--local', `dockerfile=${dir}`,
      '--opt', `platform=${PUBLISH_PLATFORM}`,
      '--no-cache',
    ], opts.timeoutMs, { DOCKER_CONFIG: opts.dockerConfigDir }, { onLine: opts.onLine });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/**
 * Build the `--output` value for buildctl. `registry.insecure=true` tells
 * buildkitd to use plain HTTP — required for the in-cluster registry which
 * doesn't terminate TLS on its NodePort.
 */
function outputSpec(image: string, registry: RegistryInfo): string {
  const parts = [
    'type=image',
    `name=${image}`,
    'push=true',
  ];
  if (registry.http) parts.push('registry.insecure=true');
  return parts.join(',');
}

/** The pushed digest from buildctl's `--metadata-file` (the index digest when attestations are attached). */
function readBuildDigest(metadataFile: string): string {
  let digest: unknown;
  try {
    digest = (JSON.parse(fs.readFileSync(metadataFile, 'utf-8')) as Record<string, unknown>)['containerimage.digest'];
  } catch (err) {
    throw new Error(`buildctl metadata unreadable at ${metadataFile}: ${(err as Error).message}`);
  }
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
    throw new Error(`buildctl reported no pushed image digest (containerimage.digest=${String(digest)})`);
  }
  return digest;
}

/** `crane push` stdout is the pushed reference, `<repo>@sha256:<hex>`. */
function parseCranePushDigest(stdout: string): string {
  const match = /@(sha256:[0-9a-f]{64})\s*$/.exec(stdout.trim());
  if (!match) throw new Error(`crane push reported no image digest (stdout: ${stdout.trim().slice(0, 200)})`);
  return match[1]!;
}

/**
 * Inject DEBIAN_FRONTEND=noninteractive after each FROM so apt-get inside
 * the plugin's Dockerfile doesn't prompt for confnew-style decisions. Only
 * touches Debian/Ubuntu builds in practice; harmless on other bases.
 */
function patchDockerfile(contextDir: string, dockerfile: string) {
  const file = path.join(contextDir, dockerfile);
  const src = fs.readFileSync(file, 'utf-8');
  fs.writeFileSync(file, src.replace(/^(FROM\s+[^\n]+)/gm, '$1\nENV DEBIAN_FRONTEND=noninteractive'));
}

function flagBuildArgs(args?: Record<string, string>): string[] {
  if (!args) return [];
  return Object.entries(args).flatMap(([k, v]) => ['--opt', `build-arg:${k}=${v}`]);
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

const RE_HOST = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
// Docker repository name: lowercase letters/digits/separators (must start
// with letter or digit). Used for the plugin's `name` field which becomes
// the repo path component.
const RE_REPO = /^[a-z0-9][a-z0-9._-]*$/;
// Docker image tag: alphanumerics + `.`/`_`/`-`. Used for the plugin's
// `version` field. Cannot start with a separator.
const RE_TAG = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const RE_NET = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const RE_ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateRegistryAndName(name: string, registry: RegistryInfo) {
  if (!RE_HOST.test(registry.host)) throw new ValidationError(`Invalid registry host: ${registry.host}`);
  if (!Number.isInteger(registry.port) || registry.port < 1 || registry.port > 65535) throw new ValidationError(`Invalid registry port: ${registry.port}`);
  if (!RE_REPO.test(name)) throw new ValidationError(`Invalid plugin name (must be a valid Docker repo path): ${name}`);
  if (registry.network && !RE_NET.test(registry.network)) throw new ValidationError(`Invalid network: ${registry.network}`);
}

function validate({ registry, name, version, buildArgs }: BuildRequest) {
  validateRegistryAndName(name, registry);
  if (!RE_TAG.test(version)) throw new ValidationError(`Invalid plugin version (must be a valid Docker tag): ${version}`);
  for (const [k, v] of Object.entries(buildArgs || {})) {
    if (!RE_ARG_KEY.test(k)) throw new ValidationError(`Invalid build arg key: ${k}`);
    if (typeof v !== 'string' || v.length > 4096) throw new ValidationError(`Invalid build arg value for ${k}`);
  }
}
