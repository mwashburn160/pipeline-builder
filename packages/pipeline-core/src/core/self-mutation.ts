// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Self-mutation runtime (docs/plans/bootstrap-image-versioning.md §3, D10).
 *
 * Self-mutation runs on an AWS CURATED image, not the toolchain's bootstrap
 * image, so a defective toolchain release can always be rolled back: the step
 * that re-deploys the pipeline does not depend on the release it is replacing.
 * It needs only Node and the CDK CLI. CDK Pipelines' SelfMutate runs
 * `npm install -g aws-cdk@<cliVersion>` then `cdk -a <asm> deploy` (no
 * re-synth), and `cliVersion` is always pinned to the release's `awsCdk`.
 *
 * The Node runtime is PINNED through `partialBuildSpec`
 * `phases.install.runtime-versions.nodejs`, never left to the image default,
 * and a contract test (test/self-mutation-runtime.test.ts) fails when the major
 * falls outside the pinned CLI's `engines.node` or the image's published runtimes.
 *
 * CDK-free (plain data) so the root entry can export it.
 */

/** The curated CodeBuild image self-mutation runs on. */
export const CURATED_SELF_MUTATION_IMAGE = 'aws/codebuild/standard:8.0';

/**
 * Node.js runtime majors `aws/codebuild/standard:8.0` publishes for
 * `runtime-versions.nodejs`.
 *
 * Source: https://github.com/aws/aws-codebuild-docker-images/blob/master/ubuntu/standard/8.0/runtimes.yml
 * (`runtimes.nodejs.versions`; read 2026-11-13). Re-check when the image changes.
 */
export const CURATED_SELF_MUTATION_NODE_RUNTIMES: readonly number[] = [22, 24, 26];

/** The Node.js major self-mutation pins (`runtime-versions.nodejs`). */
export const SELF_MUTATION_NODE_MAJOR = 24;

/** The `partialBuildSpec` object that pins self-mutation's Node runtime. */
export function selfMutationPartialBuildSpec(): Record<string, unknown> {
  return { phases: { install: { 'runtime-versions': { nodejs: String(SELF_MUTATION_NODE_MAJOR) } } } };
}
