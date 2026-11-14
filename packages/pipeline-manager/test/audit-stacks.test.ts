// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `audit stacks` against the registry route's REAL response envelope.
 *
 * The command read `.entries` while the route answers
 * `{ data: { registry: [...], pagination } }`, so the registry always looked
 * empty: every tagged stack was reported ORPHANED and no MISSING stack could
 * ever be found — a cron audit that was red forever. Nothing tested it. The
 * fake platform here builds every registry response with api-core's own
 * `sendPaginatedNested`, so a key or envelope drift fails this suite.
 *
 * Also pinned: it reads EVERY page (`limit`/`offset` until `hasMore` is false),
 * compares only the scanned region's rows, skips another org's stacks, refuses a
 * registry answered for a different org than `--org`, and prints a fix for each
 * finding.
 */

import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { useTempHome } from './helpers/temp-home.js';

const HOME = useTempHome('pm-audit-stacks-');
process.env.CLI_CONFIG_PATH = join(HOME, 'missing-config.yml');

interface FakeStack { StackName: string; StackStatus: string; Tags: Array<{ Key: string; Value: string }> }
let stackPages: FakeStack[][] = [];
const send = jest.fn<AnyFn>(async (cmd: { input: { NextToken?: string } }) => {
  const index = cmd.input.NextToken ? Number(cmd.input.NextToken) : 0;
  return {
    Stacks: stackPages[index] ?? [],
    NextToken: index + 1 < stackPages.length ? String(index + 1) : undefined,
  };
});
const cfnRegions: string[] = [];
jest.unstable_mockModule('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class { constructor(opts: { region: string }) { cfnRegions.push(opts.region); } send = send; },
  DescribeStacksCommand: class { constructor(readonly input: { NextToken?: string }) {} },
}));

const { sendPaginatedNested } = await import('@pipeline-builder/api-core');
const { auditStacks, REGISTRY_PAGE_LIMIT } = await import('../src/commands/audit-stacks.js');
const { Command } = await import('commander');

interface Row { id: string; pipelineId: string; orgId: string; pipelineName: string; stackName?: string; region?: string }
let registry: Row[] = [];
const registryQueries: URLSearchParams[] = [];

/** Run the route's real envelope builder against a minimal Express-shaped response. */
function envelope(rows: Row[], limit: number, offset: number): { status: number; body: unknown } {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    headersSent: false,
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
  };
  sendPaginatedNested(res as never, 'registry', rows.slice(offset, offset + limit), { total: rows.length, limit, offset });
  return out;
}

let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/api/pipelines/registry') { res.statusCode = 404; res.end('{}'); return; }
    registryQueries.push(url.searchParams);
    const { status, body } = envelope(registry, Number(url.searchParams.get('limit') ?? 100), Number(url.searchParams.get('offset') ?? 0));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.PLATFORM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(HOME, { recursive: true, force: true });
});

const logged: string[] = [];
class ExitError extends Error { constructor(readonly code?: number) { super(`__EXIT_${code}__`); } }

beforeEach(() => {
  logged.length = 0;
  registryQueries.length = 0;
  cfnRegions.length = 0;
  send.mockClear();
  registry = [];
  stackPages = [];
  process.env.PLATFORM_TOKEN = 'pb_pat_0123456789abcdef0123456789abcdef';
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new ExitError(c); }) as never);
});

/** Run `audit stacks --json …`; returns the exit code and the parsed JSON report (if any). */
async function audit(args: string[]): Promise<{ code?: number; report?: any }> {
  const program = new Command();
  program.exitOverride();
  auditStacks(program.command('audit'));
  let code: number | undefined;
  try {
    await program.parseAsync(['node', 'pm', 'audit', 'stacks', '--json', ...args]);
  } catch (e) {
    code = (e as ExitError).code;
  }
  const start = logged.findIndex((l) => l.trimStart().startsWith('{'));
  return { code, report: start >= 0 ? JSON.parse(logged.slice(start).join('\n')) : undefined };
}

const row = (n: number, over: Partial<Row> = {}): Row => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  pipelineId: `pl-${n}`,
  orgId: 'org-1',
  pipelineName: `p${n}`,
  stackName: `stack-${n}`,
  region: 'us-east-1',
  ...over,
});
const stack = (name: string, tags: Record<string, string> = { 'pipeline-builder': 'true', 'OrgId': 'org-1' }): FakeStack => ({
  StackName: name,
  StackStatus: 'CREATE_COMPLETE',
  Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
});

describe('audit stacks', () => {
  it('reads the registry from data.registry: matching stacks are not drift', async () => {
    registry = [row(1), row(2)];
    stackPages = [[stack('stack-1'), stack('stack-2')]];
    const { code, report } = await audit(['--region', 'us-east-1']);
    expect(report.findings).toEqual([]);
    expect(report.registryEntries).toBe(2);
    expect(code).toBe(0);
  });

  it('pages through the whole registry (no false orphans past the first page)', async () => {
    const n = REGISTRY_PAGE_LIMIT + 3;
    registry = Array.from({ length: n }, (_, i) => row(i));
    stackPages = [registry.slice(0, 100).map((r) => stack(r.stackName!)), registry.slice(100).map((r) => stack(r.stackName!))];
    const { code, report } = await audit(['--region', 'us-east-1']);
    expect(registryQueries.map((q) => q.get('offset'))).toEqual(['0', String(REGISTRY_PAGE_LIMIT)]);
    expect(registryQueries.every((q) => q.get('limit') === String(REGISTRY_PAGE_LIMIT))).toBe(true);
    expect(report.registryEntries).toBe(n);
    expect(report.cfnStacks).toBe(n);
    expect(report.findings).toEqual([]);
    expect(code).toBe(0);
  });

  it('finds an orphaned and a missing stack, each with the command that fixes it', async () => {
    registry = [row(1), row(2)];
    stackPages = [[stack('stack-1'), stack('stray', { 'pipeline-builder': 'true', 'OrgId': 'org-1', 'pb.pipeline-id': 'pl-9' })]];
    const { code, report } = await audit(['--region', 'us-east-1']);
    expect(code).toBe(1);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'orphaned-stack', stackName: 'stray', pipelineId: 'pl-9', fix: expect.stringContaining('pipeline register --id pl-9') }),
      expect.objectContaining({ type: 'missing-stack', stackName: 'stack-2', registryId: row(2).id, fix: `pipeline-manager pipeline deregister --id ${row(2).id}` }),
    ]));
    expect(report.findings).toHaveLength(2);
  });

  it('compares only the scanned region\'s registry rows', async () => {
    registry = [row(1), row(2, { region: 'eu-west-1' }), row(3, { region: undefined })];
    stackPages = [[stack('stack-1')]];
    const { code, report } = await audit(['--region', 'us-east-1']);
    expect(cfnRegions).toEqual(['us-east-1']);
    expect(report).toMatchObject({ registryEntries: 1, registryEntriesOtherRegions: 1, registryEntriesWithoutRegion: 1, findings: [] });
    expect(code).toBe(0);
  });

  it('skips another org\'s stacks in the same account', async () => {
    registry = [row(1)];
    stackPages = [[stack('stack-1'), stack('theirs', { 'pipeline-builder': 'true', 'OrgId': 'org-2' })]];
    const { code, report } = await audit(['--region', 'us-east-1']);
    expect(report.org).toBe('org-1');
    expect(report.cfnStacks).toBe(1);
    expect(code).toBe(0);
  });

  it('--org is sent as orgId, and a registry answered for another org is an error, not drift', async () => {
    registry = [row(1)]; // the platform scoped to the caller's org-1, not the requested org-2
    stackPages = [[stack('x', { 'pipeline-builder': 'true', 'OrgId': 'org-2' })]];
    const { code, report } = await audit(['--region', 'us-east-1', '--org', 'org-2']);
    expect(registryQueries[0]!.get('orgId')).toBe('org-2');
    expect(report).toBeUndefined();
    expect(code).toBe(2);
    expect(logged.join('\n')).toContain('not --org org-2');
  });

  it('a response without the registry list fails the audit (exit 2) instead of reading as empty', async () => {
    const realGet = server.listeners('request')[0] as (...a: unknown[]) => void;
    server.removeAllListeners('request');
    server.on('request', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, data: { entries: [] } })); });
    try {
      stackPages = [[stack('stack-1')]];
      const { code, report } = await audit(['--region', 'us-east-1']);
      expect(report).toBeUndefined();
      expect(code).toBe(2);
    } finally {
      server.removeAllListeners('request');
      server.on('request', realGet);
    }
  });

  it('hitting --max-pages is reported and exits non-zero', async () => {
    registry = [row(1)];
    stackPages = [[stack('stack-1')], [], []];
    const { code, report } = await audit(['--region', 'us-east-1', '--max-pages', '1']);
    expect(report.truncated).toBe(true);
    expect(code).toBe(1);
  });
});
