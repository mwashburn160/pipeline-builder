// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { defaultPipelineName, pipelineStackName } from '@pipeline-builder/api-core';
import { resolvePipelineProps } from '../template/pipeline-props.js';

/** The pipeline-record fields the deployed names derive from. */
export interface DeployedNamesInput {
  pipelineName?: string | null;
  project: string;
  organization: string;
  /**
   * The synth props (`pipeline.props`). The synth names the CodePipeline and
   * the stack from THESE raw values, while the record's `project` /
   * `organization` are stored sanitized (`spring-boot` -> `spring_boot`), so the
   * names are derived from them whenever they are present.
   */
  props?: Record<string, unknown> | null;
}

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * The CodePipeline and CloudFormation stack names a pipeline record deploys as:
 * the derivation the synth applies (boilerplate.ts names the stack,
 * PipelineConfiguration the pipeline), on the props resolved exactly as the
 * synth resolves them (a templated `project` names the stack by its VALUE).
 * Falls back to the record when the props carry no project / organization.
 *
 * ONE rule for every registry writer: the CLI's post-deploy registration and
 * the pipeline service's first-event self-registration must record the same
 * names, or trigger/cancel address a CodePipeline that does not exist.
 */
export function deployedPipelineNames(pipeline: DeployedNamesInput): { pipelineName: string; stackName: string } {
  const props = resolvePipelineProps(pipeline.props ?? {});
  const project = nonEmpty(props.project);
  const organization = nonEmpty(props.organization);
  if (project && organization) {
    return {
      pipelineName: nonEmpty(props.pipelineName) ?? defaultPipelineName(organization, project),
      stackName: pipelineStackName(project, organization),
    };
  }
  return {
    pipelineName: pipeline.pipelineName || defaultPipelineName(pipeline.organization, pipeline.project),
    stackName: pipelineStackName(pipeline.project, pipeline.organization),
  };
}
