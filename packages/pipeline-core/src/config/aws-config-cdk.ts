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

import { Duration } from 'aws-cdk-lib';
import { Architecture, Runtime, RuntimeFamily } from 'aws-cdk-lib/aws-lambda';
import type { AWSConfig } from './config-types.js';

/**
 * Node.js 26, CONSTRUCTED rather than taken from the `Runtime` enum.
 *
 * `nodejs26.x` is a Lambda PUBLIC PREVIEW runtime (announced 2026-08). The
 * service accepts the identifier from the CLI, CloudFormation, SAM and CDK, but
 * `aws-cdk-lib` has no `NODEJS_26_X` member — not in 2.270.0, and not on CDK's
 * `main` either, because the enum tracks GA runtimes. `Runtime`'s public
 * constructor is the supported way to name one the enum has not caught up with,
 * and the identifier does not change at GA: `nodejs26.x` in preview is
 * `nodejs26.x` at GA, so this does not become wrong when the enum lands — it
 * just becomes redundant, and should be swapped for `Runtime.NODEJS_26_X` then.
 *
 * `supportsInlineCode` matches every other Node runtime in the enum.
 *
 * PREVIEW CAVEAT, stated where someone will read it: AWS does not cover preview
 * runtimes under the Lambda SLA or Support plans and advises against production
 * workloads on them. Lambda will not GA Node.js 26 until it reaches Active LTS.
 *
 * CONSTRUCTED LAZILY, not at module scope. `new Runtime(...)` on import means
 * every suite that mocks `aws-cdk-lib/aws-lambda` has to supply a CONSTRUCTIBLE
 * Runtime just to import anything downstream of this file — and a partial mock
 * that returns a plain object fails with `Runtime is not a constructor` before
 * a single assertion runs. Building it on first use keeps the import side-effect
 * free, so only code that actually resolves a runtime pays for it.
 */
let previewRuntime: Runtime | undefined;
const nodejs26Preview = (): Runtime => (previewRuntime ??= new Runtime('nodejs26.x', RuntimeFamily.NODEJS, { supportsInlineCode: true }));

/**
 * Resolve a Lambda runtime identifier (e.g. `'nodejs26.x'`) to a CDK `Runtime`.
 *
 * @param runtime - runtime identifier from `Config.get('aws').lambda.runtime`
 * @returns the CDK runtime; falls back to Node.js 26 for unknown values
 */
export function lambdaRuntime(runtime: AWSConfig['lambda']['runtime']): Runtime {
  if (runtime === 'nodejs24.x') return Runtime.NODEJS_24_X;
  return nodejs26Preview();
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
 * Resolve the configured Lambda architecture to a CDK `Architecture`.
 *
 * @param architecture - value from `Config.get('aws').lambda.architecture`
 */
export function lambdaArchitecture(architecture: AWSConfig['lambda']['architecture']): Architecture {
  return architecture === 'x86_64' ? Architecture.X86_64 : Architecture.ARM_64;
}
