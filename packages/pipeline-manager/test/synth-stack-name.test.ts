// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The synth app's stack name must be the one every other lane derives
 * (deployedPipelineNames: the deploy request, the deploy job's checks, the
 * registry, cleanup and undeploy) — including for a templated `project`,
 * which the synth resolves only after the stack is created.
 */

import { describe, expect, it } from '@jest/globals';
import { deployedPipelineNames } from '@pipeline-builder/pipeline-core';
import { synthStackName } from '../src/utils/synth-stack-name.js';

describe('synthStackName', () => {
  it('a templated project names the stack by its VALUE, as deployedPipelineNames does', () => {
    const props = { project: '{{ vars.app }}', organization: 'acme', vars: { app: 'shop' } };
    const expected = deployedPipelineNames({ project: props.project, organization: props.organization, props }).stackName;
    expect(expected).not.toContain('{');
    expect(synthStackName(props)).toBe(expected);
  });

  it('a plain pair is unchanged', () => {
    const props = { project: 'shop', organization: 'acme' };
    expect(synthStackName(props)).toBe(deployedPipelineNames({ ...props, props }).stackName);
  });
});
