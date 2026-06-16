// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { COMMON_SPARSE_PATHS, sparsePathsFor } from '../src/agent/targets.js';

describe('sparsePathsFor', () => {
  it('common base is just deploy/bin', () => {
    expect(COMMON_SPARSE_PATHS).toEqual(['deploy/bin']);
  });

  it('register-only local = common base + target folder', () => {
    expect(sparsePathsFor('local', [])).toEqual(['deploy/bin', 'deploy/local/docker']);
  });

  it('minikube is self-contained — no deploy/local/docker', () => {
    const paths = sparsePathsFor('minikube', []);
    expect(paths).toEqual(['deploy/bin', 'deploy/local/minikube']);
    expect(paths).not.toContain('deploy/local/docker');
  });

  it('adds the folders of enabled load steps (plugins pulls codebuild too)', () => {
    const paths = sparsePathsFor('local', ['plugins', 'samples']);
    expect(paths).toContain('deploy/plugins');
    expect(paths).toContain('deploy/codebuild');
    expect(paths).toContain('deploy/samples');
    expect(paths).not.toContain('deploy/compliance');
  });

  it('de-duplicates and keeps a stable order', () => {
    const paths = sparsePathsFor('ec2', ['plugins', 'compliance', 'samples']);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths[0]).toBe('deploy/bin');
    expect(paths).toContain('deploy/aws/ec2');
  });
});
