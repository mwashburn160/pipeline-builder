// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An auto-created placeholder plugin has no real build logic, so running it
 * must FAIL the build (non-zero exit, clear message on stderr). It previously
 * `echo`ed and exited 0 — every pipeline step using a placeholder went green
 * while doing nothing (a false-positive build).
 *
 * No mocks: the REAL placeholder request is built and its `commands` are
 * executed by a real shell, the way a CodeBuild step would run them.
 */

import { spawnSync } from 'node:child_process';
import { describe, it, expect } from '@jest/globals';
import { buildPlaceholderPluginRequest, extractPluginNames } from '../src/services/auto-plugin-service.js';

function runCommands(commands: string[]) {
  // CodeBuild runs each command in turn and fails the phase on the first
  // non-zero exit; `set -e` over the joined script mirrors that.
  return spawnSync('sh', ['-c', ['set -e', ...commands].join('\n')], { encoding: 'utf8' });
}

describe('auto-created placeholder plugin', () => {
  it('fails non-zero with a clear "implement it" message on stderr', () => {
    const request = buildPlaceholderPluginRequest('my-plugin');
    const result = runCommands(request.commands as string[]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('plugin my-plugin is a placeholder — implement it');
  });

  it('is still created private with the standard CodeBuild step shape', () => {
    expect(buildPlaceholderPluginRequest('my-plugin')).toEqual(expect.objectContaining({
      name: 'my-plugin',
      pluginType: 'CodeBuildStep',
      visibility: 'private',
      installCommands: [],
    }));
  });
});

describe('extractPluginNames', () => {
  it('collects unique stage plugin names from both AI output shapes, ignoring synth', () => {
    expect(extractPluginNames({
      synth: { plugin: { name: 'synth-tool' } },
      stages: [
        { steps: [{ plugin: { name: 'a' } }, { plugin: { name: 'b' } }] },
        { actions: [{ pluginName: 'b' }, { pluginName: 'c' }] },
      ],
    })).toEqual(['a', 'b', 'c']);
    expect(extractPluginNames({ synth: { plugin: { name: 'synth-tool' } } })).toEqual([]);
  });
});
