// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { deployedPipelineNames } from '@pipeline-builder/pipeline-core';

/**
 * The CloudFormation stack name the synth app (boilerplate.ts) creates for
 * `props`: pipeline-core's deployedPipelineNames — the one derivation the
 * deploy request, the runner deploy job's checks, the registry, cleanup and
 * undeploy all use. It resolves the props first, so a templated `project`
 * (`{{ vars.app }}`) names the stack by its value, not its template text
 * (PipelineBuilder resolves templates only after the stack exists).
 */
export function synthStackName(props: { project: string; organization: string } & Record<string, unknown>): string {
  return deployedPipelineNames({ project: props.project, organization: props.organization, props }).stackName;
}
