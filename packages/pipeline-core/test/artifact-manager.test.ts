// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { ShellStep } from 'aws-cdk-lib/pipelines';
import { ArtifactManager, type ArtifactKey } from '../src/core/artifact-manager.js';

const KEY: ArtifactKey = {
  stageName: 'build',
  stageAlias: 'build-alias',
  pluginName: 'nodejs-build',
  pluginAlias: 'nodejs-build-alias',
  outputDirectory: 'dist',
};

describe('ArtifactManager.add', () => {
  it('registers a step under its key', () => {
    const mgr = new ArtifactManager();
    const step = new ShellStep('a', { commands: ['true'] });
    mgr.add(KEY, step);
    expect(mgr.get(KEY)).toBe(step);
  });

  it('refuses a DIFFERENT step for an already-registered key, naming the stage and steps', () => {
    const mgr = new ArtifactManager();
    mgr.add(KEY, new ShellStep('first', { commands: ['true'] }));
    expect(() => mgr.add(KEY, new ShellStep('second', { commands: ['true'] })))
      .toThrow(/Duplicate artifact key "build:build-alias:nodejs-build:nodejs-build-alias:dist": stage "build".*"first".*"second"/);
  });

  it('allows re-registering the SAME step (idempotent)', () => {
    const mgr = new ArtifactManager();
    const step = new ShellStep('a', { commands: ['true'] });
    mgr.add(KEY, step);
    expect(() => mgr.add(KEY, step)).not.toThrow();
    expect(mgr.get(KEY)).toBe(step);
  });
});
