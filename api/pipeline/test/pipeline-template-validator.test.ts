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
import { validatePipelineTemplates, resolvePipeline } from '../src/helpers/pipeline-template-validator.js';

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

describe('resolvePipeline', () => {
  it('expands self-references in `project`', () => {
    const pipeline = {
      props: { project: '{{ vars.service }}-{{ metadata.env }}', global: { env: 'prod' }, vars: { service: 'checkout' } },
    };
    resolvePipeline(pipeline);
    expect(pipeline.props.project).toBe('checkout-prod');
  });

  it('resolves metadata across layers and writes each key back to the layer synth takes it from', () => {
    const pipeline = {
      props: {
        project: '{{ metadata.env }}-app',
        global: { env: 'dev', region: 'us-east-1', stack: '{{ metadata.env }}-{{ metadata.region }}' },
        synth: { metadata: { env: 'prod' } },
        vars: {},
      },
    };
    resolvePipeline(pipeline);
    expect(pipeline.props.project).toBe('prod-app');
    expect(pipeline.props.global.stack).toBe('prod-us-east-1');
    // The overridden lower-layer value is left as written.
    expect(pipeline.props.global.env).toBe('dev');
    expect(pipeline.props.synth.metadata.env).toBe('prod');
  });

  it('leaves `{{ ... }}` under `projectName` unresolved (stored templates on the old key stop resolving)', () => {
    const pipeline = {
      props: { projectName: '{{ vars.service }}', global: {}, vars: { service: 'checkout' } },
    };
    resolvePipeline(pipeline as never);
    expect(pipeline.props.projectName).toBe('{{ vars.service }}');
  });
});
