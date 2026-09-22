// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI tests for `plugin upload`: the flags it accepts, the multipart fields it
 * sends (only the ones `POST /plugins/upload` reads: the `plugin` file and
 * `visibility`) and how it reads the route's 201/202 payload.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockCreateAuthenticatedClient = jest.fn();
const mockPrintKeyValue = jest.fn();
const mockPrintSection = jest.fn();

jest.unstable_mockModule('../src/utils/output-utils.js', () => ({
  __esModule: true,
  printSuccess: jest.fn(),
  printWarning: jest.fn(),
  printInfo: jest.fn(),
  printError: jest.fn(),
  printKeyValue: mockPrintKeyValue,
  printSection: mockPrintSection,
  printDebug: jest.fn(),
  fileExists: (p: string) => fs.existsSync(p),
}));

jest.unstable_mockModule('../src/utils/command-utils.js', () => ({
  __esModule: true,
  printCommandHeader: () => 'EXEC-TEST',
  printSslWarning: jest.fn(),
  createAuthenticatedClient: mockCreateAuthenticatedClient,
  withSslOptions: (cmd: unknown) => cmd,
}));

jest.unstable_mockModule('ora', () => ({
  __esModule: true,
  default: () => ({ start: () => ({ succeed: jest.fn(), fail: jest.fn() }) }),
}));

const { Command } = await import('commander');
const { uploadPlugin } = await import('../src/commands/upload-plugin.js');

const UPLOAD_URL = '/api/plugins/upload';

/** Multipart field names in a form-data instance (from its part headers). */
function fieldNames(form: unknown): string[] {
  const streams = (form as { _streams: unknown[] })._streams;
  return streams
    .filter((s): s is string => typeof s === 'string')
    .map((s) => /name="([^"]+)"/.exec(s)?.[1])
    .filter((n): n is string => Boolean(n));
}

function fieldValue(form: unknown, name: string): unknown {
  const streams = (form as { _streams: unknown[] })._streams;
  const i = streams.findIndex((s) => typeof s === 'string' && s.includes(`name="${name}"`));
  return i < 0 ? undefined : streams[i + 1];
}

function mockClient(data: unknown) {
  const postForm = jest.fn<(url: string, form: unknown) => Promise<unknown>>().mockResolvedValue({ success: true, statusCode: 202, data });
  mockCreateAuthenticatedClient.mockReturnValue({
    getConfig: () => ({ api: { baseUrl: 'https://pb.test', pluginUploadUrl: UPLOAD_URL } }),
    postForm,
  });
  return { postForm };
}

let tmp: string;
let zip: string;
let exitSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-upload-'));
  zip = path.join(tmp, 'plugin.zip');
  fs.writeFileSync(zip, 'PK\u0003\u0004');
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__EXIT_${code ?? 0}__`);
  }) as never);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  exitSpy.mockRestore();
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  const plugin = program.command('plugin').exitOverride();
  uploadPlugin(plugin);
  plugin.commands.forEach((c) => c.exitOverride().configureOutput({ writeErr: () => undefined }));
  return program.parseAsync(['node', 'test', 'plugin', 'upload', ...args]);
}

describe('plugin upload', () => {
  it('sends only the file by default (org visibility, name/version from the spec, org from the session)', async () => {
    const { postForm } = mockClient({ requestId: 'req-1', pluginName: 'scan', version: '1.2.0' });

    await runCli(['--file', zip]);

    expect(postForm).toHaveBeenCalledTimes(1);
    const [url, form] = postForm.mock.calls[0]!;
    expect(url).toBe(UPLOAD_URL);
    expect(fieldNames(form)).toEqual(['plugin']);
    expect(mockPrintSection).toHaveBeenCalledWith('Plugin Build Queued');
    expect(mockPrintKeyValue).toHaveBeenCalledWith(expect.objectContaining({ 'Request ID': 'req-1', 'Visibility': 'org' }));
  });

  it('--public sends visibility=public', async () => {
    const { postForm } = mockClient({ requestId: 'req-2', pluginName: 'scan', version: '1.2.0' });
    await runCli(['--file', zip, '--public']);
    const form = postForm.mock.calls[0]![1];
    expect(fieldNames(form)).toEqual(['plugin', 'visibility']);
    expect(fieldValue(form, 'visibility')).toBe('public');
  });

  it('reports a metadata-only plugin as deployed with its id (201)', async () => {
    mockClient({ requestId: 'req-3', pluginId: 'p-1', pluginName: 'meta', version: '0.1.0', buildType: 'metadata_only' });
    await runCli(['--file', zip]);
    expect(mockPrintSection).toHaveBeenCalledWith('Plugin Deployed');
    expect(mockPrintKeyValue).toHaveBeenCalledWith(expect.objectContaining({ 'Plugin ID': 'p-1' }));
  });

  it.each([
    ['--organization', 'acme'],
    ['--name', 'x'],
    ['--version', '1.0.0'],
    ['--active'],
    ['--no-active'],
  ])('rejects the removed flag %s', async (...flag) => {
    const { postForm } = mockClient({});
    await expect(runCli(['--file', zip, ...flag])).rejects.toThrow(/unknown option/);
    expect(postForm).not.toHaveBeenCalled();
  });

  it('--dry-run validates the file without uploading', async () => {
    const { postForm } = mockClient({});
    await runCli(['--file', zip, '--dry-run']);
    expect(postForm).not.toHaveBeenCalled();
  });

  it('refuses a non-zip file', async () => {
    const other = path.join(tmp, 'plugin.tar');
    fs.writeFileSync(other, 'x');
    const { postForm } = mockClient({});
    await expect(runCli(['--file', other])).rejects.toThrow(/__EXIT_/);
    expect(postForm).not.toHaveBeenCalled();
  });

  it('fails when the response carries no upload result', async () => {
    mockClient({});
    await expect(runCli(['--file', zip])).rejects.toThrow(/__EXIT_/);
  });
});
