/**
 * @module helpers/docker-build
 * @description Docker image build and push via buildx.
 *
 * Uses the host Docker daemon via socket mount. When a `DOCKER_NETWORK`
 * is configured, creates a temporary buildx builder with the
 * `docker-container` driver so the BuildKit daemon can resolve
 * container hostnames (e.g. a private registry on the compose network).
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';

import { createLogger } from '@mwashburn160/api-core';

const logger = createLogger('docker-build');

/** Registry configuration needed for build + push. */
export interface RegistryInfo {
  host: string;
  port: number;
  user: string;
  token: string;
  /** Compose network name (empty = use default Docker networking). */
  network: string;
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
}

/** Result of a successful build + push. */
export interface BuildResult {
  /** Full image reference (e.g. `registry:5000/plugin:p-myplugin-a1b2c3d4`). */
  fullImage: string;
}

const BUILDER_NAME = 'plugin-builder';

// Validation patterns for Docker build inputs
const VALID_NETWORK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const VALID_IMAGE_TAG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VALID_HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

function validateBuildInputs(registry: RegistryInfo, imageTag: string): void {
  if (!VALID_HOSTNAME_RE.test(registry.host)) {
    throw new Error(`Invalid registry host: ${registry.host}`);
  }
  if (registry.port < 1 || registry.port > 65535 || !Number.isInteger(registry.port)) {
    throw new Error(`Invalid registry port: ${registry.port}`);
  }
  if (!VALID_IMAGE_TAG_RE.test(imageTag)) {
    throw new Error(`Invalid image tag format: ${imageTag}`);
  }
  if (registry.network && !VALID_NETWORK_RE.test(registry.network)) {
    throw new Error(`Invalid network name: ${registry.network}`);
  }
}

/**
 * Build a Docker image and push it to the configured registry.
 *
 * @throws Error if the build or push fails
 */
export function buildAndPush(req: BuildRequest): BuildResult {
  const { contextDir, dockerfile, imageTag, registry } = req;

  validateBuildInputs(registry, imageTag);

  const registryAddr = `${registry.host}:${registry.port}`;
  const fullImage = `${registryAddr}/plugin:${imageTag}`;

  // --- Docker config dir (auth + builder state live here) ------------------
  // All `docker` invocations use `--config <dir>` so auth credentials,
  // builder references, and TLS settings are isolated to this build and
  // cleaned up automatically when the temp directory is removed.
  const configDir = path.join(contextDir, '.docker');
  fs.mkdirSync(configDir, { recursive: true });

  const authToken = Buffer.from(`${registry.user}:${registry.token}`).toString('base64');
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ auths: { [registryAddr]: { auth: authToken } } }),
  );

  // --- Buildx builder (only when a compose network is configured) ---------
  if (registry.network) {
    setupBuilder(configDir, contextDir, registryAddr, registry.network);
  }

  try {
    // --- Build + push in one step ------------------------------------------
    const args = [
      '--config', configDir,
      'buildx', 'build', '--push',
    ];

    if (registry.network) {
      args.push('--builder', BUILDER_NAME);
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

    execFileSync('docker', args, { stdio: 'inherit' });

    return { fullImage };
  } finally {
    teardownBuilder(configDir, registry.network);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a docker CLI command with the isolated --config dir.
 */
function dockerExec(configDir: string, args: string[], stdio: 'pipe' | 'ignore' | 'inherit' = 'pipe'): void {
  execFileSync('docker', ['--config', configDir, ...args], { stdio });
}

function setupBuilder(
  configDir: string,
  contextDir: string,
  registryAddr: string,
  network: string,
): void {
  // BuildKit config: trust the (possibly self-signed) registry
  // Set DOCKER_REGISTRY_INSECURE=false in production with proper TLS certificates
  const insecure = process.env.DOCKER_REGISTRY_INSECURE !== 'false';
  const buildkitdConfig = path.join(contextDir, 'buildkitd.toml');
  fs.writeFileSync(buildkitdConfig, [
    `[registry."${registryAddr}"]`,
    `  insecure = ${insecure}`,
    '',
  ].join('\n'));

  // Clean up stale builder from a prior failed run
  try {
    dockerExec(configDir, ['buildx', 'inspect', BUILDER_NAME], 'ignore');
    dockerExec(configDir, ['buildx', 'rm', BUILDER_NAME], 'ignore');
  } catch (err) { logger.debug('No stale builder to clean up', { error: String(err) }); }

  logger.info('Creating buildx builder', { name: BUILDER_NAME, network });

  dockerExec(configDir, [
    'buildx', 'create',
    '--name', BUILDER_NAME,
    '--driver', 'docker-container',
    '--driver-opt', `network=${network}`,
    '--buildkitd-config', buildkitdConfig,
  ]);
}

function teardownBuilder(configDir: string, network: string): void {
  if (!network) return;
  try {
    dockerExec(configDir, ['buildx', 'rm', BUILDER_NAME], 'ignore');
  } catch (err) { logger.debug('Builder teardown skipped', { error: String(err) }); }
}
