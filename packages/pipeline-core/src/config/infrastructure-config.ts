import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { AWSConfig, RegistryConfig } from './config-types';
import { getComputeType } from '../core/pipeline-helpers';

/**
 * Load Docker registry configuration from environment variables
 */
export function loadRegistryConfig(): RegistryConfig {
  return {
    host: process.env.IMAGE_REGISTRY_HOST || 'registry',
    port: parseInt(process.env.IMAGE_REGISTRY_PORT || '5000'),
    user: process.env.IMAGE_REGISTRY_USER || 'admin',
    token: process.env.IMAGE_REGISTRY_TOKEN || 'password',
    network: process.env.DOCKER_NETWORK || '',
  };
}

/**
 * Load AWS infrastructure configuration from environment variables
 */
export function loadAWSConfig(): AWSConfig {
  return {
    lambda: {
      runtime: parseRuntime(process.env.LAMBDA_RUNTIME || 'nodejs22.x'),
      timeout: Duration.seconds(parseInt(process.env.LAMBDA_TIMEOUT || '900')),
      memorySize: parseInt(process.env.LAMBDA_MEMORY_SIZE || '128'),
      architecture: process.env.LAMBDA_ARCHITECTURE === 'x86_64'
        ? Architecture.X86_64
        : Architecture.ARM_64,
    },
    logging: {
      groupName: process.env.LOG_GROUP_NAME || '/pipeline-builder/logs',
      retention: parseRetention(process.env.LOG_RETENTION || '1'),
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
 * Parse Lambda runtime from string
 */
function parseRuntime(runtime: string): Runtime {
  const runtimeMap: Record<string, Runtime> = {
    'nodejs18.x': Runtime.NODEJS_18_X,
    'nodejs20.x': Runtime.NODEJS_20_X,
    'nodejs22.x': Runtime.NODEJS_22_X,
  };
  return runtimeMap[runtime] || Runtime.NODEJS_22_X;
}

/**
 * Parse log retention from days
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
