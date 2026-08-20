// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { propsToFormState } from '../src/types/props-parsing';
import { assembleBuilderProps } from '../src/types/props-assembly';

/**
 * Regression coverage for pipeline `vars` editing in the form builder.
 *
 * Before this was wired, editing a pipeline through the dashboard rebuilt props
 * from form state that had no `vars` field — silently DROPPING any `vars` on
 * save (which breaks synth-time templates like a per-org secret path
 * `secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token`).
 */
describe('pipeline vars round-trip (form builder)', () => {
  const rawProps = {
    project: 'spring-boot',
    organization: 'AcmeCorp',
    vars: { orgId: 'org-abc-123', replicas: 3, canary: true },
    synth: {
      source: {
        type: 'github',
        options: {
          repo: 'dstar55/docker-hello-world-spring-boot',
          branch: 'master',
          token: 'secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token',
        },
      },
      plugin: { name: 'cdk-synth' },
    },
  };

  it('parses props.vars into editable form entries', () => {
    const state = propsToFormState(rawProps);
    expect(state.vars).toEqual(
      expect.arrayContaining([
        { key: 'orgId', value: 'org-abc-123', type: 'string' },
        { key: 'replicas', value: '3', type: 'number' },
        { key: 'canary', value: 'true', type: 'boolean' },
      ]),
    );
  });

  it('reassembles vars back into props (no data loss on save)', () => {
    const state = propsToFormState(rawProps);
    const { props, errors } = assembleBuilderProps(state, { skipValidation: true });
    expect(errors).toEqual({});
    expect(props?.vars).toEqual({ orgId: 'org-abc-123', replicas: 3, canary: true });
  });

  it('preserves the templated GitHub token alongside vars', () => {
    const state = propsToFormState(rawProps);
    const { props } = assembleBuilderProps(state, { skipValidation: true });
    const source = (props?.synth as { source: { options: { token: string } } }).source;
    expect(source.options.token).toBe('secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/github-token');
  });
});
