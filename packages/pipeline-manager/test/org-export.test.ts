// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `org export` writes the org's GDPR portability dump — its members' names and
 * emails, every pipeline and plugin record — to disk. That file must be readable
 * by the current user only: it was written with the process umask (0644 by
 * default), so on a shared host every local account could read it.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { useTempHome } from './helpers/temp-home.js';

const HOME = useTempHome('pm-org-export-');
process.env.CLI_CONFIG_PATH = join(HOME, 'missing-config.yml');
const OUT_DIR = mkdtempSync(join(os.tmpdir(), 'pm-org-export-out-'));
const ORG = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === `/api/organization/${ORG}/export`
      ? { exportedAt: '2026-01-01T00:00:00.000Z', postgres: { pipelines: [] } }
      : {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.PLATFORM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(HOME, { recursive: true, force: true });
  rmSync(OUT_DIR, { recursive: true, force: true });
});

const { orgExport } = await import('../src/commands/org-export.js');
const { Command } = await import('commander');

beforeEach(() => {
  process.env.PLATFORM_TOKEN = 'pb_pat_0123456789abcdef0123456789abcdef';
  for (const m of ['log', 'error', 'warn', 'info'] as const) jest.spyOn(console, m).mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error(`__EXIT_${c}__`); }) as never);
});

async function run(output: string): Promise<void> {
  const program = new Command();
  program.exitOverride();
  orgExport(program.command('org'));
  await program.parseAsync(['node', 'pm', 'org', 'export', '--id', ORG, '--output', output]);
}

describe('org export', () => {
  it('writes the dump owner-only (0600)', async () => {
    const out = join(OUT_DIR, 'new.json');
    await run(out);
    expect((statSync(out).mode % 0o1000).toString(8)).toBe('600');
  });

  it('tightens a pre-existing output file to 0600 too', async () => {
    const out = join(OUT_DIR, 'existing.json');
    writeFileSync(out, 'stale', { mode: 0o644 });
    await run(out);
    expect((statSync(out).mode % 0o1000).toString(8)).toBe('600');
  });
});
