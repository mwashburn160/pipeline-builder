import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { AWSConfig, PluginBuildConfig, RedisConfig, RegistryConfig } from './config-types';
import { getComputeType } from '../core/pipeline-helpers';

/**
 * Load Docker registry configuration from environment variables.
 *
 * Environment variables:
 * - `IMAGE_REGISTRY_HOST` — Registry hostname (default: `'registry'`)
 * - `IMAGE_REGISTRY_PORT` — Registry port (default: `5000`)
 * - `IMAGE_REGISTRY_USER` — Registry username (default: `'admin'`)
 * - `IMAGE_REGISTRY_TOKEN` — Registry auth token (default: `'password'`)
 * - `DOCKER_NETWORK` — Docker network for build/push (default: `''`)
 *
 * @returns Registry configuration
 */
export function loadRegistryConfig(): RegistryConfig {
  return {
    host: process.env.IMAGE_REGISTRY_HOST || 'registry',
    port: parseInt(process.env.IMAGE_REGISTRY_PORT || '5000', 10),
    user: process.env.IMAGE_REGISTRY_USER || (process.env.NODE_ENV === 'production' ? (() => { throw new Error('IMAGE_REGISTRY_USER is required in production'); })() : 'admin'),
    token: process.env.IMAGE_REGISTRY_TOKEN || (process.env.NODE_ENV === 'production' ? (() => { throw new Error('IMAGE_REGISTRY_TOKEN is required in production'); })() : 'password'),
    network: process.env.DOCKER_NETWORK || '',
    insecure: process.env.DOCKER_REGISTRY_INSECURE !== 'false',
  };
}

export function loadRedisConfig(): RedisConfig {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  };
}

/**
 * Load plugin build configuration from environment variables.
 *
 * Environment variables:
 * - `PLUGIN_BUILD_CONCURRENCY` — Max concurrent Docker plugin builds (default: `1`)
 *
 * @returns Plugin build configuration
 */
export function loadPluginBuildConfig(): PluginBuildConfig {
  return {
    concurrency: parseInt(process.env.PLUGIN_BUILD_CONCURRENCY || '1', 10),
  };
}

/**
 * Load AWS infrastructure configuration from environment variables.
 *
 * Environment variables:
 * - `LAMBDA_RUNTIME` — Lambda runtime (default: `'nodejs24.x'`; supports nodejs20.x, nodejs22.x, nodejs24.x)
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
      memorySize: parseInt(process.env.LAMBDA_MEMORY_SIZE || '128', 10),
      architecture: process.env.LAMBDA_ARCHITECTURE === 'x86_64'
        ? Architecture.X86_64
        : Architecture.ARM_64,
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
    'nodejs20.x': Runtime.NODEJS_20_X,
    'nodejs22.x': Runtime.NODEJS_22_X,
    'nodejs24.x': Runtime.NODEJS_24_X,
  };
  return runtimeMap[runtime] || Runtime.NODEJS_24_X;
}

/**
 * Parse log retention days string into a CDK RetentionDays enum value.
 *
 * @param days - Retention period in days as a string (e.g. `'30'`)
 * @returns CDK RetentionDays enum; falls back to ONE_DAY for unknown values
 */
function parseRetention(days: string): RetentionDays {
  const retentionMap: Record<string, RetentionDays> = {
    1: RetentionDays.ONE_DAY,
    3: RetentionDays.THREE_DAYS,
    5: RetentionDays.FIVE_DAYS,
    7: RetentionDays.ONE_WEEK,
    14: RetentionDays.TWO_WEEKS,
    30: RetentionDays.ONE_MONTH,
    60: RetentionDays.TWO_MONTHS,
    90: RetentionDays.THREE_MONTHS,
    120: RetentionDays.FOUR_MONTHS,
    150: RetentionDays.FIVE_MONTHS,
    180: RetentionDays.SIX_MONTHS,
    365: RetentionDays.ONE_YEAR,
    400: RetentionDays.THIRTEEN_MONTHS,
    545: RetentionDays.EIGHTEEN_MONTHS,
    731: RetentionDays.TWO_YEARS,
    1827: RetentionDays.FIVE_YEARS,
    3653: RetentionDays.TEN_YEARS,
  };
  return retentionMap[days] || RetentionDays.ONE_DAY;
}
