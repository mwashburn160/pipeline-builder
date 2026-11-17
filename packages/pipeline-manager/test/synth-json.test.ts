// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline synth --json` must print ONE JSON document on stdout: progress lines
 * and CDK's own output (captured instead of inherited) stay off it, so
 * `pipeline synth --json | jq` works.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Command } from 'commander';

const mockExecute = jest.fn<(command: string, opts: { showOutput?: boolean }) => { duration: number }>(() => ({ duration: 7 }));

jest.unstable_mockModule('../src/utils/cdk-utils.js', () => ({
  executeCdkShellCommand: mockExecute,
  resolveBoilerplatePath: () => '/tmp/boilerplate.js',
}));
jest.unstable_mockModule('../src/utils/pipeline-config.js', () => ({
  fetchPipelineProps: jest.fn(async () => ({
    pipeline: { id: 'pl-1', orgId: 'org-1', project: 'api', organization: 'acme' },
    propsWithIds: { project: 'api', organization: 'acme' },
    baseUrl: undefined,
    pluginWarnings: [],
  })),
  printResolvedOrExit: jest.fn(),
}));

const { synth } = await import('../src/commands/synth.js');

let stdout: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  stdout = [];
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout.push(args.map(String).join(' ')); });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.PLATFORM_TOKEN = 'pb_pat_test';
  delete process.env.CODEBUILD_BUILD_ID;
});

afterEach(() => {
  process.env = { ...savedEnv };
  jest.restoreAllMocks();
});

describe('pipeline synth --json', () => {
  it('writes only the result document to stdout and captures CDK output', async () => {
    const program = new Command();
    program.exitOverride();
    synth(program);

    await program.parseAsync(['synth', '--id', 'pl-1', '--json'], { from: 'user' });

    const out = JSON.parse(stdout.join('\n')) as { success: boolean; duration: number; output: string };
    expect(out).toMatchObject({ success: true, duration: 7, output: 'cdk.out' });
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('cdk synth'), expect.objectContaining({ showOutput: false }));
  });

  it('still inherits CDK output without --json', async () => {
    const program = new Command();
    program.exitOverride();
    synth(program);

    await program.parseAsync(['synth', '--id', 'pl-1'], { from: 'user' });

    expect(mockExecute).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ showOutput: true }));
    expect(stdout.join('\n')).toContain('Synthesis Complete');
  });
});
