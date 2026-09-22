// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline create` (without --deploy) and `org export`, end to end against a
 * local HTTP server: the props-file validation (missing, not JSON, not an
 * object, no project/organization), the dry run (nothing sent), the create
 * request + saved output, a malformed create response, and the export written
 * to disk. Every refusal exits non-zero.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const WORK = mkdtempSync(join(tmpdir(), 'pm-create-'));
process.env.HOME = WORK;
process.env.CLI_CONFIG_PATH = join(WORK, 'none.yml');

const { Command } = await import('commander');
const { createPipeline } = await import('../src/commands/create-pipeline.js');
const { orgExport } = await import('../src/commands/org-export.js');

let reply: { status: number; body: unknown } = { status: 201, body: {} };
const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
let server: Server;
const cwd = process.cwd();

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.PLATFORM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.chdir(WORK);
});
afterAll(async () => {
  process.chdir(cwd);
  await new Promise((r) => server.close(r));
  rmSync(WORK, { recursive: true, force: true });
});

class ExitError extends Error { constructor(readonly code?: number) { super(`__EXIT_${code}__`); } }
const logged: string[] = [];
const text = () => logged.join('\n');

beforeEach(() => {
  requests.length = 0;
  logged.length = 0;
  process.env.PLATFORM_TOKEN = 'tok';
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new ExitError(c); }) as never);
});

async function run(register: (p: InstanceType<typeof Command>) => void, group: string, args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  register(program.command(group));
  try {
    await program.parseAsync(['node', 'pm', group, ...args]);
    return undefined;
  } catch (e) {
    return e;
  }
}

const props = (name: string, content: string) => { writeFileSync(join(WORK, name), content); return name; };

describe('pipeline create — input validation (exits non-zero, sends nothing)', () => {
  it.each([
    ['a missing props file', () => 'nope.json'],
    ['a file that is not JSON', () => props('bad.json', '{not json')],
    ['JSON that is not an object', () => props('null.json', 'null')],
    ['no project anywhere', () => props('noproj.json', JSON.stringify({ organization: 'acme' }))],
    ['no organization anywhere', () => props('noorg.json', JSON.stringify({ project: 'web' }))],
  ])('%s', async (_label, file) => {
    const err = await run(createPipeline, 'pipeline', ['create', '-f', file()]);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBeGreaterThan(0);
    expect(requests).toHaveLength(0);
  });
});

describe('pipeline create', () => {
  it('--dry-run previews the request (flags over file values) and sends nothing', async () => {
    const file = props('p.txt', JSON.stringify({ project: 'web', organization: 'acme', a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }));
    await run(createPipeline, 'pipeline', ['create', '-f', file, '-n', 'custom', '--default', '--no-active', '--dry-run', '--deploy', '--no-verify-ssl']);
    expect(requests).toHaveLength(0);
    expect(text()).toContain('"pipelineName": "custom"');
    expect(text()).toContain('"isActive": false');
    expect(text()).toContain('File extension is not .json');
    expect(text()).toContain('With --deploy');
  });

  it('warns on an empty props object', async () => {
    await run(createPipeline, 'pipeline', ['create', '-f', props('empty.json', '{}'), '-p', 'web', '-o', 'acme', '--dry-run']);
    expect(text()).toContain('Properties object is empty');
  });

  it('creates the pipeline and saves the returned record under ./output', async () => {
    reply = { status: 201, body: { success: true, data: { pipeline: { id: 'pipe-1', project: 'web', organization: 'acme', pipelineName: 'acme-web', props: { a: 1 }, createdAt: '2026-09-01' } } } };
    const err = await run(createPipeline, 'pipeline', ['create', '-f', props('ok.json', JSON.stringify({ project: 'web', organization: 'acme' }))]);
    expect(err).toBeUndefined();
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/pipelines', body: { project: 'web', organization: 'acme', visibility: 'org', isActive: true, isDefault: false } });
    expect(JSON.parse(readFileSync(join(WORK, 'output', 'pipeline-pipe-1.json'), 'utf8'))).toMatchObject({ id: 'pipe-1' });
    expect(text()).toContain('deploy --id pipe-1');
  });

  it('a response without a pipeline id is a failure', async () => {
    reply = { status: 201, body: { success: true, data: {} } };
    const err = await run(createPipeline, 'pipeline', ['create', '-f', props('ok2.json', JSON.stringify({ project: 'web', organization: 'acme' }))]);
    expect(err).toBeInstanceOf(ExitError);
  });

  it('an API refusal is a failure', async () => {
    reply = { status: 409, body: { message: 'exists' } };
    const err = await run(createPipeline, 'pipeline', ['create', '-f', props('ok3.json', JSON.stringify({ project: 'web', organization: 'acme' }))]);
    expect(err).toBeInstanceOf(ExitError);
  });
});

describe('org export', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';

  it('writes the export to the default file and summarises it', async () => {
    reply = { status: 200, body: { exportedAt: '2026-09-21T00:00:00Z', postgres: { pipelines: [], plugins: [] } } };
    await run(orgExport, 'org', ['export', '--id', ORG]);
    expect(requests[0]!.url).toBe(`/api/organization/${ORG}/export`);
    const saved = JSON.parse(readFileSync(join(WORK, `org-${ORG}-export.json`), 'utf8'));
    expect(saved.exportedAt).toBe('2026-09-21T00:00:00Z');
    expect(text()).toContain('Organization export complete');
  });

  it('honours --output, and tolerates an export without postgres/exportedAt', async () => {
    reply = { status: 200, body: { mongo: {} } };
    await run(orgExport, 'org', ['export', '--id', ORG, '--output', 'custom.json']);
    expect(existsSync(join(WORK, 'custom.json'))).toBe(true);
    expect(text()).toContain('(not set)');
  });

  it('a failed export exits non-zero', async () => {
    reply = { status: 404, body: { message: 'no such org' } };
    const err = await run(orgExport, 'org', ['export', '--id', ORG]);
    expect(err).toBeInstanceOf(ExitError);
  });
});
