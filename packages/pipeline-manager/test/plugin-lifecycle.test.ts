// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI tests for `plugin deprecate` and `plugin yank`:
 * the request each sends, local validation of the message / reason, and the
 * output — all against a mocked client.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockCreateAuthenticatedClient = jest.fn();
const mockOutputData = jest.fn();
const mockPrintKeyValue = jest.fn();
const mockPrintSuccess = jest.fn();

jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  __esModule: true,
  printSuccess: mockPrintSuccess,
  printWarning: jest.fn(),
  printInfo: jest.fn(),
  printError: jest.fn(),
  printKeyValue: mockPrintKeyValue,
  printSection: jest.fn(),
  printDebug: jest.fn(),
  outputData: mockOutputData,
}));

jest.unstable_mockModule('../src/utils/command-utils.js', () => ({
  __esModule: true,
  printCommandHeader: () => 'EXEC-TEST',
  printExecutionSummary: jest.fn(),
  printSslWarning: jest.fn(),
  createAuthenticatedClient: mockCreateAuthenticatedClient,
  validateEntityId: (id: string) => {
    if (!id?.trim()) throw new Error('Plugin ID must be a non-empty string');
    return id.trim();
  },
  withSslOptions: (cmd: unknown) => cmd,
}));

const { Command } = await import('commander');
const { deprecatePlugin, yankPlugin, LIFECYCLE_TEXT_MAX } = await import('../src/commands/plugin-lifecycle.js');

const PLUGINS_URL = '/api/plugins';
const ID = '11111111-1111-4111-8111-111111111111';
const PLUGIN = { id: ID, name: 'scan', version: '1.2.0', organization: 'acme' };

function mockClient(data: unknown) {
  const post = jest.fn<(url: string, body?: unknown) => Promise<unknown>>().mockResolvedValue({ success: true, data });
  mockCreateAuthenticatedClient.mockReturnValue({
    getConfig: () => ({ api: { pluginUrl: PLUGINS_URL } }),
    post,
  });
  return { post };
}

let exitSpy: ReturnType<typeof jest.spyOn>;
let logSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.clearAllMocks();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__EXIT_${code ?? 0}__`);
  }) as never);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  jest.restoreAllMocks();
});

function runCli(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  // Mirror production wiring: both leaves under the `plugin` namespace.
  const plugin = program.command('plugin');
  deprecatePlugin(plugin);
  yankPlugin(plugin);
  return program.parseAsync(['node', 'test', 'plugin', ...args]);
}

describe('plugin deprecate', () => {
  it('posts deprecated:true with the trimmed message to the plural plugins route', async () => {
    const { post } = mockClient({ plugin: { ...PLUGIN, deprecatedAt: '2026-09-21T00:00:00Z', deprecationMessage: 'Use 2.x' } });

    await runCli(['deprecate', '--id', ID, '--message', '  Use 2.x ']);

    expect(post).toHaveBeenCalledWith(`${PLUGINS_URL}/${ID}/deprecate`, { deprecated: true, message: 'Use 2.x' });
    expect(mockPrintKeyValue).toHaveBeenCalledWith(expect.objectContaining({ Message: 'Use 2.x' }));
    expect(mockOutputData).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), expect.objectContaining({ format: 'json' }));
  });

  it('omits the message when none is given', async () => {
    const { post } = mockClient({ plugin: { ...PLUGIN, deprecatedAt: '2026-09-21T00:00:00Z' } });
    await runCli(['deprecate', '--id', ID]);
    expect(post).toHaveBeenCalledWith(`${PLUGINS_URL}/${ID}/deprecate`, { deprecated: true });
  });

  it('--undo clears the deprecation', async () => {
    const { post } = mockClient({ plugin: { ...PLUGIN, deprecatedAt: null } });
    await runCli(['deprecate', '--id', ID, '--undo']);
    expect(post).toHaveBeenCalledWith(`${PLUGINS_URL}/${ID}/deprecate`, { deprecated: false });
    expect(mockPrintKeyValue).toHaveBeenCalledWith(expect.objectContaining({ Deprecated: 'no' }));
  });

  it('refuses --message with --undo, and an over-long message, without calling the API', async () => {
    const { post } = mockClient({ plugin: PLUGIN });
    await expect(runCli(['deprecate', '--id', ID, '--undo', '--message', 'x'])).rejects.toThrow(/__EXIT_/);
    await expect(runCli(['deprecate', '--id', ID, '--message', 'x'.repeat(LIFECYCLE_TEXT_MAX + 1)])).rejects.toThrow(/__EXIT_/);
    expect(post).not.toHaveBeenCalled();
  });

  it('fails when the API returns no plugin', async () => {
    mockClient({});
    await expect(runCli(['deprecate', '--id', ID])).rejects.toThrow(/__EXIT_/);
  });

  it('writes the updated plugin to --output', async () => {
    mockClient({ plugin: PLUGIN });
    await runCli(['deprecate', '--id', ID, '--output', 'out.json', '--format', 'yaml']);
    expect(mockOutputData).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ format: 'yaml', file: 'out.json' }));
    expect(mockPrintSuccess).toHaveBeenCalledWith('Plugin data saved', { path: 'out.json' });
  });
});

describe('plugin yank', () => {
  it('posts the reason and reports the promoted default', async () => {
    const { post } = mockClient({
      plugin: { ...PLUGIN, yankedAt: '2026-09-21T00:00:00Z', yankReason: 'leaks tokens' },
      promotedDefault: { id: 'p0', version: '1.1.0' },
    });

    await runCli(['yank', '--id', ID, '--reason', 'leaks tokens']);

    expect(post).toHaveBeenCalledWith(`${PLUGINS_URL}/${ID}/yank`, { reason: 'leaks tokens' });
    expect(mockPrintKeyValue).toHaveBeenCalledWith(expect.objectContaining({ 'Reason': 'leaks tokens', 'New default': 'scan@1.1.0' }));
  });

  it('does not mention a new default when none was promoted', async () => {
    mockClient({ plugin: { ...PLUGIN, yankedAt: '2026-09-21T00:00:00Z' } });
    await runCli(['yank', '--id', ID, '--reason', 'bad']);
    expect(mockPrintKeyValue.mock.calls[0]![0]).not.toHaveProperty('New default');
  });

  it('requires a non-blank reason', async () => {
    const { post } = mockClient({ plugin: PLUGIN });
    await expect(runCli(['yank', '--id', ID])).rejects.toThrow();
    await expect(runCli(['yank', '--id', ID, '--reason', '   '])).rejects.toThrow(/__EXIT_/);
    expect(post).not.toHaveBeenCalled();
  });

  it('surfaces an API refusal (e.g. 409 for a version published to the ecosystem) as a failure', async () => {
    const { post } = mockClient({ plugin: PLUGIN });
    post.mockRejectedValue(new Error('Request failed with status code 409'));
    await expect(runCli(['yank', '--id', ID, '--reason', 'bad'])).rejects.toThrow(/__EXIT_/);
  });
});
