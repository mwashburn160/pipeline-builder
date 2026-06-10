// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0


/**
 * CLI tests for `validate-templates`. Exercises the `--file` mode end-to-end
 * and the `--pipeline` / `--plugin` modes against a mocked client.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockCreateAuthenticatedClientAsync = jest.fn();

// Silence command header / pretty output
jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  __esModule: true,
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

jest.unstable_mockModule('../src/utils/command-utils.js', () => ({
  __esModule: true,
  printCommandHeader: () => 'EXEC-TEST',
  printSslWarning: jest.fn(),
  createAuthenticatedClientAsync: mockCreateAuthenticatedClientAsync,
}));

jest.unstable_mockModule('../src/utils/error-handler.js', () => ({
  __esModule: true,
  ERROR_CODES: { API_REQUEST: 3 },
  handleError: jest.fn((err) => { throw err; }),
}));

const { Command } = await import('commander');
const { validateTemplatesCommand } = await import('../src/commands/validate-templates.js');

let exitSpy: ReturnType<typeof jest.spyOn>;

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
    mockCreateAuthenticatedClientAsync.mockResolvedValue({
      getConfig: () => ({ api: { pluginUrl: 'https://p.example.com/api/plugin' } }),
      get: getMock,
    });
    await expect(runCli(['--plugin', 'remote:1.0.0'])).resolves.toBeDefined();
    expect(getMock).toHaveBeenCalledWith(expect.stringContaining('name=remote'));
    expect(getMock).toHaveBeenCalledWith(expect.stringContaining('version=1.0.0'));
  });
});
