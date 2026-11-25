// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CodePipeline + CloudFormation stack names a pipeline record deploys as.
 * ONE derivation shared by the CLI's registry payload (after `pipeline deploy`)
 * and the pipeline service's first-event self-registration, so a pipeline that
 * registers itself records exactly the names a CLI deploy would have.
 */

import { describe, expect, it } from '@jest/globals';
import { defaultPipelineName, pipelineStackName } from '@pipeline-builder/api-core';
import { deployedPipelineNames } from '../src/core/deployed-names.js';

describe('deployedPipelineNames', () => {
  it('falls back to the record when the props carry no project / organization', () => {
    expect(deployedPipelineNames({ project: 'spring_boot', organization: 'system' })).toEqual({
      pipelineName: defaultPipelineName('system', 'spring_boot'),
      stackName: pipelineStackName('spring_boot', 'system'),
    });
  });

  it('uses the record pipelineName in the fallback', () => {
    expect(deployedPipelineNames({ pipelineName: 'named', project: 'api', organization: 'acme' }).pipelineName).toBe('named');
  });

  it('derives from the RAW synth props over the sanitized record', () => {
    expect(deployedPipelineNames({
      project: 'spring_boot', organization: 'acme', props: { project: 'Spring-Boot', organization: 'Acme' },
    })).toEqual({ pipelineName: defaultPipelineName('Acme', 'Spring-Boot'), stackName: 'spring-boot-acme' });
  });

  it('derives from the RESOLVED props when project is templated', () => {
    expect(deployedPipelineNames({
      project: 'app', organization: 'acme', props: { project: '{{ vars.service }}', organization: 'acme', vars: { service: 'checkout' } },
    })).toEqual({ pipelineName: defaultPipelineName('acme', 'checkout'), stackName: pipelineStackName('checkout', 'acme') });
  });

  it('prefers the props pipelineName (the CodePipeline is named from props)', () => {
    expect(deployedPipelineNames({
      pipelineName: 'record-name', project: 'app', organization: 'acme', props: { project: 'app', organization: 'acme', pipelineName: 'deployed-name' },
    }).pipelineName).toBe('deployed-name');
  });
});
