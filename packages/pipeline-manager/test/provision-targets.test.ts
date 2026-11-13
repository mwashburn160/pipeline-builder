// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { COMMON_SPARSE_PATHS, TOOLCHAIN_SPARSE_PATHS, sparsePathsFor } from '../src/agent/targets.js';

const TOOLCHAIN = ['deploy/plugins/_base', 'deploy/toolchain'];

describe('sparsePathsFor', () => {
  it('common base is just deploy/bin', () => {
    expect(COMMON_SPARSE_PATHS).toEqual(['deploy/bin']);
  });

  it('the toolchain build inputs are the toolchain root (bootstrap + cdk-synth) and the _base images', () => {
    expect(TOOLCHAIN_SPARSE_PATHS).toEqual(TOOLCHAIN);
  });

  it('register-only local = common base + target folder + the toolchain build inputs', () => {
    // init-platform.sh always runs build-plugin-images.sh --only pipeline-bootstrap,cdk-synth,
    // and --build-bootstrap runs --only pipeline-bootstrap: both read these folders.
    expect(sparsePathsFor('docker', [])).toEqual(['deploy/bin', 'deploy/local/docker', ...TOOLCHAIN]);
  });

  it('minikube is self-contained — no deploy/local/docker', () => {
    const paths = sparsePathsFor('minikube', []);
    expect(paths).toEqual(['deploy/bin', 'deploy/local/minikube', ...TOOLCHAIN]);
    expect(paths).not.toContain('deploy/local/docker');
  });

  it('adds exactly the folders of enabled load steps', () => {
    const paths = sparsePathsFor('docker', ['plugins', 'samples']);
    expect(paths).toEqual(['deploy/bin', 'deploy/local/docker', ...TOOLCHAIN, 'deploy/plugins', 'deploy/samples']);
    expect(paths).not.toContain('deploy/compliance');
  });

  it('de-duplicates and keeps a stable order', () => {
    const paths = sparsePathsFor('ec2', ['plugins', 'compliance', 'samples']);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths[0]).toBe('deploy/bin');
    expect(paths).toContain('deploy/aws/ec2');
  });
});
