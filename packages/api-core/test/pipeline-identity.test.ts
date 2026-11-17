// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from '@jest/globals';
import { defaultPipelineName, pipelineIdentityHash } from '../src/utils/pipeline-identity.js';

describe('pipelineIdentityHash', () => {
  it('is null for a clean pair (letters, digits, hyphens), so existing names are kept', () => {
    expect(pipelineIdentityHash('spring-boot', 'acme')).toBeNull();
    expect(pipelineIdentityHash('Api2', 'Acme-Corp')).toBeNull();
  });

  it('is a stable 8-hex hash for a lossy pair, distinct per raw input', () => {
    const a = pipelineIdentityHash('spring_boot', 'acme');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(pipelineIdentityHash('spring_boot', 'acme')).toBe(a);
    expect(pipelineIdentityHash('Spring_Boot', 'ACME')).toBe(a);
    expect(pipelineIdentityHash('spring.boot', 'acme')).not.toBe(a);
  });

  it('separates project from organization unambiguously', () => {
    expect(pipelineIdentityHash('a_b', 'c')).not.toBe(pipelineIdentityHash('a', 'b_c'));
    expect(pipelineIdentityHash('a:b', 'c')).not.toBe(pipelineIdentityHash('a', 'b:c'));
  });
});

describe('defaultPipelineName', () => {
  it('keeps <org>-<project>-pipeline for a clean pair', () => {
    expect(defaultPipelineName('my-org', 'my-project')).toBe('my_org-my_project-pipeline');
  });

  it('appends the hash for a lossy pair', () => {
    expect(defaultPipelineName('acme', 'spring_boot'))
      .toBe(`acme-spring_boot-pipeline-${pipelineIdentityHash('spring_boot', 'acme')}`);
  });
});
