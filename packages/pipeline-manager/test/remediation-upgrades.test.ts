// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin security fixes election (`remediationUpgrades`) from the CLI, end
 * to end against a local HTTP server:
 *
 * - `pipeline create`: the definition field and `--remediation-upgrades` both
 *   reach the create body at the TOP LEVEL (a platform setting), the flag wins
 *   over the file, and the props sent — what synth reads — are the definition
 *   without the field;
 * - absent from both → not sent, so an `--upsert` keeps the stored value;
 * - an invalid value is refused client-side, before any request;
 * - the server's 403 PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED exits non-zero with
 *   a suggestion naming the flag and the definition field;
 * - `pipeline deploy --id … --remediation-upgrades`: PUT before the deploy;
 *   refused with --local-spec (no platform); a local spec's field never reaches
 *   the synth props.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';

const WORK = mkdtempSync(join(tmpdir(), 'pm-remediation-'));
process.env.HOME = WORK;
process.env.CLI_CONFIG_PATH = join(WORK, 'none.yml');

const mockRunDeploy = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/utils/deploy-runner.js', () => ({
  __esModule: true,
  runDeploy: (...a: unknown[]) => mockRunDeploy(...a),
}));
// Plugin + toolchain resolution have their own suites; a fetched deploy only needs the record back.
const mockFetchPipelineProps = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/utils/pipeline-config.js', () => ({
  __esModule: true,
  fetchPipelineProps: (...a: unknown[]) => mockFetchPipelineProps(...a),
  printResolvedOrExit: jest.fn(),
}));
const mockApplyToolchainFile = jest.fn<AnyFn>().mockReturnValue('1.4.0');
jest.unstable_mockModule('../src/utils/toolchain.js', () => ({
  __esModule: true,
  applyToolchainFile: (...a: unknown[]) => mockApplyToolchainFile(...a),
  toolchainFileRequired: () => new Error('--toolchain-file is required'),
}));

const { Command } = await import('commander');
const { createPipeline } = await import('../src/commands/create-pipeline.js');
const { deploy } = await import('../src/commands/deploy.js');
const { liftRemediationUpgrades, parseRemediationUpgrades } = await import('../src/utils/remediation-upgrades.js');

type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
const fallback: Reply = { status: 201, body: { success: true, data: { pipeline: { id: 'pipe-1', project: 'web', organization: 'acme' } } } };
const requests: Array<{ method?: string; url?: string; body: any }> = [];
let server: Server;
const cwd = process.cwd();

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      const reply = replies.shift() ?? fallback;
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
  replies = [];
  mockRunDeploy.mockReset();
  mockFetchPipelineProps.mockReset();
  mockFetchPipelineProps.mockResolvedValue({
    pipeline: { id: 'pipe-1', project: 'web', organization: 'acme', orgId: 'org-1', isDefault: true, isActive: true, props: {} },
    propsWithIds: { project: 'web', organization: 'acme', pipelineId: 'pipe-1' },
    baseUrl: process.env.PLATFORM_BASE_URL,
    pluginWarnings: [],
  });
  process.env.PLATFORM_TOKEN = 'tok';
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new ExitError(c); }) as never);
});

async function run(register: (p: InstanceType<typeof Command>) => void, args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  register(program.command('pipeline'));
  try {
    await program.parseAsync(['node', 'pm', 'pipeline', ...args]);
    return undefined;
  } catch (e) {
    return e;
  }
}

const definition = { project: 'web', organization: 'acme', synth: { plugin: { name: 'cdk-synth' } }, stages: [{ stageName: 'Build', steps: [] }] };
const file = (name: string, content: Record<string, unknown>) => { writeFileSync(join(WORK, name), JSON.stringify(content)); return name; };
const refusal: Reply = {
  status: 403,
  body: {
    success: false,
    statusCode: 403,
    code: 'PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED',
    message: 'Your organization does not allow pipelines to choose Apply for plugin security fixes (its default is propose). Choose Follow organization, Off or Propose.',
  },
};

describe('the election helpers', () => {
  it('accepts every catalog value and refuses anything else, naming the choices', () => {
    for (const v of ['inherit', 'off', 'propose', 'apply']) expect(parseRemediationUpgrades(v, '--remediation-upgrades')).toBe(v);
    expect(() => parseRemediationUpgrades('auto', '--remediation-upgrades')).toThrow(/inherit, off, propose, apply/);
    expect(() => parseRemediationUpgrades(true, 'remediationUpgrades')).toThrow(/remediationUpgrades/);
  });

  it('lifts the field out of a definition, leaving the props exactly as they would be without it', () => {
    const { props, remediationUpgrades } = liftRemediationUpgrades({ ...definition, remediationUpgrades: 'off' });
    expect(remediationUpgrades).toBe('off');
    expect(props).toEqual(definition);
    expect(liftRemediationUpgrades(definition)).toEqual({ props: definition, remediationUpgrades: undefined });
  });
});

describe('pipeline create', () => {
  it('sends the definition field at the top level, and props without it (synth input unchanged)', async () => {
    await run(createPipeline, ['create', '-f', file('def.json', { ...definition, remediationUpgrades: 'off' })]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/pipelines' });
    expect(requests[0]!.body.remediationUpgrades).toBe('off');
    expect(requests[0]!.body.props).toEqual(definition);
  });

  it('--remediation-upgrades wins over the definition file', async () => {
    await run(createPipeline, ['create', '-f', file('def2.json', { ...definition, remediationUpgrades: 'off' }), '--remediation-upgrades', 'propose', '--upsert']);
    expect(requests[0]).toMatchObject({ url: '/api/pipelines?upsert=true' });
    expect(requests[0]!.body.remediationUpgrades).toBe('propose');
    expect(requests[0]!.body.props).toEqual(definition);
  });

  it('sends nothing when neither sets it, so an upsert keeps the stored election', async () => {
    await run(createPipeline, ['create', '-f', file('def3.json', definition), '--upsert']);
    expect('remediationUpgrades' in requests[0]!.body).toBe(false);
  });

  it.each([
    ['an invalid flag', ['--remediation-upgrades', 'auto'], definition],
    ['an invalid definition value', [], { ...definition, remediationUpgrades: 'always' }],
  ])('refuses %s client-side, before any request', async (_label, extra, content) => {
    const err = await run(createPipeline, ['create', '-f', file('bad.json', content as Record<string, unknown>), ...(extra as string[])]);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(2); // VALIDATION
    expect(requests).toHaveLength(0);
    expect(text()).toMatch(/inherit, off, propose, apply/);
  });

  it('surfaces the server\'s apply refusal with a readable suggestion and a non-zero exit', async () => {
    replies = [refusal];
    const err = await run(createPipeline, ['create', '-f', file('apply.json', definition), '--remediation-upgrades', 'apply']);
    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).code).toBe(5); // AUTHORIZATION
    expect(text()).toMatch(/does not allow pipelines to choose Apply/);
    expect(text()).toMatch(/--remediation-upgrades inherit, off or propose/);
    expect(text()).toMatch(/remediationUpgrades/);
  });
});

describe('pipeline deploy', () => {
  it('--id with --remediation-upgrades sets the election (PUT) before deploying', async () => {
    replies = [{ status: 200, body: { success: true, data: { pipeline: { id: 'pipe-1', remediationUpgrades: 'off' } } } }];
    await run(deploy, ['deploy', '--id', 'pipe-1', '--remediation-upgrades', 'off']);
    expect(requests).toEqual([expect.objectContaining({ method: 'PUT', url: '/api/pipelines/pipe-1', body: { remediationUpgrades: 'off' } })]);
    expect(mockRunDeploy).toHaveBeenCalledTimes(1);
  });

  it('--id without the flag writes nothing (the stored election stands)', async () => {
    await run(deploy, ['deploy', '--id', 'pipe-1']);
    expect(requests).toEqual([]);
    expect(mockRunDeploy).toHaveBeenCalledTimes(1);
  });

  it('stops before the deploy when the server refuses apply, with the readable suggestion', async () => {
    replies = [refusal];
    const err = await run(deploy, ['deploy', '--id', 'pipe-1', '--remediation-upgrades', 'apply']);
    expect(err).toBeInstanceOf(ExitError);
    expect(mockRunDeploy).not.toHaveBeenCalled();
    expect(text()).toMatch(/--remediation-upgrades inherit, off or propose/);
  });

  it('refuses an invalid flag client-side', async () => {
    const err = await run(deploy, ['deploy', '--id', 'pipe-1', '--remediation-upgrades', 'sometimes']);
    expect(err).toBeInstanceOf(ExitError);
    expect(requests).toEqual([]);
    expect(mockRunDeploy).not.toHaveBeenCalled();
  });

  it('refuses the flag with --show-resolved (a print-and-exit run never writes the pipeline)', async () => {
    const err = await run(deploy, ['deploy', '--id', 'pipe-1', '--show-resolved', '--remediation-upgrades', 'off']);
    expect(err).toBeInstanceOf(ExitError);
    expect(requests).toEqual([]);
    expect(mockFetchPipelineProps).not.toHaveBeenCalled();
    expect(text()).toMatch(/--remediation-upgrades.*--show-resolved/);
  });

  it('refuses the flag with --local-spec (no platform to store it)', async () => {
    const spec = file('local.json', { id: 'pipe-local', props: definition });
    const err = await run(deploy, ['deploy', '--local-spec', spec, '--toolchain-file', 'tc.json', '--remediation-upgrades', 'off']);
    expect(err).toBeInstanceOf(ExitError);
    expect(text()).toMatch(/--remediation-upgrades.*--id/);
    expect(mockRunDeploy).not.toHaveBeenCalled();
  });

  it('a local spec\'s definition field never reaches the synth props', async () => {
    const spec = file('local2.json', { id: 'pipe-local', props: { ...definition, remediationUpgrades: 'off' } });
    await run(deploy, ['deploy', '--local-spec', spec, '--toolchain-file', 'tc.json']);
    expect(mockRunDeploy).toHaveBeenCalledTimes(1);
    const { propsWithIds } = mockRunDeploy.mock.calls[0]![0] as { propsWithIds: Record<string, unknown> };
    expect('remediationUpgrades' in propsWithIds).toBe(false);
    expect(propsWithIds).toMatchObject(definition);
  });
});
