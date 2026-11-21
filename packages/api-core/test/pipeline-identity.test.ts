// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from '@jest/globals';
import { defaultPipelineName, pipelineIdentityHash } from '../src/utils/pipeline-identity.js';

describe('pipelineIdentityHash', () => {
  it('is null for a clean pair (letters, digits, hyphens; case-insensitive)', () => {
    expect(pipelineIdentityHash('spring-boot', 'acme')).toBeNull();
    expect(pipelineIdentityHash('Api2', 'Acme-Corp')).toBeNull();
  });

  it('hashes an underscore pair: `_` and `-` derive the same names, so the hash keeps them apart', () => {
    expect(pipelineIdentityHash('spring_boot', 'acme')).toMatch(/^[0-9a-f]{8}$/);
    expect(pipelineIdentityHash('my_app', 'acme_corp')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is a stable 8-hex hash for a pair outside the clean set, distinct per raw input', () => {
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

  it('appends the hash for an underscore pair, so it never shares a name with the hyphen pair', () => {
    expect(defaultPipelineName('acme', 'spring_boot')).toBe(`acme-spring_boot-pipeline-${pipelineIdentityHash('spring_boot', 'acme')}`);
    expect(defaultPipelineName('acme', 'spring_boot')).not.toBe(defaultPipelineName('acme', 'spring-boot'));
  });

  it('appends the hash for a pair outside the clean set', () => {
    expect(defaultPipelineName('acme', 'my.app'))
      .toBe(`acme-my_app-pipeline-${pipelineIdentityHash('my.app', 'acme')}`);
    expect(defaultPipelineName('acme', 'my.app')).not.toBe(defaultPipelineName('acme', 'my_app'));
  });
});
