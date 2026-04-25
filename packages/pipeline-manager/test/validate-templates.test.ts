// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI tests for `validate-templates`. Exercises the `--file` mode end-to-end
 * and the `--pipeline` / `--plugin` modes against a mocked client.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// Silence command header / pretty output
jest.mock('../src/utils/output-utils', () => ({
  printCommandHeader: () => 'EXEC-TEST',
  printSslWarning: jest.fn(),
  printSuccess: jest.fn(),
  printWarning: jest.fn(),
  printInfo: jest.fn(),
  printError: jest.fn(),
  printKeyValue: jest.fn(),
  printSection: jest.fn(),
  printDebug: jest.fn(),
}));

jest.mock('../src/utils/command-utils', () => ({
  printCommandHeader: () => 'EXEC-TEST',
  printSslWarning: jest.fn(),
  createAuthenticatedClientAsync: jest.fn(),
}));

jest.mock('../src/utils/error-handler', () => ({
  ERROR_CODES: { API_REQUEST: 3 },
  handleError: jest.fn((err) => { throw err; }),
}));

import { Command } from 'commander';
import { validateTemplatesCommand } from '../src/commands/validate-templates';
import { createAuthenticatedClientAsync } from '../src/utils/command-utils';

let exitSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__EXIT_${code ?? 0}__`);
  }) as never);
});

afterEach(() => exitSpy.mockRestore());

function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  validateTemplatesCommand(program);
  return program.parseAsync(['node', 'test', 'validate-templates', ...args]) as unknown as Promise<void>;
}

describe('validate-templates CLI', () => {
  const tmpFile = (contents: string, ext = '.yaml') => {
    const p = path.join(os.tmpdir(), `pb-tpl-${Date.now()}-${Math.random()}${ext}`);
    fs.writeFileSync(p, contents);
    return p;
  };

  it('--file on a valid plugin spec exits 0', async () => {
    const file = tmpFile(
      'name: test-plugin\nversion: 1.0.0\npluginType: CodeBuildStep\ncommands:\n  - "echo {{ pipeline.metadata.env }}"\n',
    );
    // Should not throw (no process.exit(1))
    await expect(runCli(['--file', file])).resolves.toBeDefined();
    fs.unlinkSync(file);
  });

  it('--file on a spec with an unknown scope path exits 1', async () => {
    const file = tmpFile(
      'name: bad-plugin\nversion: 1.0.0\npluginType: CodeBuildStep\ncommands:\n  - "echo {{ foo.bar }}"\n',
    );
    await expect(runCli(['--file', file])).rejects.toThrow(/__EXIT_1__/);
    fs.unlinkSync(file);
  });

  it('--plugin fetches and validates a remote plugin', async () => {
    const getMock = jest.fn().mockResolvedValue({
      plugin: {
        name: 'remote',
        pluginType: 'CodeBuildStep',
        commands: ['echo {{ pipeline.metadata.env }}'],
      },
    });
    (createAuthenticatedClientAsync as jest.Mock).mockResolvedValue({
      getConfig: () => ({ api: { pluginUrl: 'https://p.example.com/api/plugin' } }),
      get: getMock,
    });
    await expect(runCli(['--plugin', 'remote:1.0.0'])).resolves.toBeDefined();
    expect(getMock).toHaveBeenCalledWith(expect.stringContaining('name=remote'));
    expect(getMock).toHaveBeenCalledWith(expect.stringContaining('version=1.0.0'));
  });
});
