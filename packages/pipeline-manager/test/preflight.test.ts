// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { Command } from 'commander';

// Mock the tool checks so the preflight's behavior is testable without a real
// cdk on PATH.
const mockEnsureCdk = jest.fn();
jest.unstable_mockModule('../src/utils/cdk-utils.js', () => ({
  ensureCdkAvailable: mockEnsureCdk,
}));

const { commandPath, requiredToolsFor, preflightCommandTools } = await import('../src/utils/preflight.js');

/** Build a program → group → leaf command tree and return the leaf. */
function leaf(group: string, name: string): Command {
  const program = new Command('pipeline-manager');
  const parent = program.command(group);
  return parent.command(name);
}

describe('commandPath', () => {
  it('joins the full path for a nested command', () => {
    expect(commandPath(leaf('pipeline', 'deploy'))).toBe('pipeline deploy');
  });

  it('returns just the name for a top-level command', () => {
    const program = new Command('pipeline-manager');
    const status = program.command('status');
    expect(commandPath(status)).toBe('status');
  });
});

describe('requiredToolsFor', () => {
  it('returns cdk for pipeline deploy/synth and infra bootstrap (the Lambda ships prebuilt: no bundler)', () => {
    expect(requiredToolsFor(leaf('pipeline', 'deploy'))).toEqual(['cdk']);
    expect(requiredToolsFor(leaf('pipeline', 'synth'))).toEqual(['cdk']);
    expect(requiredToolsFor(leaf('infra', 'bootstrap'))).toEqual(['cdk']);
  });

  it('returns nothing for API-only commands (never gated)', () => {
    expect(requiredToolsFor(leaf('plugin', 'list'))).toEqual([]);
    expect(requiredToolsFor(leaf('auth', 'login'))).toEqual([]);
    expect(requiredToolsFor(leaf('pipeline', 'create'))).toEqual([]);
    expect(requiredToolsFor(leaf('infra', 'provision'))).toEqual([]);
  });
});

describe('preflightCommandTools', () => {
  let exitSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    mockEnsureCdk.mockReset();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => { exitSpy.mockRestore(); });

  it('checks cdk for a gated command', () => {
    preflightCommandTools(leaf('pipeline', 'deploy'));
    expect(mockEnsureCdk).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('is a no-op (no checks, no exit) for an ungated command', () => {
    preflightCommandTools(leaf('plugin', 'list'));
    expect(mockEnsureCdk).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits non-zero when a required tool is missing', () => {
    mockEnsureCdk.mockImplementation(() => { throw new Error('AWS CDK not found'); });
    preflightCommandTools(leaf('pipeline', 'deploy'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
