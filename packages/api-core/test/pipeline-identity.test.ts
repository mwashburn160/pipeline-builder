// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from '@jest/globals';
import { defaultPipelineName, pipelineIdentityHash } from '../src/utils/pipeline-identity.js';

describe('pipelineIdentityHash', () => {
  it('is null for a legacy pair (letters, digits, hyphens, underscores), so deployed names are kept', () => {
    expect(pipelineIdentityHash('spring-boot', 'acme')).toBeNull();
    expect(pipelineIdentityHash('Api2', 'Acme-Corp')).toBeNull();
    // Regression: underscore names deployed before the hash existed — hashing
    // them renamed live pipelines and stacks.
    expect(pipelineIdentityHash('spring_boot', 'acme')).toBeNull();
    expect(pipelineIdentityHash('my_app', 'acme_corp')).toBeNull();
  });

  it('is a stable 8-hex hash for a pair outside the legacy set, distinct per raw input', () => {
    const a = pipelineIdentityHash('spring.boot', 'acme');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(pipelineIdentityHash('spring.boot', 'acme')).toBe(a);
    expect(pipelineIdentityHash('Spring.Boot', 'ACME')).toBe(a);
    expect(pipelineIdentityHash('spring@boot', 'acme')).not.toBe(a);
  });

  it('separates project from organization unambiguously', () => {
    expect(pipelineIdentityHash('a.b', 'c')).not.toBe(pipelineIdentityHash('a', 'b.c'));
    expect(pipelineIdentityHash('a:b', 'c')).not.toBe(pipelineIdentityHash('a', 'b:c'));
  });
});

describe('defaultPipelineName', () => {
  it('keeps <org>-<project>-pipeline for a clean pair', () => {
    expect(defaultPipelineName('my-org', 'my-project')).toBe('my_org-my_project-pipeline');
  });

  it('keeps the legacy name for an underscore pair', () => {
    expect(defaultPipelineName('acme', 'spring_boot')).toBe('acme-spring_boot-pipeline');
  });

  it('appends the hash for a pair outside the legacy set', () => {
    expect(defaultPipelineName('acme', 'my.app'))
      .toBe(`acme-my_app-pipeline-${pipelineIdentityHash('my.app', 'acme')}`);
    expect(defaultPipelineName('acme', 'my.app')).not.toBe(defaultPipelineName('acme', 'my_app'));
  });
});
