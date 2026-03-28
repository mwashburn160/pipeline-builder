import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import path from 'path';

import { createLogger, errorMessage, ValidationError } from '@mwashburn160/api-core';
import { CoreConstants } from '@mwashburn160/pipeline-core';

import { resolveStrategy } from './build-strategy';

const logger = createLogger('docker-build');

/** Registry configuration needed for build + push. */
export interface RegistryInfo {
  host: string;
  port: number;
  user: string;
  token: string;
  /** Docker network mode for the buildx builder container.
   *  'host' for Compose/K8s dind (shares dind's network namespace).
   *  Empty string = use default Docker networking. */
  network: string;
  /** Use plain HTTP instead of HTTPS. */
  http: boolean;
  /** Skip TLS certificate verification (for self-signed certs). */
  insecure: boolean;
}

/** Input for a plugin image build. */
export interface BuildRequest {
  /** Extracted plugin source directory (the build context). */
  contextDir: string;
  /** Validated Dockerfile path relative to contextDir. */
  dockerfile: string;
  /** Tag to apply (e.g. `p-myplugin-a1b2c3d4`). */
  imageTag: string;
  /** Registry configuration. */
  registry: RegistryInfo;
  /** Docker build arguments passed via --build-arg. */
  buildArgs?: Record<string, string>;
}

/** Result of a successful build + push. */
export interface BuildResult {
  /** Full image reference (e.g. `registry:5000/plugin:p-myplugin-a1b2c3d4`). */
  fullImage: string;
}

/** Root directory for Docker build temp files. The build context is sent
 *  to the Docker daemon (or dind sidecar) via the Docker API as a tar stream. */
export const BUILD_TEMP_ROOT = process.env.DOCKER_BUILD_TEMP_ROOT || path.join(process.cwd(), 'tmp');

const BUILDER_NAME = CoreConstants.DOCKER_BUILDER_NAME;

/** Path to the Kaniko executor binary. */
const KANIKO_EXECUTOR = process.env.KANIKO_EXECUTOR_PATH || '/kaniko/executor';

/** Kaniko layer cache directory. */
const KANIKO_CACHE_DIR = process.env.KANIKO_CACHE_DIR || '/kaniko/cache';

// Validation patterns for Docker build inputs
const VALID_NETWORK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const VALID_IMAGE_TAG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VALID_HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const VALID_BUILD_ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_BUILD_ARG_VALUE_LENGTH = 4096;

/** Tracks the persistent builder state so we can detect network changes. */
let activeBuilderNetwork: string | null = null;

/** Serialises access to ensureBuilder so concurrent builds don't race. */
let builderMutex: Promise<void> = Promise.resolve();

function validateBuildInputs(registry: RegistryInfo, imageTag: string): void {
  if (!VALID_HOSTNAME_RE.test(registry.host)) {
    throw new ValidationError(`Invalid registry host: ${registry.host}`);
  }
  if (registry.port < 1 || registry.port > 65535 || !Number.isInteger(registry.port)) {
    throw new ValidationError(`Invalid registry port: ${registry.port}`);
  }
  if (!VALID_IMAGE_TAG_RE.test(imageTag)) {
    throw new ValidationError(`Invalid image tag format: ${imageTag}`);
  }
  if (registry.network && !VALID_NETWORK_RE.test(registry.network)) {
    throw new ValidationError(`Invalid network name: ${registry.network}`);
  }
}

function validateBuildArgs(buildArgs: Record<string, string>): void {
  for (const [key, value] of Object.entries(buildArgs)) {
    if (!VALID_BUILD_ARG_KEY.test(key)) {
      throw new ValidationError(`Invalid build arg key: ${key}`);
    }
    if (typeof value !== 'string' || value.length > MAX_BUILD_ARG_VALUE_LENGTH) {
      throw new ValidationError(`Invalid build arg value for ${key}`);
    }
  }
}

/**
 * Build a Docker image and push it to the configured registry.
 *
 * Supports two strategies selected via DOCKER_BUILD_STRATEGY env var:
 * - `docker` — Uses Docker buildx with a persistent builder (requires dind)
 * - `kaniko` — Uses Kaniko executor (daemonless, works on Fargate)
 * - `auto`   — Probes for Docker daemon; falls back to Kaniko (default)
 */
export async function buildAndPush(req: BuildRequest): Promise<BuildResult> {
  const { contextDir, dockerfile, imageTag, registry, buildArgs } = req;

  validateBuildInputs(registry, imageTag);
  if (buildArgs) validateBuildArgs(buildArgs);

  const registryAddr = `${registry.host}:${registry.port}`;
  const fullImage = `${registryAddr}/plugin:${imageTag}`;
  const strategy = resolveStrategy();

  let binary: string;
  let args: string[];

  if (strategy === 'docker') {
    ({ binary, args } = await buildDockerArgs(contextDir, dockerfile, fullImage, registry, buildArgs));
  } else {
    ({ binary, args } = buildKanikoArgs(contextDir, dockerfile, fullImage, registry, buildArgs));
  }

  logger.info('Building and pushing image', {
    strategy,
    fullImage,
    command: `${binary} ${args.join(' ')}`,
    network: registry.network || 'default',
  });

  await spawnProcess(binary, args, CoreConstants.DOCKER_BUILD_TIMEOUT_MS);

  return { fullImage };
}

// ---------------------------------------------------------------------------
// Docker strategy
// ---------------------------------------------------------------------------

async function buildDockerArgs(
  contextDir: string,
  dockerfile: string,
  fullImage: string,
  registry: RegistryInfo,
  buildArgs?: Record<string, string>,
): Promise<{ binary: string; args: string[] }> {
  // Auth config for Docker
  const configDir = path.join(contextDir, '.docker');
  fs.mkdirSync(configDir, { recursive: true });

  const registryAddr = `${registry.host}:${registry.port}`;
  const authToken = Buffer.from(`${registry.user}:${registry.token}`).toString('base64');
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ auths: { [registryAddr]: { auth: authToken } } }),
  );

  // Ensure persistent buildx builder (only when network is configured)
  if (registry.network) {
    await new Promise<void>((resolve, reject) => {
      builderMutex = builderMutex
        .then(() => {
          ensureBuilder(configDir, contextDir, registry);
          resolve();
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  const args = [
    '--config', configDir,
    'buildx', 'build', '--push',
    '--progress', 'plain',
  ];

  if (registry.network) {
    args.push('--builder', BUILDER_NAME);
  }

  if (buildArgs) {
    for (const [key, value] of Object.entries(buildArgs)) {
      args.push('--build-arg', `${key}=${value}`);
    }
  }

  args.push(
    '-f', path.join(contextDir, dockerfile),
    '-t', fullImage,
    contextDir,
  );

  return { binary: 'docker', args };
}

// ---------------------------------------------------------------------------
// Kaniko strategy
// ---------------------------------------------------------------------------

function buildKanikoArgs(
  contextDir: string,
  dockerfile: string,
  fullImage: string,
  registry: RegistryInfo,
  buildArgs?: Record<string, string>,
): { binary: string; args: string[] } {
  // Auth config for Kaniko — kaniko reads from DOCKER_CONFIG or $HOME/.docker/
  const kanikoDockerDir = process.env.DOCKER_CONFIG || '/kaniko/.docker';
  fs.mkdirSync(kanikoDockerDir, { recursive: true });
  process.env.DOCKER_CONFIG = kanikoDockerDir;

  const registryAddr = `${registry.host}:${registry.port}`;
  const authToken = Buffer.from(`${registry.user}:${registry.token}`).toString('base64');
  fs.writeFileSync(
    path.join(kanikoDockerDir, 'config.json'),
    JSON.stringify({ auths: { [registryAddr]: { auth: authToken } } }),
  );

  // Inject directives after every FROM to prevent dpkg interactive prompts and
  // config file conflicts. Kaniko runs sequentially in a shared container, so
  // stale /etc files from previous builds can cause dpkg conffile errors.
  // - DEBIAN_FRONTEND=noninteractive: suppresses dialog prompts
  // - force-confnew in dpkg.cfg: auto-accepts new config files (overwrite stale ones)
  const dockerfilePath = path.join(contextDir, dockerfile);
  const originalContent = fs.readFileSync(dockerfilePath, 'utf-8');
  const injected = [
    'ENV DEBIAN_FRONTEND=noninteractive',
    'RUN echo "force-confnew" > /etc/dpkg/dpkg.cfg.d/kaniko-force-confnew 2>/dev/null || true',
  ].join('\n');
  const patched = originalContent.replace(
    /^(FROM\s+[^\n]+)/gm,
    `$1\n${injected}`,
  );
  fs.writeFileSync(dockerfilePath, patched);

  const args = [
    `--context=${contextDir}`,
    `--dockerfile=${dockerfilePath}`,
    `--destination=${fullImage}`,
    '--verbosity=info',
    '--log-format=json',
    '--cache=true',
    `--cache-dir=${KANIKO_CACHE_DIR}`,
    '--cleanup',
    '--reproducible',
    '--snapshot-mode=redo',
    '--push-retry=2',
    '--image-fs-extract-retry=2',
    '--image-download-retry=3',
  ];

  if (registry.http) {
    args.push('--insecure', '--insecure-pull');
  }

  if (registry.insecure) {
    args.push('--skip-tls-verify', '--skip-tls-verify-pull');
  }

  if (buildArgs) {
    for (const [key, value] of Object.entries(buildArgs)) {
      args.push(`--build-arg=${key}=${value}`);
    }
  }

  return { binary: KANIKO_EXECUTOR, args };
}

/**
 * Remove the persistent builder. Call during graceful shutdown.
 * In dind sidecar deployments, the builder lives inside the dind container
 * and is automatically cleaned up when the pod terminates.
 */
export function destroyBuilder(): void {
  if (activeBuilderNetwork === null) return;
  try {
    execFileSync('docker', ['buildx', 'rm', '--force', BUILDER_NAME], { stdio: 'ignore' });
    logger.info('Destroyed persistent buildx builder', { name: BUILDER_NAME });
  } catch (error) {
    logger.debug('Builder destroy skipped', { error: errorMessage(error) });
  }
  activeBuilderNetwork = null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a process with real-time output streaming to the logger.
 * Rejects if the process exits non-zero or the timeout is exceeded.
 */
function spawnProcess(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        logger.info(line, { stream: 'stdout' });
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        logger.info(line, { stream: 'stderr' });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Build timed out after ${timeoutMs}ms`));
      } else if (code !== 0) {
        reject(new Error(`Build failed with exit code ${code}`));
      } else {
        resolve();
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function dockerExec(configDir: string, args: string[], stdio: 'pipe' | 'ignore' | 'inherit' = 'ignore'): void {
  execFileSync('docker', ['--config', configDir, ...args], { stdio });
}

/**
 * Check if the named builder exists and is healthy.
 */
function isBuilderHealthy(configDir: string): boolean {
  try {
    dockerExec(configDir, ['buildx', 'inspect', BUILDER_NAME, '--bootstrap']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a persistent buildx builder exists for the given network.
 * Creates the builder lazily on first call. Recreates it only when:
 *  - The network has changed (e.g. after container restart)
 *  - The builder is unhealthy or missing
 */
function ensureBuilder(
  configDir: string,
  contextDir: string,
  registry: RegistryInfo,
): void {
  const { network, http, insecure } = registry;
  const registryAddr = `${registry.host}:${registry.port}`;
  const networkChanged = activeBuilderNetwork !== null && activeBuilderNetwork !== network;

  if (!networkChanged && activeBuilderNetwork !== null && isBuilderHealthy(configDir)) {
    logger.debug('Reusing existing buildx builder', { name: BUILDER_NAME, network });
    return;
  }

  if (networkChanged) {
    logger.info('Network changed, recreating buildx builder', {
      name: BUILDER_NAME,
      from: activeBuilderNetwork,
      to: network,
    });
  }

  // Remove stale builder + container
  removeBuilder(configDir);

  // Write buildkitd config for registry access + DNS
  const dnsServers = (process.env.BUILDKIT_DNS_NAMESERVERS || '8.8.8.8,8.8.4.4')
    .split(',').map(s => s.trim()).filter(Boolean);
  const buildkitdConfig = path.join(contextDir, 'buildkitd.toml');
  const tomlLines = [
    `[registry."${registryAddr}"]`,
    `  http = ${http}`,
    `  insecure = ${insecure}`,
    '',
    '[dns]',
    `  nameservers = [${dnsServers.map(ns => `"${ns}"`).join(', ')}]`,
    '',
  ];
  fs.writeFileSync(buildkitdConfig, tomlLines.join('\n'));

  logger.info('Creating persistent buildx builder', { name: BUILDER_NAME, network });

  dockerExec(configDir, [
    'buildx', 'create',
    '--name', BUILDER_NAME,
    '--driver', 'docker-container',
    '--driver-opt', `network=${network}`,
    '--buildkitd-config', buildkitdConfig,
  ]);

  activeBuilderNetwork = network;
}

/**
 * Force-remove the builder and its backing container.
 */
function removeBuilder(configDir: string): void {
  try {
    dockerExec(configDir, ['buildx', 'rm', '--force', BUILDER_NAME]);
  } catch (err) {
    logger.debug('Builder removal skipped', { error: errorMessage(err) });
  }
  try {
    execFileSync('docker', ['rm', '-f', `buildx_buildkit_${BUILDER_NAME}0`], { stdio: 'ignore' });
  } catch (err) {
    logger.debug('Builder container removal skipped', { error: errorMessage(err) });
  }
}

/**
 * Reset module state (for testing only).
 */
export function _resetBuilderStateForTesting(): void {
  activeBuilderNetwork = null;
  builderMutex = Promise.resolve();
}
