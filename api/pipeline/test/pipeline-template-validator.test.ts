// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `project` is the ONLY templatable top-level pipeline field. The validator used
 * to accept a synthetic `projectName` alias alongside it, which meant a stored
 * template could carry `{{ ... }}` under either key. Every writer emits `project`
 * (BuilderProps), so the alias is gone: a `projectName` key is now an ordinary,
 * non-templatable field and its tokens are neither validated nor resolved.
 */

import { describe, it, expect } from '@jest/globals';
import { validatePipelineTemplates } from '../src/helpers/pipeline-template-validator.js';

describe('validatePipelineTemplates', () => {
  it('validates tokens in `project`', () => {
    expect(() => validatePipelineTemplates({
      props: { project: '{{ vars.service }}-{{ metadata.env }}', global: { env: 'prod' }, vars: { service: 'checkout' } },
    })).not.toThrow();
  });

  it('rejects an unknown scope root in `project`', () => {
    expect(() => validatePipelineTemplates({
      props: { project: '{{ nope.service }}', global: {}, vars: {} },
    })).toThrow(/Pipeline template validation failed/);
  });

  it('detects a cycle through `project`', () => {
    expect(() => validatePipelineTemplates({
      props: { project: 'app', global: { a: '{{ metadata.b }}' }, synth: { metadata: { b: '{{ metadata.a }}' } }, vars: {} },
    })).toThrow(/circular template references/);
  });

  it('validates tokens in pipeline metadata — `global`, `defaults.metadata` and `synth.metadata`', () => {
    for (const props of [
      { project: 'app', global: { region: '{{ nope.x }}' } },
      { project: 'app', defaults: { metadata: { region: '{{ nope.x }}' } } },
      { project: 'app', synth: { metadata: { region: '{{ nope.x }}' } } },
    ]) {
      expect(() => validatePipelineTemplates({ props })).toThrow(/Pipeline template validation failed/);
    }
  });

  it('ignores a `metadata` key — it is not a pipeline field (synth never reads it)', () => {
    expect(() => validatePipelineTemplates({
      props: { project: 'app', metadata: { region: '{{ nope.x }}' } } as Record<string, unknown>,
    })).not.toThrow();
  });

  it('ignores a `projectName` key entirely — it is no longer a templatable name', () => {
    // A bad token under `projectName` would fail validation if the alias were
    // still accepted; it passes because the key is not scanned at all.
    expect(() => validatePipelineTemplates({
      props: { projectName: '{{ nope.service }}', global: {}, vars: {} } as Record<string, unknown>,
    })).not.toThrow();
  });
});

// Resolution itself (`GET ?resolve=true`, synth, `--show-resolved`) is
// pipeline-core's `resolvePipelineProps` — see its suite (test/template/pipeline-props.test.ts).

describe('validatePipelineTemplates — synth.source is the repository identity', () => {
  const templated = { props: { project: 'app', synth: { source: { type: 'github', options: { repo: '{{ vars.repo }}', branch: 'main' } } }, vars: { repo: 'acme/app' } } };

  it('refuses `{{ … }}` in a pipeline source field — it would reach CodePipeline as literal text', () => {
    expect(() => validatePipelineTemplates(templated)).toThrow(/synth\.source\.options\.repo[\s\S]*source must name a real repository/);
  });

  it('allows `{{ vars.* }}` there in a TEMPLATE body (instantiate bakes it), and nothing else', () => {
    expect(() => validatePipelineTemplates(templated, { template: true })).not.toThrow();
    expect(() => validatePipelineTemplates({ props: { project: 'app', synth: { source: { type: 'github', options: { repo: '{{ metadata.repo }}' } } } } }, { template: true }))
      .toThrow(/Pipeline template validation failed/);
  });

  it('leaves the token alone (it resolves at synth against the pipeline scope)', () => {
    expect(() => validatePipelineTemplates({ props: { project: 'app', synth: { source: { type: 'github', options: { repo: 'acme/app', token: 'secretsmanager:pb/{{ pipeline.vars.orgId }}/t' } } } } }))
      .not.toThrow();
  });
});
