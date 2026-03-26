import { execFileSync } from 'child_process';

import { createLogger } from '@mwashburn160/api-core';

const logger = createLogger('build-strategy');

export type BuildStrategy = 'docker' | 'kaniko' | 'auto';
export type ResolvedStrategy = 'docker' | 'kaniko';

const DOCKER_PROBE_TIMEOUT_MS = 3000;

let cached: ResolvedStrategy | null = null;

/**
 * Resolve the build strategy from the DOCKER_BUILD_STRATEGY env var.
 *
 * - `docker`  — force Docker daemon (buildx + dind)
 * - `kaniko`  — force Kaniko executor (daemonless)
 * - `auto`    — probe for Docker daemon; fall back to Kaniko (default)
 *
 * The result is cached for the lifetime of the process.
 */
export function resolveStrategy(): ResolvedStrategy {
  if (cached) return cached;

  const env = (process.env.DOCKER_BUILD_STRATEGY || 'auto').toLowerCase() as BuildStrategy;

  if (env === 'docker' || env === 'kaniko') {
    cached = env;
    logger.info(`Build strategy: ${cached} (explicit)`);
    return cached;
  }

  // auto-detect: probe for Docker daemon
  try {
    execFileSync('docker', ['info'], {
      timeout: DOCKER_PROBE_TIMEOUT_MS,
      stdio: 'ignore',
    });
    cached = 'docker';
    logger.info('Build strategy: docker (auto-detected daemon)');
  } catch {
    cached = 'kaniko';
    logger.info('Build strategy: kaniko (no Docker daemon detected)');
  }

  return cached;
}

/** Reset cached strategy (for testing only). */
export function _resetStrategyForTesting(): void {
  cached = null;
}
