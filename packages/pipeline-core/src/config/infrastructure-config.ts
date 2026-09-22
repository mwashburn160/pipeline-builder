// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envBool, envInt, envStr } from '@pipeline-builder/api-core';
import path from 'path';
import type { AWSConfig, BuildConfig, ComplianceConfig, DatabaseConfig, ObservabilityConfig, PluginBuildConfig, RegistryConfig } from './config-types.js';

/**
 * Load Docker registry configuration from environment variables.
 *
 * Environment variables:
 * - `IMAGE_REGISTRY_HOST` — Registry hostname (default: `'registry'`)
 * - `IMAGE_REGISTRY_PORT` — Registry port (default: `5000`)
 * - `IMAGE_REGISTRY_PULL_HOST` — Host an out-of-cluster client (CodeBuild)
 *   uses to pull plugin images. When unset, derived from `PLATFORM_BASE_URL`'s
 *   host (the public endpoint CodeBuild can resolve), then `IMAGE_REGISTRY_HOST`.
 * - `IMAGE_REGISTRY_PULL_PORT` — Port for the above. When unset, derived from
 *   `PLATFORM_BASE_URL`'s port, then `IMAGE_REGISTRY_PORT`.
 * - `DOCKER_NETWORK` — Docker network for build/push (default: `''`)
 * - `IMAGE_REGISTRY_HTTP` — Use plain HTTP instead of HTTPS (default: `true`,
 *   the in-cluster registry has no TLS).
 *
 * @returns Registry configuration
 */
export function loadRegistryConfig(): RegistryConfig {
  const host = envStr('IMAGE_REGISTRY_HOST', 'registry');
  const port = envInt('IMAGE_REGISTRY_PORT', 5_000);
  // When no explicit pull host is set, derive it from PLATFORM_BASE_URL — the
  // public platform endpoint an out-of-cluster client (AWS CodeBuild) can
  // resolve, unlike the in-cluster `registry` ClusterIP. Only falls back to the
  // in-cluster host when PLATFORM_BASE_URL is unset/unparseable (e.g. local).
  const platform = parsePlatformBaseUrl(process.env.PLATFORM_BASE_URL);
  return {
    host,
    port,
    pullHost: process.env.IMAGE_REGISTRY_PULL_HOST || platform?.host || host,
    pullPort: process.env.IMAGE_REGISTRY_PULL_PORT
      ? envInt('IMAGE_REGISTRY_PULL_PORT', port)
      : (platform?.port ?? port),
    network: envStr('DOCKER_NETWORK', ''),
    http: envBool('IMAGE_REGISTRY_HTTP', true),
  };
}

/** Extract host + port from PLATFORM_BASE_URL (e.g. `https://pipeline-builder.com`
 *  → `{ host: 'pipeline-builder.com', port: 443 }`). Returns null when the value
 *  is unset or not a valid URL. Exported so the CLI (pipeline-manager) derives
 *  the registry pull target with the SAME parsing, instead of duplicating it. */
export function parsePlatformBaseUrl(raw?: string): { host: string; port: number } | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // A scheme-less value like `host:8443` parses with a custom protocol and an
    // EMPTY hostname — reject it so callers fall back rather than derive a
    // host-less endpoint.
    if (!u.hostname) return null;
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

/**
 * Load plugin build queue configuration.
 *
 * Environment variables:
 * - `PLUGIN_BUILD_CONCURRENCY` — Max concurrent plugin builds (default: `1`)
 */
export function loadPluginBuildConfig(): PluginBuildConfig {
  return {
    concurrency: envInt('PLUGIN_BUILD_CONCURRENCY', 1),
    maxAttempts: envInt('PLUGIN_BUILD_MAX_ATTEMPTS', 2),
    backoffDelayMs: envInt('PLUGIN_BUILD_BACKOFF_DELAY_MS', 5_000),
    workerTimeoutMs: envInt('PLUGIN_BUILD_WORKER_TIMEOUT_MS', 10_000),
    tempDirMaxAgeMs: envInt('TEMP_DIR_MAX_AGE_MS', 14_400_000),
    dlqMaxAttempts: envInt('PLUGIN_DLQ_MAX_ATTEMPTS', 3),
    dlqBackoffBaseMs: envInt('PLUGIN_DLQ_BACKOFF_BASE_MS', 300_000),
    dlqMaxSize: envInt('PLUGIN_DLQ_MAX_SIZE', 20),
  };
}

export function loadDatabaseConfig(): DatabaseConfig {
  return {
    postgres: {
      host: envStr('DB_HOST', 'postgres'),
      port: envInt('DB_PORT', 5_432),
      database: envStr('DATABASE', 'pipeline_builder'),
      user: envStr('DB_USER', 'postgres'),
      password: envStr('DB_PASSWORD', ''),
    },
    drizzle: {
      maxPoolSize: envInt('DRIZZLE_MAX_POOL_SIZE', 20),
      idleTimeoutMillis: envInt('DRIZZLE_IDLE_TIMEOUT_MILLIS', 30_000),
      connectionTimeoutMillis: envInt('DRIZZLE_CONNECTION_TIMEOUT_MILLIS', 10_000),
    },
  };
}

export function loadObservabilityConfig(): ObservabilityConfig {
  return {
    logLevel: envStr('LOG_LEVEL', 'info'),
    logFormat: envStr('LOG_FORMAT', 'json'),
    serviceName: envStr('SERVICE_NAME', 'api'),
    tracing: {
      enabled: envBool('OTEL_TRACING_ENABLED', false),
      endpoint: envStr('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4318/v1/traces'),
    },
  };
}

export function loadComplianceConfig(): ComplianceConfig {
  return {
    scanSchedulerIntervalMs: envInt('SCAN_SCHEDULER_INTERVAL_MS', 60_000),
    systemOrgScansEnabled: envBool('SYSTEM_ORG_SCANS_ENABLED', false),
    scanLockTtlMs: envInt('SCAN_LOCK_TTL_MS', 300_000),
    digestSchedulerIntervalMs: envInt('DIGEST_SCHEDULER_INTERVAL_MS', 3_600_000),
    digestLockTtlMs: envInt('DIGEST_LOCK_TTL_MS', 300_000),
  };
}

/**
 * Load plugin build configuration. Builds run against a rootless `moby/buildkit`
 * sidecar — see `BUILDKIT_HOST`.
 *
 * Environment variables:
 * - `DOCKER_BUILD_TEMP_ROOT` — Temp directory for build contexts (default: `<cwd>/tmp`)
 * - `DOCKER_BUILD_TIMEOUT_MS` — Build timeout in milliseconds (default: `900000` / 15 min)
 * - `DOCKER_PUSH_TIMEOUT_MS` — Push timeout in milliseconds (default: `300000` / 5 min)
 * - `BUILDKIT_HOST` — buildctl `--addr` value for the buildkitd sidecar
 *   (default: `unix:///run/buildkit/buildkitd.sock`)
 * - `PLUGIN_SIGNING_PUBLIC_KEY_FILE` — PEM public key plugin images are verified
 *   against (default: `/etc/pipeline-builder/plugin-signing/plugin-signing.pub`)
 */
export function loadDockerConfig(): BuildConfig {
  return {
    tempRoot: process.env.DOCKER_BUILD_TEMP_ROOT || path.join(process.cwd(), 'tmp'),
    timeoutMs: envInt('DOCKER_BUILD_TIMEOUT_MS', 900_000),
    pushTimeoutMs: envInt('DOCKER_PUSH_TIMEOUT_MS', 300_000),
    buildkitAddr: envStr('BUILDKIT_HOST', 'unix:///run/buildkit/buildkitd.sock'),
    signingPublicKeyFile: envStr('PLUGIN_SIGNING_PUBLIC_KEY_FILE', '/etc/pipeline-builder/plugin-signing/plugin-signing.pub'),
  };
}

/**
 * Load AWS infrastructure configuration from environment variables.
 *
 * Environment variables:
 * - `LAMBDA_RUNTIME` — Lambda runtime (default: `'nodejs24.x'`; unknown values fall back to it)
 * - `LAMBDA_TIMEOUT` — Lambda timeout in seconds (default: `900`)
 * - `LAMBDA_MEMORY_SIZE` — Lambda memory in MB (default: `512`)
 * - `LAMBDA_ARCHITECTURE` — `'x86_64'` or ARM (default: ARM_64)
 * - `LOG_GROUP_NAME` — CloudWatch log group (default: `'/pipeline-builder/logs'`)
 * - `CODEBUILD_COMPUTE_TYPE` — CodeBuild compute type (default: `'SMALL'`)
 *
 * @returns AWS infrastructure configuration
 */
export function loadAWSConfig(): AWSConfig {
  return {
    lambda: {
      runtime: envStr('LAMBDA_RUNTIME', 'nodejs24.x'),
      timeoutSeconds: envInt('LAMBDA_TIMEOUT', 900),
      memorySize: envInt('LAMBDA_MEMORY_SIZE', 512),
      architecture: process.env.LAMBDA_ARCHITECTURE === 'x86_64' ? 'x86_64' : 'arm64',
      reservedConcurrentExecutions: process.env.LAMBDA_RESERVED_CONCURRENCY
        ? envInt('LAMBDA_RESERVED_CONCURRENCY', 0)
        : undefined,
    },

    logging: {
      groupName: envStr('LOG_GROUP_NAME', '/pipeline-builder/logs'),
    },

    codeBuild: {
      computeType: (envStr('CODEBUILD_COMPUTE_TYPE', 'SMALL')).toUpperCase(),
      defaultImage: envStr('CODEBUILD_DEFAULT_IMAGE', 'pipeline-bootstrap:1.0'),
    },
  };
}
