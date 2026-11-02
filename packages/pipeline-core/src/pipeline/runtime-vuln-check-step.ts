// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { BuildSpec } from 'aws-cdk-lib/aws-codebuild';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CodeBuildStep } from 'aws-cdk-lib/pipelines';
import { RUNTIME_CHECK_STEPS_ENV, type RuntimeCheckStep } from '../core/runtime-check.js';

/** What a stage's verify step needs. */
export interface RuntimeVulnCheckStepProps {
  /** Construct id of the step (unique per stage). */
  readonly id: string;
  /** The stage's image-backed steps, as the plugin service knows them. */
  readonly steps: readonly RuntimeCheckStep[];
  /**
   * The org's platform secret (`<prefix>/<orgId>/platform`). The verify step
   * reads it itself (`--store-tokens`), so its role is granted exactly that one
   * secret — like the synth project, and unlike a plugin step.
   */
  readonly platformSecretName: string;
}

/**
 * The step that re-asks the plugin service, at run time, what it now knows
 * about the images this stage runs (see `core/runtime-check.ts`).
 *
 * Sets no image of its own, so it runs on the pipeline-wide default
 * (`codeBuildDefaults` → `pipeline-bootstrap`, which carries
 * `pipeline-manager`), never on a plugin image: no user code runs in it, which
 * is what makes handing it the platform credential acceptable. `PIPELINE_ID`,
 * `PLATFORM_BASE_URL` and `PLATFORM_SECRET_NAME` come from the pipeline-wide
 * CodeBuild defaults. It prints a graded verdict and always exits 0 for
 * vulnerability state, so it runs beside the stage's steps rather than in
 * front of them — visibility, never a gate.
 */
export function createRuntimeVulnCheckStep(props: RuntimeVulnCheckStepProps): CodeBuildStep {
  return new CodeBuildStep(props.id, {
    commands: ['pipeline-manager plugin verify --pipeline-id "${PIPELINE_ID}" --store-tokens'],
    partialBuildSpec: BuildSpec.fromObject({ env: { shell: '/bin/sh' } }),
    buildEnvironment: {
      environmentVariables: {
        [RUNTIME_CHECK_STEPS_ENV]: { value: JSON.stringify(props.steps) },
      },
    },
    rolePolicyStatements: [new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:*:*:secret:${props.platformSecretName}-*`],
    })],
  });
}
