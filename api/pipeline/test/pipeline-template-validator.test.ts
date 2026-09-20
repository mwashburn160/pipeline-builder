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
      props: { project: '{{ vars.service }}-{{ metadata.env }}', metadata: { env: 'prod' }, vars: { service: 'checkout' } },
    })).not.toThrow();
  });

  it('rejects an unknown scope root in `project`', () => {
    expect(() => validatePipelineTemplates({
      props: { project: '{{ nope.service }}', metadata: {}, vars: {} },
    })).toThrow(/Pipeline template validation failed/);
  });

  it('detects a cycle through `project`', () => {
    expect(() => validatePipelineTemplates({
      props: { project: 'app', metadata: { a: '{{ metadata.b }}', b: '{{ metadata.a }}' }, vars: {} },
    })).toThrow(/circular template references/);
  });

  it('ignores a `projectName` key entirely — it is no longer a templatable name', () => {
    // A bad token under `projectName` would fail validation if the alias were
    // still accepted; it passes because the key is not scanned at all.
    expect(() => validatePipelineTemplates({
      props: { projectName: '{{ nope.service }}', metadata: {}, vars: {} } as Record<string, unknown>,
    })).not.toThrow();
  });
});

describe('resolvePipeline', () => {
  it('expands self-references in `project`', () => {
    const pipeline = {
      props: { project: '{{ vars.service }}-{{ metadata.env }}', metadata: { env: 'prod' }, vars: { service: 'checkout' } },
    };
    resolvePipeline(pipeline);
    expect(pipeline.props.project).toBe('checkout-prod');
  });

  it('leaves `{{ ... }}` under `projectName` unresolved (stored templates on the old key stop resolving)', () => {
    const pipeline = {
      props: { projectName: '{{ vars.service }}', metadata: {}, vars: { service: 'checkout' } },
    };
    resolvePipeline(pipeline as never);
    expect(pipeline.props.projectName).toBe('{{ vars.service }}');
  });
});
