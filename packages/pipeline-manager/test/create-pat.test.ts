// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `auth pat`, driven through the real Commander wiring against a local platform
 * stub (device code → approved poll → POST /api/user/keys).
 *
 * Two things are pinned:
 *  - `--quiet` prints the `export PLATFORM_TOKEN=…` line. `--quiet` is also a
 *    PROGRAM-level option and Commander binds a trailing `--quiet` to the
 *    program, so reading only the subcommand's `options.quiet` meant the
 *    documented `eval $(pipeline-manager auth pat --name ci --quiet)` never got
 *    an export line (same trap `auth login` already handles).
 *  - a failed key create exits with the code for what actually failed: every
 *    HTTP failure used to exit AUTHENTICATION (4), so a 5xx or a 403 read to a
 *    script as "your sign-in was refused".
 */

import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { useTempHome } from './helpers/temp-home.js';

const HOME = useTempHome('pm-create-pat-');
process.env.CLI_CONFIG_PATH = join(HOME, 'missing-config.yml');

const RAW_KEY = 'pb_pat_0123456789abcdef0123456789abcdef';
let keyStatus = 200;
let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    req.resume();
    req.on('end', () => {
      if (req.url === '/api/auth/device/code') {
        return send(200, { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'http://x/verify', expires_in: 30, interval: 1 });
      }
      if (req.url === '/api/auth/device/token') {
        return send(200, { access_token: 'at', token_type: 'Bearer', expires_in: 900, step_up_token: 'su' });
      }
      if (req.url === '/api/user/keys') {
        return keyStatus === 200
          ? send(200, { success: true, data: { key: RAW_KEY, accessKey: { id: 'k1', name: 'ci', display: 'pb_pat_0123…', expiresAt: '2027-01-01' } } })
          : send(keyStatus, { success: false, message: 'nope' });
      }
      return send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.PLATFORM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(HOME, { recursive: true, force: true });
});

const { createPat } = await import('../src/commands/create-pat.js');
const { Command } = await import('commander');

const stdout: string[] = [];
class ExitError extends Error { constructor(readonly code?: number) { super(`__EXIT_${code}__`); } }

beforeEach(() => {
  stdout.length = 0;
  keyStatus = 200;
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { stdout.push(a.map(String).join(' ')); });
  for (const m of ['error', 'warn', 'info'] as const) jest.spyOn(console, m).mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new ExitError(c); }) as never);
});

/** program (with its own `--quiet`, as cli.ts defines it) -> `auth` -> `pat`. */
async function run(args: string[]): Promise<number | undefined> {
  const program = new Command();
  program.exitOverride();
  program.name('pipeline-manager').option('--quiet', 'Minimal output (errors only)', false);
  createPat(program.command('auth'));
  try {
    await program.parseAsync(['node', 'pm', 'auth', 'pat', '--name', 'ci', '--no-browser', ...args]);
    return undefined;
  } catch (e) {
    return (e as ExitError).code;
  }
}

describe('auth pat', () => {
  it('--quiet prints only the export line, even though Commander binds the flag to the program', async () => {
    expect(await run(['--quiet'])).toBeUndefined();
    expect(stdout.filter((l) => l.trim() !== '')).toEqual([`export PLATFORM_TOKEN=${RAW_KEY}`]);
  });

  it('a 5xx on the key create exits API_REQUEST (3), not AUTHENTICATION', async () => {
    keyStatus = 500;
    expect(await run([])).toBe(3);
  });

  it('a 403 on the key create exits AUTHORIZATION (5)', async () => {
    keyStatus = 403;
    expect(await run([])).toBe(5);
  });

  it('a 401 on the key create still exits AUTHENTICATION (4)', async () => {
    keyStatus = 401;
    expect(await run([])).toBe(4);
  });
});
