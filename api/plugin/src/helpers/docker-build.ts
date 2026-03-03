/**
 * @module helpers/docker-build
 * @description Docker image build and push via buildx.
 *
 * Uses the host Docker daemon via socket mount. When a `DOCKER_NETWORK`
 * is configured, creates a temporary buildx builder with the
 * `docker-container` driver so the BuildKit daemon can resolve
 * container hostnames (e.g. a private registry on the compose network).
 */

import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { createLogger, errorMessage, ValidationError } from '@mwashburn160/api-core';

const execFileAsync = promisify(execFile);

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
  /** Docker build arguments passed via --build-arg. */
  buildArgs?: Record<string, string>;
}

/** Result of a successful build + push. */
export interface BuildResult {
  /** Full image reference (e.g. `registry:5000/plugin:p-myplugin-a1b2c3d4`). */
  fullImage: string;
}

const BUILDER_NAME = process.env.DOCKER_BUILDER_NAME || 'plugin-builder';

// Validation patterns for Docker build inputs
const VALID_NETWORK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const VALID_IMAGE_TAG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const VALID_HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const VALID_BUILD_ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_BUILD_ARG_VALUE_LENGTH = 4096;

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
 * Uses async child_process.execFile so the Node.js event loop is not
 * blocked during long-running Docker builds. This allows the Express
 * server to continue handling requests while builds run in the background.
 *
 * @throws Error if the build or push fails
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

    const buildTimeoutMs = parseInt(process.env.DOCKER_BUILD_TIMEOUT_MS || '300000', 10);
    await execFileAsync('docker', args, { timeout: buildTimeoutMs });

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
  } catch (error) { logger.debug('No stale builder to clean up', { error: errorMessage(error) }); }

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
  } catch (error) { logger.debug('Builder teardown skipped', { error: errorMessage(error) }); }
}
