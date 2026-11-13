// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared pipeline types used by both pipeline-core and pipeline-data
 */

/**
 * Utility type to extract the union of all values from an object type
 */
type ValueOf<T> = T[keyof T];

/**
 * AWS CodeBuild compute resource sizes
 *
 * @property SMALL - 3 GB memory, 2 vCPUs
 * @property MEDIUM - 7 GB memory, 4 vCPUs
 * @property LARGE - 15 GB memory, 8 vCPUs
 * @property X2_LARGE - 145 GB memory, 72 vCPUs
 *
 * @see https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html
 */
export const ComputeType = {
  SMALL: 'SMALL',
  MEDIUM: 'MEDIUM',
  LARGE: 'LARGE',
  X2_LARGE: 'X2_LARGE',
} as const;
export type ComputeType = ValueOf<typeof ComputeType>;

/**
 * vCPU each CodeBuild compute size provides, for turning a build's DURATION
 * into `cpuCredits` (one credit = one vCPU-minute).
 *
 * Derived from the same AWS table the `ComputeType` doc above cites, and kept
 * beside it on purpose: the memory/vCPU figures in that comment and the numbers
 * here are the same fact, and splitting them is how one gets updated alone.
 *
 * `X2_LARGE` is 72 vCPU — thirty-six times SMALL. That ratio is why pipeline
 * execution cannot be charged by wall-clock alone, and why ingesting it
 * (Phase 4) re-derives the tier ladder rather than simply adding to it.
 */
export const CODEBUILD_COMPUTE_VCPU: Readonly<Record<ComputeType, number>> = {
  SMALL: 2,
  MEDIUM: 4,
  LARGE: 8,
  X2_LARGE: 72,
};

/**
 * AWS's own spelling of a compute size, as `BatchGetBuilds` returns it
 * (`environment.computeType`), narrowed to ours.
 *
 * Needed because the two vocabularies differ: the pipeline config stores
 * `MEDIUM`, AWS answers `BUILD_GENERAL1_MEDIUM`, and a wrong match here would
 * price a build at the wrong vCPU rather than failing visibly. Anything
 * unrecognised returns `null` — an unknown size must be reported as unknown, not
 * silently priced as SMALL, which is the cheapest and therefore the most
 * flattering guess.
 */
export function normalizeComputeType(raw: string | undefined | null): ComputeType | null {
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const bare = upper.startsWith('BUILD_GENERAL1_') ? upper.slice('BUILD_GENERAL1_'.length) : upper;
  // AWS spells the largest one `2XLARGE`; ours is `X2_LARGE`.
  const key = bare === '2XLARGE' || bare === 'X2LARGE' ? 'X2_LARGE' : bare;
  return (Object.keys(CODEBUILD_COMPUTE_VCPU) as ComputeType[]).find((c) => c === key) ?? null;
}

/**
 * Credits one CodeBuild action consumed, from its duration and compute size.
 *
 * Rounds UP to the whole credit, matching the plugin-build meter
 * (`creditsForBuild`) — two meters feeding one counter must round the same way
 * or the counter means neither.
 *
 * Returns `null` rather than 0 when either input is missing, and the distinction
 * is the point: a build with no measured duration was not observed, and
 * reporting that as zero consumption would make the coverage gap look like
 * idleness. The ingest counts those separately (`measured="false"`) so the
 * coverage ratio is visible BEFORE anyone prices a tier off this series.
 */
export function computeCreditsFor(durationMs: number | null | undefined, computeType: ComputeType | null): number | null {
  if (durationMs == null || !(durationMs > 0) || !computeType) return null;
  return Math.ceil((durationMs / 60_000) * CODEBUILD_COMPUTE_VCPU[computeType]);
}

/**
 * Types of pipeline steps that can be created by plugins
 *
 * @property CODE_BUILD_STEP - Full CodeBuild step with custom build environment
 * @property SHELL_STEP - Simple shell step without custom build environment
 * @property MANUAL_APPROVAL_STEP - Native CDK approval gate (no Docker image, no commands)
 * @property BUILD_IMAGE - A managed toolchain build image (`pipeline-bootstrap`): never a step
 */
export const PluginType = {
  CODE_BUILD_STEP: 'CodeBuildStep',
  SHELL_STEP: 'ShellStep',
  MANUAL_APPROVAL_STEP: 'ManualApprovalStep',
  BUILD_IMAGE: 'BuildImage',
} as const;
export type PluginType = ValueOf<typeof PluginType>;

/**
 * Metadata type for storing configuration and custom properties
 *
 * Supports:
 * - Standard key-value pairs (string, boolean, number)
 * - Custom AWS CDK keys with the pattern `aws:cdk:{namespace}:{key}`
 *   (all lowercase — matches the format produced by `getCustomKey`)
 *
 * @example
 * ```typescript
 * const metadata: MetaDataType = {
 *   BUILD_ENV: 'production',
 *   NODE_VERSION: '18',
 *   ENABLE_CACHE: true,
 *   MAX_RETRIES: 3
 * };
 * ```
 */
export type MetaDataType =
  Record<string, string | boolean | number> &
  { [K in `aws:cdk:${string}`]?: unknown };
