// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK adapters for {@link AWSConfig}.
 *
 * `AWSConfig` is deliberately plain data (see its doc comment): env-loaded
 * numbers and strings, no `aws-cdk-lib` on the import graph. That keeps `Config`
 * — which every API service reads — free of CDK. These functions are the single
 * conversion point from that plain data into CDK value objects, and they live
 * behind the `@pipeline-builder/pipeline-core/cdk` entry point, so only code that
 * actually synthesizes stacks pays for `aws-cdk-lib`.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { AWSConfig } from './config-types.js';

/** Runtime identifiers this platform supports, mapped to their CDK enum member. */
const RUNTIMES: Record<string, Runtime> = {
  'nodejs24.x': Runtime.NODEJS_24_X,
};

/**
 * Resolve a Lambda runtime identifier (e.g. `'nodejs24.x'`) to a CDK `Runtime`.
 *
 * @param runtime - runtime identifier from `Config.get('aws').lambda.runtime`
 * @returns the CDK enum member; falls back to Node.js 24 for unknown values
 */
export function lambdaRuntime(runtime: AWSConfig['lambda']['runtime']): Runtime {
  return RUNTIMES[runtime] || Runtime.NODEJS_24_X;
}

/**
 * Convert a Lambda timeout in seconds to a CDK `Duration`.
 *
 * @param seconds - timeout from `Config.get('aws').lambda.timeoutSeconds`
 */
export function lambdaTimeout(seconds: AWSConfig['lambda']['timeoutSeconds']): Duration {
  return Duration.seconds(seconds);
}

/**
 * Resolve a Lambda architecture name to a CDK `Architecture`.
 *
 * @param architecture - value from `Config.get('aws').lambda.architecture`
 */
export function lambdaArchitecture(architecture: AWSConfig['lambda']['architecture']): Architecture {
  return architecture === 'x86_64' ? Architecture.X86_64 : Architecture.ARM_64;
}

/**
 * Convert a retention day count to CDK's `RetentionDays`.
 *
 * `RetentionDays` members are the day counts themselves, so the cast is exact —
 * `infrastructure-config.ts` has already validated the value against the same
 * set of allowed periods.
 *
 * @param days - value from `Config.get('aws').logging.retentionDays`
 */
export function logRetention(days: AWSConfig['logging']['retentionDays']): RetentionDays {
  return days as RetentionDays;
}

/**
 * Resolve a log-group removal policy name to a CDK `RemovalPolicy`.
 *
 * @param policy - value from `Config.get('aws').logging.removalPolicy`
 */
export function logRemovalPolicy(policy: AWSConfig['logging']['removalPolicy']): RemovalPolicy {
  return policy === 'retain' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}
