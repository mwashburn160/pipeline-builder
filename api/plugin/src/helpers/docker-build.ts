// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'child_process';
import * as fs from 'fs';
import path from 'path';

import { createLogger, signServiceToken, ValidationError } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

const logger = createLogger('docker-build');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface DockerBuildCfg {
  tempRoot: string;
  timeoutMs: number;
  pushTimeoutMs: number;
  /** buildctl `--addr` (unix:// or tcp://) for the buildkitd sidecar. */
  buildkitAddr: string;
}

export interface RegistryInfo {
  host: string;
  port: number;
  network: string;
  /**
   * BuildKit speaks plain HTTP to the registry when true (in-cluster registry
   * with no TLS). Pushed via `registry.insecure=true` on the buildctl output.
   */
  http: boolean;
}

export type BuildType = 'build_image' | 'prebuilt' | 'metadata_only';

export interface BuildRequest {
  contextDir: string;
  dockerfile: string;
  /** Plugin name  used as the Docker repository (e.g. `nodejs-build`). */
  name: string;
  /** Plugin version  used as the Docker tag (e.g. `1.0.0`). */
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
}

export interface BuildResult {
  fullImage: string;
}

// Path inside the plugin container for the per-build docker auth dir. Set on
// `process.env.DOCKER_CONFIG` before buildctl/crane run  both honor it.
const SYSTEM_ORG_ID = 'system';

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

function getConfig(): DockerBuildCfg {
  return Config.getAny('dockerConfig') as DockerBuildCfg;
}

export const BUILD_TEMP_ROOT = getConfig().tempRoot;

/**
 *  Per-tier buildkitd address resolution. When a deploy uses a
 * dedicated buildkitd Deployment per quota tier (see
 * `deploy/minikube/k8s/buildkitd-per-tier.yaml`), operators set * PLUGIN_BUILDKIT_ADDR_DEVELOPER=tcp://buildkitd-developer:1234
 * PLUGIN_BUILDKIT_ADDR_PRO=tcp://buildkitd-pro:1234
 * PLUGIN_BUILDKIT_ADDR_UNLIMITED=tcp://buildkitd-unlimited:1234
 *
 * Each tier gets a hard kernel-namespace boundary  a noisy Developer-tier
 * build cannot reach a Pro/Unlimited build's filesystem cache, layers, or
 * tmpfs. Plugin pods still talk to the in-pod sidecar by default, so existing
 * deploys are unchanged until operators opt in by setting the env vars.
 *
 * Unknown tier (or missing env) falls back to the in-pod sidecar  keeps the
 * dev-tier default working even when only one tier is split out.
 */
export function getBuildkitAddrForTier(tier: string | undefined): string {
  const cfg = getConfig();
  if (!tier) return cfg.buildkitAddr;
  const envKey = `PLUGIN_BUILDKIT_ADDR_${tier.toUpperCase()}`;
  const override = process.env[envKey];
  return override && override.length > 0 ? override: cfg.buildkitAddr;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export async function buildAndPush(req: BuildRequest, opts?: { buildkitAddr?: string }): Promise<BuildResult> {
  validate(req);
  const cfg = getConfig();
  const image = resolveImage(req.name, req.version, req.registry, req.orgId);
  // caller (the worker) supplies the per-tier buildkitd address;
  // fall back to the in-pod sidecar address when unset so the default
  // single-buildkitd deploy keeps working.
  const buildkitAddr = opts?.buildkitAddr ?? cfg.buildkitAddr;

  writeAuthConfig(req.contextDir, req.registry, req.orgId);
  patchDockerfile(req.contextDir, req.dockerfile);

  logger.info('Building image', { image, buildkitAddr });

  await run('buildctl', [
    '--addr', buildkitAddr,
    'build',
    '--frontend', 'dockerfile.v0',
    '--local', `context=${req.contextDir}`,
    '--local', `dockerfile=${path.dirname(path.join(req.contextDir, req.dockerfile))}`,
    '--opt', `filename=${path.basename(req.dockerfile)}`,
    ...flagBuildArgs(req.buildArgs),
    '--output', outputSpec(image, req.registry),
  ], cfg.timeoutMs);

  return { fullImage: image };
}

/**
 * Push a prebuilt image tarball (produced by `docker save`) to the registry.
 * Uses `crane`  buildctl can build but cannot push a pre-existing tarball.
 */
export async function loadAndPush( tarPath: string, name: string, version: string, registry: RegistryInfo, orgId: string,
): Promise<BuildResult> {
  validateRegistryAndName(name, registry);
  if (!fs.existsSync(tarPath)) {
    throw new ValidationError(`Tarball not found: ${tarPath}`);
  }
  const cfg = getConfig();
  const image = resolveImage(name, version, registry, orgId);

  writeAuthConfig(path.dirname(tarPath), registry, orgId);

  logger.info('Pushing prebuilt image', { image, tarPath });

  await run('crane', [
    ...(registry.http ? ['--insecure']: []),
    'push', tarPath, image,
  ], cfg.pushTimeoutMs);

  return { fullImage: image };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/**
 * Compute the registry-side image reference for a plugin. Namespace by
 * owning org so the token service's per-org scopes apply correctly * - `system` org → `<host>:<port>/system/<name>:<version>`
 * - any tenant org → `<host>:<port>/org-<orgId>/<name>:<version>`
 */
function resolveImage(name: string, version: string, registry: RegistryInfo, orgId?: string): string {
  const namespace = !orgId || orgId === SYSTEM_ORG_ID ? 'system': `org-${orgId}`;
  return `${registry.host}:${registry.port}/${namespace}/${name}:${version}`;
}

/**
 * Build the `--output` value for buildctl. `registry.insecure=true` tells
 * buildkitd to use plain HTTP  required for the in-cluster registry which
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

/**
 * Mint a short-lived platform JWT and write it to ~/.docker/config.json as
 * Basic-auth credentials for the registry. buildctl and crane both read
 * $DOCKER_CONFIG/config.json  image-registry's /token endpoint verifies the
 * JWT and mints a scoped Bearer token in response to the registry's bearer
 * challenge. Username is informational; auth-resolver path 1 uses the
 * password only.
 *
 * We write credentials for **two** hosts * 1. `registry:5000`  the in-cluster registry address we push to.
 * 2. The host derived from `PLATFORM_BASE_URL`  the token realm the
 * registry redirects clients to (see deploy/.../registry.yaml's
 * REGISTRY_AUTH_TOKEN_REALM, which is the public URL so external
 * Docker clients can reach it). Docker clients only send Basic auth
 * to hosts present in `auths`, so without this second entry crane
 * hops to the public realm with no credentials and gets 401.
 */
function writeAuthConfig(contextDir: string, registry: RegistryInfo, orgId: string) {
  const dir = path.join(contextDir, '.docker');
  fs.mkdirSync(dir, { recursive: true });
  process.env.DOCKER_CONFIG = dir;
  const password = signServiceToken({ serviceName: 'platform', orgId });
  const auth = Buffer.from(`_token:${password}`).toString('base64');

  const auths: Record<string, { auth: string }> = {
    [`${registry.host}:${registry.port}`]: { auth },
  };

  // Add the token-realm host if PLATFORM_BASE_URL is set. URL.host
  // already includes any non-default port (e.g. `host:8443`), which
  // matches how Docker keys auths.
  const platformBaseUrl = process.env.PLATFORM_BASE_URL;
  if (platformBaseUrl) {
    try {
      const realmHost = new URL(platformBaseUrl).host;
      if (realmHost) auths[realmHost] = { auth };
    } catch {
      // Malformed URL  skip silently; the in-cluster auth still works
      // for in-cluster realms (or when the registry isn't redirecting).
    }
  }

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auths }));
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

// -----------------------------------------------------------------------------
// Secret masking
// -----------------------------------------------------------------------------

const SECRET_RE = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIALS|AUTH)([=: ]+)([^\s"']+)/gi;

function maskSecrets(line: string): string {
  return line.replace(SECRET_RE, '$1$2***');
}

// -----------------------------------------------------------------------------
// Process runner
// -----------------------------------------------------------------------------

function run(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    const pipe = (stream: string) => (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) logger.info(maskSecrets(line), { stream });
    };
    child.stdout.on('data', pipe('stdout'));
    child.stderr.on('data', pipe('stderr'));

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Build timed out after ${timeoutMs}ms`));
      else if (code !== 0) reject(new Error(`Build failed with exit code ${code}`));
      else resolve();
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}
