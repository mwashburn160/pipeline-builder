// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `version` and `status` meta commands: every output mode (plain,
 * --verbose, --check-config, --json), CDK present/absent, configuration
 * valid/invalid, and the status probe against a live /health endpoint plus the
 * token-expiry read (JWT, opaque access key, undecodable).
 */

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

process.env.HOME = mkdtempSync(join(tmpdir(), 'pm-version-'));
process.env.CLI_CONFIG_PATH = join(process.env.HOME, 'none.yml');

const getCdkInfo = jest.fn<AnyFn>(() => ({ available: true, version: '2.200.0' }));
const checkCdkAvailable = jest.fn<AnyFn>(() => true);
jest.unstable_mockModule('../src/utils/cdk-utils.js', () => ({ getCdkInfo, checkCdkAvailable }));

const { Command } = await import('commander');
const { version } = await import('../src/commands/version.js');
const { status } = await import('../src/commands/status.js');

let server: Server;
let healthy = true;
let base = '';
beforeAll(async () => {
  server = createServer((_req, res) => { res.statusCode = healthy ? 200 : 503; res.end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const logged: string[] = [];
const text = () => logged.join('\n');
beforeEach(() => {
  logged.length = 0;
  healthy = true;
  process.env.PLATFORM_TOKEN = 'tok';
  process.env.PLATFORM_BASE_URL = base;
  getCdkInfo.mockReturnValue({ available: true, version: '2.200.0' });
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`__EXIT_${c}__`); }) as never);
});

async function run(register: (p: InstanceType<typeof Command>) => void, args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  register(program);
  await program.parseAsync(['node', 'pm', ...args]);
}

describe('version', () => {
  it('plain: version + CDK, with the verbose/config tips', async () => {
    await run(version, ['version']);
    expect(text()).toContain('CDK Version');
    expect(text()).toContain('Run with --verbose');
    expect(text()).toContain('--check-config');
  });

  it('--verbose --check-config: system info, config valid, env vars', async () => {
    delete process.env.CLI_CONFIG_PATH;
    await run(version, ['version', '--verbose', '--check-config']);
    process.env.CLI_CONFIG_PATH = join(process.env.HOME!, 'none.yml');
    expect(text()).toContain('System Environment');
    expect(text()).toContain('AWS CDK is installed');
    expect(text()).toContain('Configuration is valid');
    expect(text()).toContain('API Base URL');
    expect(text()).toContain('PLATFORM_TOKEN');
  });

  it('--verbose without CDK, and --check-config with no token warns', async () => {
    getCdkInfo.mockReturnValue({ available: false, error: 'cdk: not found' });
    delete process.env.PLATFORM_TOKEN;
    await run(version, ['version', '--verbose', '--check-config']);
    expect(text()).toContain('AWS CDK is not installed');
    expect(text()).toContain('Error: cdk: not found');
    expect(text()).toContain('Not installed');
    expect(text()).toMatch(/Configuration is (valid|invalid)/);
    expect(text()).toContain('PLATFORM_TOKEN is required for API operations');
  });

  it('--json emits one machine-readable document', async () => {
    await run(version, ['version', '--json', '--check-config']);
    const doc = JSON.parse(logged.join('\n'));
    expect(doc).toMatchObject({ cli: { name: expect.any(String) }, cdk: { available: true, version: '2.200.0' }, environment: { token: true, url: true } });
  });
});

describe('status', () => {
  it('reports a reachable platform and a JWT\'s expiry (as JSON)', async () => {
    process.env.PLATFORM_TOKEN = `h.${Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString('base64url')}.s`;
    await run(status, ['status', '--json']);
    const doc = JSON.parse(logged.join('\n'));
    expect(doc).toMatchObject({ 'success': true, 'Platform Health': 'reachable', 'Token Expired': 'no', 'CDK Available': 'yes', 'PLATFORM_SECRET_NAME': 'not set' });
  });

  it('an access key has no local expiry; an unreachable platform says so', async () => {
    process.env.PLATFORM_TOKEN = 'pb_pat_0123456789abcdef0123456789abcdef';
    process.env.PLATFORM_BASE_URL = 'http://127.0.0.1:1';
    checkCdkAvailable.mockReturnValueOnce(false);
    await run(status, ['status']);
    expect(text()).toContain('unreachable');
    expect(text()).toMatch(/n\/a \(access key|unable to decode/);
    expect(text()).toContain('Environment Status');
  });

  it('an undecodable token and no token at all', async () => {
    process.env.PLATFORM_TOKEN = 'not-a-jwt';
    await run(status, ['status']);
    expect(text()).toContain('unable to decode');
    delete process.env.PLATFORM_TOKEN;
    logged.length = 0;
    await run(status, ['status']);
    expect(text()).toContain('not set');
  });
});
