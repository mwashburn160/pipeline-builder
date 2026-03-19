import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import path from 'path';

import { createLogger, errorMessage, ValidationError } from '@mwashburn160/api-core';
import { CoreConstants } from '@mwashburn160/pipeline-core';

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

/**
 * Build a Docker image and push it to the configured registry.
 *
 * Uses a persistent buildx builder with the `docker-container` driver when a
 * network is configured. The builder is created lazily on first use and reused
 * across builds. It is only recreated when the network changes or the builder
 * is unhealthy.
 */
export async function buildAndPush(req: BuildRequest): Promise<BuildResult> {
  const { contextDir, dockerfile, imageTag, registry, buildArgs } = req;

  validateBuildInputs(registry, imageTag);

  const registryAddr = `${registry.host}:${registry.port}`;
  const fullImage = `${registryAddr}/plugin:${imageTag}`;

  // --- Docker config dir (auth + builder state live here) ------------------
  const configDir = path.join(contextDir, '.docker');
  fs.mkdirSync(configDir, { recursive: true });

  const authToken = Buffer.from(`${registry.user}:${registry.token}`).toString('base64');
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ auths: { [registryAddr]: { auth: authToken } } }),
  );

  // --- Ensure persistent buildx builder (only when network is configured) --
  // Serialise builder creation so concurrent builds don't race on `buildx create`.
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

  // --- Build + push in one step ------------------------------------------
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
      if (!VALID_BUILD_ARG_KEY.test(key)) {
        throw new ValidationError(`Invalid build arg key: ${key}`);
      }
      if (typeof value !== 'string' || value.length > MAX_BUILD_ARG_VALUE_LENGTH) {
        throw new ValidationError(`Invalid build arg value for ${key}`);
      }
      args.push('--build-arg', `${key}=${value}`);
    }
  }

  args.push(
    '-f', path.join(contextDir, dockerfile),
    '-t', fullImage,
    contextDir,
  );

  logger.info('Building and pushing image', {
    fullImage,
    network: registry.network || 'default',
  });

  await spawnDocker(args, CoreConstants.DOCKER_BUILD_TIMEOUT_MS);

  return { fullImage };
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
 * Spawn `docker` with real-time output streaming to the logger.
 * Rejects if the process exits non-zero or the timeout is exceeded.
 */
function spawnDocker(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

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
        reject(new Error(`Docker build timed out after ${timeoutMs}ms`));
      } else if (code !== 0) {
        reject(new Error(`Docker build failed with exit code ${code}`));
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
  } catch { /* builder doesn't exist — fine */ }
  try {
    execFileSync('docker', ['rm', '-f', `buildx_buildkit_${BUILDER_NAME}0`], { stdio: 'ignore' });
  } catch { /* container doesn't exist — fine */ }
}

/**
 * Reset module state (for testing only).
 */
export function _resetBuilderStateForTesting(): void {
  activeBuilderNetwork = null;
  builderMutex = Promise.resolve();
}
