// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline delete` and `pipeline deregister` — the remediation verbs an
 * `audit stacks` finding prints. Both are destructive and the CLI never prompts,
 * so both refuse to run without `--yes`.
 */

import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { useTempHome } from './helpers/temp-home.js';

const HOME = useTempHome('pm-pipeline-remove-');
process.env.CLI_CONFIG_PATH = join(HOME, 'missing-config.yml');

const seen: Array<{ method?: string; url?: string; auth?: string }> = [];
let status = 200;
let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { success: true, data: { id: 'x' } } : { success: false, message: 'Registry entry not found.' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.PLATFORM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(HOME, { recursive: true, force: true });
});

const { deletePipeline, deregisterPipeline } = await import('../src/commands/pipeline-remove.js');
const { Command } = await import('commander');

const logged: string[] = [];
class ExitError extends Error { constructor(readonly code?: number) { super(`__EXIT_${code}__`); } }

beforeEach(() => {
  seen.length = 0;
  logged.length = 0;
  status = 200;
  process.env.PLATFORM_TOKEN = 'pb_pat_0123456789abcdef0123456789abcdef';
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new ExitError(c); }) as never);
});

async function run(args: string[]): Promise<number | undefined> {
  const program = new Command();
  program.exitOverride();
  const pipeline = program.command('pipeline');
  deletePipeline(pipeline);
  deregisterPipeline(pipeline);
  try {
    await program.parseAsync(['node', 'pm', 'pipeline', ...args]);
    return undefined;
  } catch (e) {
    return (e as ExitError).code;
  }
}

const UUID = '00000000-0000-4000-8000-000000000001';

describe('pipeline deregister', () => {
  it('DELETEs the registry row by its id', async () => {
    expect(await run(['deregister', '--id', UUID, '--yes'])).toBeUndefined();
    expect(seen).toEqual([{ method: 'DELETE', url: `/api/pipelines/registry/${UUID}`, auth: 'Bearer pb_pat_0123456789abcdef0123456789abcdef' }]);
    expect(logged.join('\n')).toContain('Registry row removed');
  });

  it('refuses without --yes and calls nothing', async () => {
    expect(await run(['deregister', '--id', UUID])).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('a 404 exits non-zero', async () => {
    status = 404;
    expect(await run(['deregister', '--id', UUID, '--yes'])).toBe(6);
  });
});

describe('pipeline delete', () => {
  it('DELETEs the pipeline and warns the stack is left in AWS', async () => {
    expect(await run(['delete', '--id', UUID, '--yes'])).toBeUndefined();
    expect(seen).toEqual([expect.objectContaining({ method: 'DELETE', url: `/api/pipelines/${UUID}` })]);
    expect(logged.join('\n')).toContain('orphaned');
  });

  it('refuses without --yes', async () => {
    expect(await run(['delete', '--id', UUID])).toBe(2);
    expect(seen).toHaveLength(0);
  });
});
