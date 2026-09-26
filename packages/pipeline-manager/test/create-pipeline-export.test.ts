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

/**
 * A `POST /pipelines/validate` reply. `--dry-run` now asks the SERVER to run every
 * create-time check; it used to print the request body and a green "✓ Validation
 * complete" having validated nothing, so a config a compliance rule, a plugin
 * contract or an exhausted quota would reject reported success.
 */
const validateReply = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    success: true,
    data: {
      valid: true,
      problems: [],
      warnings: [],
      normalized: { project: 'web', organization: 'acme', pipelineName: 'custom', visibility: 'org' },
      slot: { taken: false },
      preview: {
        stages: [{ stageName: 'Build', codePipelineStage: 'Build-alias', steps: [{ plugin: 'acme/jest', version: '1.2.3', position: 'pre' }] }],
        iam: { roleType: 'default', callerSupplied: false },
        plugins: ['acme/jest@1.2.3'],
      },
      deploys: [],
      ...over,
    },
  },
});

describe('pipeline create', () => {
  it('--dry-run validates SERVER-SIDE (flags over file values) and creates nothing', async () => {
    reply = validateReply();
    const file = props('p.txt', JSON.stringify({ project: 'web', organization: 'acme', a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }));
    await run(createPipeline, 'pipeline', ['create', '-f', file, '-n', 'custom', '--no-active', '--dry-run', '--deploy', '--no-verify-ssl']);

    // Exactly one call, to validate — never to the create endpoint.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/pipelines/validate' });
    expect(requests[0].body).toMatchObject({ pipelineName: 'custom', isActive: false });

    expect(text()).toContain('"pipelineName": "custom"');
    expect(text()).toContain('"isActive": false');
    expect(text()).toContain('File extension is not .json');
    expect(text()).toContain('With --deploy');
    // The structure a reviewer signs off on, not just the payload echo.
    expect(text()).toContain('acme/jest@1.2.3');
  });

  it('--dry-run exits NON-ZERO when the server reports problems', async () => {
    // Printing the problems and returning 0 is how a broken config reaches a
    // pipeline: a CI step running --dry-run must fail.
    reply = validateReply({ valid: false, problems: [{ stage: 'compliance', message: 'production deploys require approval' }] });
    const err = await run(createPipeline, 'pipeline', ['create', '-f', props('bad.json', JSON.stringify({ project: 'web', organization: 'acme' })), '--dry-run']);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBeGreaterThan(0);
    expect(text()).toContain('production deploys require approval');
  });

  it('--dry-run warns when the slot is already taken, which would 409', async () => {
    reply = validateReply({ slot: { taken: true, pipelineId: 'pipe-existing', pipelineName: 'acme-web' } });
    await run(createPipeline, 'pipeline', ['create', '-f', props('taken.json', JSON.stringify({ project: 'web', organization: 'acme' })), '--dry-run']);
    expect(text()).toContain('--upsert');
  });

  it('--dry-run flags a pipeline that produces no DORA deploy signal', async () => {
    reply = validateReply({ deploys: [] });
    await run(createPipeline, 'pipeline', ['create', '-f', props('nodeploy.json', JSON.stringify({ project: 'web', organization: 'acme' })), '--dry-run']);
    expect(text()).toContain('no DORA deploy signal');
  });

  it('warns on an empty props object', async () => {
    reply = validateReply();
    await run(createPipeline, 'pipeline', ['create', '-f', props('empty.json', '{}'), '-p', 'web', '-o', 'acme', '--dry-run']);
    expect(text()).toContain('Properties object is empty');
  });

  it('rejects --default, which one-pipeline-per-slot can never honour', async () => {
    // `pipeline_project_org_unique` allows one pipeline per (project, organization,
    // org), so the row created in a slot IS that slot's default. The flag was
    // silently dropped by the create schema; it is gone rather than lying.
    const err = await run(createPipeline, 'pipeline', ['create', '-f', props('d.json', JSON.stringify({ project: 'web', organization: 'acme' })), '--default', '--dry-run']);
    expect(err).toBeInstanceOf(ExitError);
    expect(requests).toHaveLength(0);
  });

  it('creates the pipeline and saves the returned record under ./output', async () => {
    reply = { status: 201, body: { success: true, data: { pipeline: { id: 'pipe-1', project: 'web', organization: 'acme', pipelineName: 'acme-web', props: { a: 1 }, createdAt: '2026-09-01' } } } };
    const err = await run(createPipeline, 'pipeline', ['create', '-f', props('ok.json', JSON.stringify({ project: 'web', organization: 'acme' }))]);
    expect(err).toBeUndefined();
    // No `isDefault`: the flag is gone, so the CLI no longer sends a field the
    // create schema stripped anyway.
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/pipelines', body: { project: 'web', organization: 'acme', visibility: 'org', isActive: true } });
    expect(requests[0].body).not.toHaveProperty('isDefault');
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
