// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import path from 'path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { AWSConfig, BuildConfig, ComplianceConfig, DatabaseConfig, ObservabilityConfig, PluginBuildConfig, RedisConfig, RegistryConfig } from './config-types';
import { getComputeType } from '../core/pipeline-helpers';

function requireInProduction(envVar: string, devDefault: string): string {
  const value = process.env[envVar];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${envVar} is required in production`);
  }
  return devDefault;
}

/**
 * Load Docker registry configuration from environment variables.
 *
 * Environment variables:
 * - `IMAGE_REGISTRY_HOST` — Registry hostname (default: `'registry'`)
 * - `IMAGE_REGISTRY_PORT` — Registry port (default: `5000`)
 * - `IMAGE_REGISTRY_USER` — Registry username (default: `'admin'`)
 * - `IMAGE_REGISTRY_TOKEN` — Registry auth token (default: `'password'`)
 * - `DOCKER_NETWORK` — Docker network for build/push (default: `''`)
 * - `DOCKER_REGISTRY_HTTP` — Use plain HTTP (default: `true`). Set `false` for HTTPS.
 * - `DOCKER_REGISTRY_INSECURE` — Skip TLS verification (default: `true`). Set `false` for production.
 *
 * @returns Registry configuration
 */
export function loadRegistryConfig(): RegistryConfig {
  return {
    host: process.env.IMAGE_REGISTRY_HOST || 'registry',
    port: parseInt(process.env.IMAGE_REGISTRY_PORT || '5000', 10),
    user: requireInProduction('IMAGE_REGISTRY_USER', 'admin'),
    token: requireInProduction('IMAGE_REGISTRY_TOKEN', 'password'),
    network: process.env.DOCKER_NETWORK || '',
    http: process.env.DOCKER_REGISTRY_HTTP !== 'false',
    insecure: process.env.DOCKER_REGISTRY_INSECURE !== 'false',
    credentialsSecret: process.env.IMAGE_REGISTRY_CREDS_SECRET
      || 'pipeline-builder/system/registry',
  };
}

export function loadRedisConfig(): RedisConfig {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  };
}

/**
 * Load plugin build queue configuration.
 *
 * Environment variables:
 * - `PLUGIN_BUILD_CONCURRENCY` — Max concurrent plugin builds (default: `1`)
 */
export function loadPluginBuildConfig(): PluginBuildConfig {
  return {
    concurrency: parseInt(process.env.PLUGIN_BUILD_CONCURRENCY || '1', 10),
    maxAttempts: parseInt(process.env.PLUGIN_BUILD_MAX_ATTEMPTS || '2', 10),
    backoffDelayMs: parseInt(process.env.PLUGIN_BUILD_BACKOFF_DELAY_MS || '5000', 10),
    workerTimeoutMs: parseInt(process.env.PLUGIN_BUILD_WORKER_TIMEOUT_MS || '10000', 10),
    tempDirMaxAgeMs: parseInt(process.env.TEMP_DIR_MAX_AGE_MS || '14400000', 10),
    dlqMaxAttempts: parseInt(process.env.PLUGIN_DLQ_MAX_ATTEMPTS || '3', 10),
    dlqBackoffBaseMs: parseInt(process.env.PLUGIN_DLQ_BACKOFF_BASE_MS || '300000', 10),
    dlqMaxSize: parseInt(process.env.PLUGIN_DLQ_MAX_SIZE || '20', 10),
  };
}

export function loadDatabaseConfig(): DatabaseConfig {
  return {
    postgres: {
      host: process.env.DB_HOST || 'postgres',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DATABASE || 'pipeline_builder',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
    },
    drizzle: {
      maxPoolSize: parseInt(process.env.DRIZZLE_MAX_POOL_SIZE || '20', 10),
      idleTimeoutMillis: parseInt(process.env.DRIZZLE_IDLE_TIMEOUT_MILLIS || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.DRIZZLE_CONNECTION_TIMEOUT_MILLIS || '10000', 10),
    },
  };
}

export function loadObservabilityConfig(): ObservabilityConfig {
  return {
    logLevel: process.env.LOG_LEVEL || 'info',
    logFormat: process.env.LOG_FORMAT || 'json',
    serviceName: process.env.SERVICE_NAME || 'api',
    tracing: {
      enabled: process.env.OTEL_TRACING_ENABLED === 'true',
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
    },
  };
}

export function loadComplianceConfig(): ComplianceConfig {
  return {
    scanSchedulerIntervalMs: parseInt(process.env.SCAN_SCHEDULER_INTERVAL_MS || '60000', 10),
    systemOrgScansEnabled: process.env.SYSTEM_ORG_SCANS_ENABLED === 'true',
  };
}

/**
 * Load Docker/Podman/Kaniko build configuration.
 *
 * Environment variables:
 * - `DOCKER_BUILD_STRATEGY` — Build strategy: `podman`, `docker`, or `kaniko` (default: `podman`)
 * - `DOCKER_BUILD_TEMP_ROOT` — Temp directory for build contexts (default: `<cwd>/tmp`)
 * - `DOCKER_BUILD_TIMEOUT_MS` — Build timeout in milliseconds (default: `900000` / 15 min)
 * - `DOCKER_PUSH_TIMEOUT_MS` — Push timeout in milliseconds (default: `300000` / 5 min)
 * - `KANIKO_EXECUTOR_PATH` — Path to Kaniko executor binary (default: `/kaniko/executor`)
 * - `KANIKO_CACHE_DIR` — Kaniko layer cache directory (default: `/kaniko/cache`)
 */
export function loadDockerConfig(): BuildConfig {
  const validStrategies = new Set(['docker', 'kaniko', 'podman']);
  const strategyEnv = (process.env.DOCKER_BUILD_STRATEGY || '').toLowerCase();
  return {
    strategy: validStrategies.has(strategyEnv) ? strategyEnv as BuildConfig['strategy'] : 'docker',
    tempRoot: process.env.DOCKER_BUILD_TEMP_ROOT || path.join(process.cwd(), 'tmp'),
    timeoutMs: parseInt(process.env.DOCKER_BUILD_TIMEOUT_MS || '900000', 10),
    pushTimeoutMs: parseInt(process.env.DOCKER_PUSH_TIMEOUT_MS || '300000', 10),
    kanikoExecutor: process.env.KANIKO_EXECUTOR_PATH || '/kaniko/executor',
    kanikoCacheDir: process.env.KANIKO_CACHE_DIR || '/kaniko/cache',
  };
}

/**
 * Load AWS infrastructure configuration from environment variables.
 *
 * Environment variables:
 * - `LAMBDA_RUNTIME` — Lambda runtime (default: `'nodejs24.x'`; supports nodejs22.x, nodejs24.x)
 * - `LAMBDA_TIMEOUT` — Lambda timeout in seconds (default: `900`)
 * - `LAMBDA_MEMORY_SIZE` — Lambda memory in MB (default: `128`)
 * - `LAMBDA_ARCHITECTURE` — `'x86_64'` or ARM (default: ARM_64)
 * - `LOG_GROUP_NAME` — CloudWatch log group (default: `'/pipeline-builder/logs'`)
 * - `LOG_RETENTION` — Log retention in days (default: `7`)
 * - `LOG_REMOVAL_POLICY` — `'RETAIN'` or destroy (default: DESTROY)
 * - `CODEBUILD_COMPUTE_TYPE` — CodeBuild compute type (default: `'SMALL'`)
 *
 * @returns AWS infrastructure configuration
 */
export function loadAWSConfig(): AWSConfig {
  return {
    lambda: {
      runtime: parseRuntime(process.env.LAMBDA_RUNTIME || 'nodejs24.x'),
      timeout: Duration.seconds(parseInt(process.env.LAMBDA_TIMEOUT || '900', 10)),
      memorySize: parseInt(process.env.LAMBDA_MEMORY_SIZE || '512', 10),
      architecture: process.env.LAMBDA_ARCHITECTURE === 'x86_64'
        ? Architecture.X86_64
        : Architecture.ARM_64,
      reservedConcurrentExecutions: process.env.LAMBDA_RESERVED_CONCURRENCY
        ? parseInt(process.env.LAMBDA_RESERVED_CONCURRENCY, 10)
        : undefined,
    },

    logging: {
      groupName: process.env.LOG_GROUP_NAME || '/pipeline-builder/logs',
      retention: parseRetention(process.env.LOG_RETENTION || '7'),
      removalPolicy: process.env.LOG_REMOVAL_POLICY === 'RETAIN'
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
    },

    codeBuild: {
      computeType: getComputeType(process.env.CODEBUILD_COMPUTE_TYPE || 'SMALL'),
    },
  };
}

/**
 * Parse Lambda runtime string into a CDK Runtime enum value.
 *
 * @param runtime - Runtime string (e.g. `'nodejs24.x'`)
 * @returns CDK Runtime enum; falls back to NODEJS_24_X for unknown values
 */
function parseRuntime(runtime: string): Runtime {
  const runtimeMap: Record<string, Runtime> = {
    'nodejs24.x': Runtime.NODEJS_24_X,
  };
  return runtimeMap[runtime] || Runtime.NODEJS_24_X;
}

/**
 * Parse log retention days string into a CDK RetentionDays enum value.
 * RetentionDays enum values are the numeric day counts themselves,
 * so we parse the string and check if it's a valid enum member.
 *
 * @param days - Retention period in days as a string (e.g. `'30'`)
 * @returns CDK RetentionDays enum; falls back to ONE_DAY for unknown values
 */
const VALID_RETENTION_DAYS = new Set(Object.values(RetentionDays).filter((v): v is number => typeof v === 'number'));

function parseRetention(days: string): RetentionDays {
  const parsed = parseInt(days, 10);
  return VALID_RETENTION_DAYS.has(parsed) ? parsed as RetentionDays : RetentionDays.ONE_DAY;
}
