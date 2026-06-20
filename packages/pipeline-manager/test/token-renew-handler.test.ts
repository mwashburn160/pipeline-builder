// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockExecFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockSend = jest.fn<() => Promise<{ SecretString?: string }>>();

jest.unstable_mockModule('node:child_process', () => ({
  __esModule: true,
  execFileSync: mockExecFileSync,
  default: { execFileSync: mockExecFileSync },
}));
jest.unstable_mockModule('node:fs', () => ({
  __esModule: true,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  default: { writeFileSync: mockWriteFileSync, mkdirSync: mockMkdirSync },
}));
jest.unstable_mockModule('@aws-sdk/client-secrets-manager', () => ({
  __esModule: true,
  SecretsManagerClient: class { send = mockSend; },
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
}));

const { handler } = await import('../src/lambda/token-renew-handler.js');

const ENV = {
  PLATFORM_SECRET_NAME: 'pipeline-builder/acme/platform',
  PLATFORM_BASE_URL: 'https://pipeline-builder.com',
  RENEW_DAYS: '30',
  PIPELINE_MANAGER_VERSION: '1.2.3',
  AWS_REGION: 'us-east-1',
};

describe('token-renew-handler (orchestrator)', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = process.env;
    process.env = { ...saved, ...ENV };
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ password: 'current.jwt.token' }) });
  });
  afterEach(() => { process.env = saved; });

  it('writes the scoped registry to /tmp/.npmrc', async () => {
    await handler();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/.npmrc',
      '@pipeline-builder:registry=https://registry.npmjs.org/\n',
    );
  });

  it('npm-installs the pinned pipeline-manager into /tmp', async () => {
    await handler();
    const npmCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'npm');
    expect(npmCall).toBeDefined();
    const args = npmCall![1] as string[];
    expect(args).toEqual(expect.arrayContaining(['install', '--prefix', '/tmp/pm', '--userconfig', '/tmp/.npmrc']));
    expect(args).toContain('@pipeline-builder/pipeline-manager@1.2.3');
  });

  it('runs store-token (no --schedule, so it never redeploys the stack) with the current JWT as PLATFORM_TOKEN', async () => {
    await handler();
    const nodeCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'node');
    expect(nodeCall).toBeDefined();
    const [, args, opts] = nodeCall as [string, string[], { env: Record<string, string> }];
    expect(args[0]).toBe('/tmp/pm/node_modules/@pipeline-builder/pipeline-manager/dist/cli.js');
    expect(args).toEqual(expect.arrayContaining([
      'store-token',
      '--secret-name', 'pipeline-builder/acme/platform',
      '--region', 'us-east-1',
      '--days', '30',
    ]));
    // Must NOT opt into the renewal stack (would recurse into its own deploy).
    expect(args).not.toContain('--schedule');
    expect(opts.env.PLATFORM_TOKEN).toBe('current.jwt.token');
    expect(opts.env.PLATFORM_BASE_URL).toBe('https://pipeline-builder.com');
  });

  it('passes --no-verify-ssl only when PLATFORM_VERIFY_SSL=false', async () => {
    await handler();
    let args = (mockExecFileSync.mock.calls.find((c) => c[0] === 'node')![1]) as string[];
    expect(args).not.toContain('--no-verify-ssl');

    jest.clearAllMocks();
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ password: 'current.jwt.token' }) });
    process.env.PLATFORM_VERIFY_SSL = 'false';
    await handler();
    args = (mockExecFileSync.mock.calls.find((c) => c[0] === 'node')![1]) as string[];
    expect(args).toContain('--no-verify-ssl');
  });

  it('throws when the secret has no password (JWT)', async () => {
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ username: 'acme' }) });
    await expect(handler()).rejects.toThrow(/missing password/);
  });

  it('throws when a required env var is missing', async () => {
    delete process.env.PLATFORM_SECRET_NAME;
    await expect(handler()).rejects.toThrow(/PLATFORM_SECRET_NAME/);
  });
});
