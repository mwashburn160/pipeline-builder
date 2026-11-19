// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `infra setup-runner`: flag validation; the ORDER of every flow — register a
 * pending runner, deploy ONCE with its id, PATCH the endpoint (the platform
 * pings), update in place, delete; step-up on every platform write; the
 * operator-facing messages for the platform's refusals; the events-stack check
 * and --with-events; the bundle SHA-256; and a dry run that makes no call at all.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, jest } from '@jest/globals';

// The dry-run CLI test must prove nothing is spawned: every child_process entry point records and throws.
const realCp = await import('node:child_process');
const cpCalls: string[] = [];
const trap = (what: string) => (...a: unknown[]) => { cpCalls.push(`${what} ${String(a[0])}`); throw new Error(`dry run called ${what}`); };
const cpMock = { ...realCp, execFileSync: trap('execFileSync'), execSync: trap('execSync'), spawn: trap('spawn') };
jest.unstable_mockModule('child_process', () => ({ ...cpMock, default: cpMock }));

const {
  planRunner, describePlan, setupRunnerFlow, deleteRunner, prefixesFromPipelineNames, setupRunner, explainRunnerError,
  RUNNERS_NOT_ENABLED_MESSAGE, NO_SIGNING_KEY_MESSAGE,
} = await import('../src/commands/setup-runner.js');
type SetupRunnerDeps = import('../src/commands/setup-runner.js').SetupRunnerDeps;

const ENDPOINT = 'https://abc123.lambda-url.us-east-1.on.aws/';
const SHA = 'a'.repeat(64);
const PKG_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }).version;

/** An ApiError-shaped refusal (the CLI client rejects with `status` + `response.data`). */
const refused = (status: number, data: Record<string, unknown>) => Object.assign(new Error(String(data.message ?? status)), { status, response: { status, data } });

function fakeDeps(opts: {
  stack?: { outputs?: Record<string, string>; parameters?: Record<string, string> };
  eventsStack?: boolean;
  own?: Array<Record<string, unknown>>;
  available?: boolean;
  getError?: unknown;
  patchError?: unknown;
  patchStatus?: string;
  testResult?: Record<string, unknown>;
  names?: string[];
  deleteError?: unknown;
} = {}) {
  const calls: string[] = [];
  const detail: Record<string, unknown[]> = {};
  const warnings: string[] = [];
  const rec = (name: string, d?: unknown) => { calls.push(name); (detail[name] ??= []).push(d); };
  let deployed = !!opts.stack;
  let stepUps = 0;
  const deps: SetupRunnerDeps = {
    platformBaseUrl: 'https://platform.example',
    stepUp: async () => { stepUps += 1; rec('stepUp'); return `su-${stepUps}`; },
    platform: {
      async get(url) {
        rec(`GET ${url}`);
        if (opts.getError) throw opts.getError;
        return { data: { available: opts.available ?? true, jwksUrl: 'x', platformEgressIps: null, own: opts.own ?? [], inherited: [] } } as any;
      },
      async post(url, data, headers) {
        rec(`POST ${url}`, { data, headers });
        if (url.endsWith('/test')) return { data: opts.testResult ?? { ok: true, outcome: 'pong' } } as any;
        return { data: { runner: { id: 'run-1', orgId: 'org-1', label: (data as any).label, status: 'pending' } } } as any;
      },
      async patch(url, data, headers) {
        rec(`PATCH ${url}`, { data, headers });
        if (opts.patchError) throw opts.patchError;
        return { data: { runner: { id: 'run-1', status: opts.patchStatus ?? 'active' } } } as any;
      },
      async delete(url, headers) {
        rec(`DELETE ${url}`, { headers });
        if (opts.deleteError) throw opts.deleteError;
        return {} as any;
      },
    },
    async deployStack(a) { deployed = true; rec('deployStack', a); },
    async describeStack(name) {
      rec(`describeStack ${name}`);
      if (name === 'pipeline-builder-events') return opts.eventsStack === false ? undefined : { outputs: {}, parameters: {} };
      if (!deployed) return undefined;
      return { outputs: { EndpointUrl: ENDPOINT, ...opts.stack?.outputs }, parameters: { ...opts.stack?.parameters } };
    },
    async deleteStack(name) { rec('deleteStack', name); },
    async uploadCode(fn) { rec('uploadCode', fn); },
    async registeredPipelineNames() { rec('registry'); return opts.names ?? ['acme-app-pipeline', 'acme-web-pipeline']; },
    bundleSha256: () => SHA,
    async runSetupEvents(region) { rec('setupEvents', region); },
    warn: (m) => { warnings.push(m); },
  };
  return { deps, calls, detail, warnings };
}

const basePlan = (over: Record<string, unknown> = {}) => planRunner({ region: 'us-east-1', pipelinePrefix: 'acme-', ...over });
const STACK = 'describeStack pipeline-builder-runner-default';
const EVENTS = 'describeStack pipeline-builder-events';

describe('planRunner', () => {
  it('defaults: label default, Function ENDPOINT, the stack region as the only allowed region', () => {
    expect(planRunner({ region: 'us-east-1' })).toMatchObject({
      label: 'default', regions: ['us-east-1'], apiGateway: false, stackName: 'pipeline-builder-runner-default', withEvents: false,
    });
    expect(planRunner({ region: 'us-east-1' }).prefixes).toBeUndefined();
  });

  it("'*' requires --yes", () => {
    expect(() => planRunner({ region: 'us-east-1', pipelinePrefix: '*' })).toThrow(/--yes/);
    expect(planRunner({ region: 'us-east-1', pipelinePrefix: '*', yes: true }).prefixes).toEqual(['*']);
  });

  it('--api-gateway needs --allow-ip (CIDRs), and --allow-ip needs --api-gateway', () => {
    expect(() => planRunner({ region: 'us-east-1', apiGateway: true })).toThrow(/allow-ip/);
    expect(() => planRunner({ region: 'us-east-1', apiGateway: true, allowIp: ['nope'] })).toThrow(/CIDR/);
    expect(() => planRunner({ region: 'us-east-1', allowIp: ['1.2.3.4/32'] })).toThrow(/--api-gateway/);
    expect(planRunner({ region: 'us-east-1', apiGateway: true, allowIp: ['1.2.3.4/32', '2001:db8::/32'] }).allowIps).toHaveLength(2);
  });

  it('validates label, regions and prefixes', () => {
    expect(() => planRunner({ region: 'us-east-1', label: 'Bad Label' })).toThrow(/label/);
    expect(() => planRunner({ region: 'us-east-1', regions: 'us-east-1,mars' })).toThrow(/mars/);
    expect(() => planRunner({ region: 'us-east-1', pipelinePrefix: 'a b' })).toThrow(/prefix/);
  });

  it('derives the org prefix from registered pipeline names', () => {
    expect(prefixesFromPipelineNames(['acme-app-pipeline', 'acme-web-pipeline', 'ops-x', 'noseparator'])).toEqual(['acme-', 'ops-']);
  });

  it('describePlan shows the exact IAM, the steps in order, and the bundle hash', () => {
    const d = describePlan(basePlan({ regions: 'us-east-1,eu-west-2', withEvents: true }), SHA) as any;
    expect(d.iam['tag:GetResources']).toBe('*');
    expect(Object.values(d.iam)[1]).toEqual([
      'arn:${AWS::Partition}:codepipeline:us-east-1:${AWS::AccountId}:acme-*',
      'arn:${AWS::Partition}:codepipeline:eu-west-2:${AWS::AccountId}:acme-*',
    ]);
    expect(Object.keys(d.iam)).toHaveLength(2);
    expect(d.bundleSha256).toBe(SHA);
    expect(d.steps[0]).toMatch(/register a pending runner/);
    expect(d.steps[1]).toMatch(/deploy stack .* with its RUNNER_ID/);
    expect(d.steps.at(-1)).toMatch(/setup-events --scoped-ingest/);
  });
});

describe('install', () => {
  it('GET → register pending (step-up) → deploy ONCE with RUNNER_ID → upload → read ENDPOINT → PATCH (step-up) → events check', async () => {
    const f = fakeDeps();
    const r = await setupRunnerFlow(basePlan(), f.deps);
    expect(f.calls).toEqual([
      'GET /api/pipelines/runners',
      STACK,
      'stepUp', 'POST /api/pipelines/runners',
      'deployStack', 'uploadCode',
      STACK,
      'stepUp', 'PATCH /api/pipelines/runners/run-1',
      EVENTS,
    ]);
    const register = f.detail['POST /api/pipelines/runners']![0] as any;
    expect(register.data).toEqual({ label: 'default', regions: ['us-east-1'] });
    expect(register.headers).toEqual({ 'X-Step-Up-Token': 'su-1' });
    const deploys = f.detail.deployStack as any[];
    expect(deploys).toHaveLength(1);
    expect(deploys[0].parameters).toContain('RunnerId=run-1');
    expect(deploys[0].parameters).toContain(`PipelineManagerVersion=${PKG_VERSION}`);
    const patch = f.detail['PATCH /api/pipelines/runners/run-1']![0] as any;
    expect(patch).toEqual({ data: { functionUrl: ENDPOINT }, headers: { 'X-Step-Up-Token': 'su-2' } });
    expect(r).toMatchObject({ action: 'created', runnerId: 'run-1', status: 'active', bundleSha256: SHA, eventsStack: 'present' });
    expect(r.test).toBeUndefined(); // the PATCH's ping is the check
    // The endpoint is a secret: never in the result.
    expect(JSON.stringify(r)).not.toContain('lambda-url');
  });

  it('the stack template is scoped to the plan', async () => {
    const f = fakeDeps();
    await setupRunnerFlow(basePlan({ regions: 'us-east-1,eu-west-2', apiGateway: true, allowIp: ['203.0.113.1/32'] }), f.deps);
    const a = (f.detail.deployStack as any[])[0];
    const stmt = a.template.Resources.RunnerRole.Properties.Policies[0].PolicyDocument.Statement[1];
    expect(stmt.Resource).toHaveLength(2);
    // The API deployment is keyed to the allowlist, so a changed --allow-ip is actually deployed.
    const other = fakeDeps();
    await setupRunnerFlow(basePlan({ regions: 'us-east-1,eu-west-2', apiGateway: true, allowIp: ['203.0.113.2/32'] }), other.deps);
    const deployments = (t: any) => Object.keys(t.Resources).filter((k) => t.Resources[k].Type === 'AWS::ApiGateway::Deployment');
    expect(deployments(a.template)).not.toEqual(deployments((other.detail.deployStack as any[])[0].template));
    expect(a.parameters).toContain('EntryPoint=api-gateway');
    expect(a.parameters).toContain('AllowedIps=203.0.113.1/32');
  });

  it('defaults the prefix from the registry, and refuses to guess when there is none — before creating anything', async () => {
    const f = fakeDeps({ names: ['team_a-svc-pipeline'] });
    expect((await setupRunnerFlow(planRunner({ region: 'us-east-1' }), f.deps)).prefixes).toEqual(['team_a-']);
    const none = fakeDeps({ names: [] });
    await expect(setupRunnerFlow(planRunner({ region: 'us-east-1' }), none.deps)).rejects.toThrow(/--pipeline-prefix/);
    expect(none.calls).toEqual(['GET /api/pipelines/runners', 'registry']);
  });

  it('resumes an interrupted install: reuses the pending runner of this label instead of registering another', async () => {
    const f = fakeDeps({ own: [{ id: 'run-9', label: 'default', status: 'pending' }] });
    const r = await setupRunnerFlow(basePlan(), f.deps);
    expect(f.calls).not.toContain('POST /api/pipelines/runners');
    expect((f.detail.deployStack as any[])[0].parameters).toContain('RunnerId=run-9');
    expect(f.calls).toContain('PATCH /api/pipelines/runners/run-9');
    expect(r.action).toBe('updated');
  });
});

describe('update in place', () => {
  it('an active runner with the same endpoint: redeploy + upload + test ping, no registration, no PATCH', async () => {
    const f = fakeDeps({ stack: { parameters: { RunnerId: 'run-1' } }, own: [{ id: 'run-1', label: 'default', status: 'active', functionUrl: ENDPOINT }] });
    const r = await setupRunnerFlow(basePlan(), f.deps);
    expect(f.calls).toEqual(['GET /api/pipelines/runners', STACK, 'deployStack', 'uploadCode', STACK, 'stepUp', 'POST /api/pipelines/runners/run-1/test', EVENTS]);
    expect(r).toMatchObject({ action: 'updated', test: { ok: true, outcome: 'pong' } });
  });

  it('a pending runner gets its ENDPOINT PATCHed', async () => {
    const f = fakeDeps({ stack: { parameters: { RunnerId: 'run-1' } }, own: [{ id: 'run-1', label: 'default', status: 'pending' }] });
    await setupRunnerFlow(basePlan(), f.deps);
    expect(f.calls).toContain('PATCH /api/pipelines/runners/run-1');
    expect(f.calls).not.toContain('POST /api/pipelines/runners');
  });

  it('an endpoint that changed (e.g. Function ENDPOINT → API Gateway) is PATCHed', async () => {
    const f = fakeDeps({ stack: { parameters: { RunnerId: 'run-1' } }, own: [{ id: 'run-1', label: 'default', status: 'active', functionUrl: 'https://old.lambda-url.us-east-1.on.aws/' }] });
    await setupRunnerFlow(basePlan(), f.deps);
    expect(f.calls).toContain('PATCH /api/pipelines/runners/run-1');
  });

  it('a stack naming a runner the platform no longer has is refused before any deploy', async () => {
    const f = fakeDeps({ stack: { parameters: { RunnerId: 'run-1' } }, own: [{ id: 'run-1', label: 'default', status: 'revoked' }] });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(/--delete/);
    expect(f.calls).not.toContain('deployStack');
  });

  it('a failed test ping is reported, not thrown', async () => {
    const f = fakeDeps({ stack: { parameters: { RunnerId: 'run-1' } }, own: [{ id: 'run-1', status: 'active', label: 'default', functionUrl: ENDPOINT }], testResult: { ok: false, errorCode: 'SIGNATURE_INVALID' } });
    expect((await setupRunnerFlow(basePlan(), f.deps)).test).toEqual({ ok: false, errorCode: 'SIGNATURE_INVALID' });
  });
});

describe('event reporting', () => {
  it('warns when the events stack is missing in the region', async () => {
    const f = fakeDeps({ eventsStack: false });
    const r = await setupRunnerFlow(basePlan(), f.deps);
    expect(r.eventsStack).toBe('missing');
    expect(f.warnings.join('\n')).toMatch(/pipeline-builder-events.*--with-events/s);
  });

  it('--with-events runs setup-events --scoped-ingest after the runner is active', async () => {
    const f = fakeDeps({ eventsStack: false });
    const r = await setupRunnerFlow(basePlan({ withEvents: true }), f.deps);
    expect(f.calls.slice(-2)).toEqual([EVENTS, 'setupEvents']);
    expect(f.calls.indexOf('setupEvents')).toBeGreaterThan(f.calls.indexOf('PATCH /api/pipelines/runners/run-1'));
    expect(f.detail.setupEvents).toEqual(['us-east-1']);
    expect(r.eventsStack).toBe('deployed');
    expect(f.warnings).toEqual([]);
  });
});

describe('platform refusals', () => {
  it('GET 403 feature refusal → "not enabled for your organization", before touching AWS', async () => {
    const f = fakeDeps({ getError: refused(403, { message: 'This feature requires a higher plan (cross_account_runners)', code: 'INSUFFICIENT_PERMISSIONS' }) });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(RUNNERS_NOT_ENABLED_MESSAGE);
    expect(f.calls).toEqual(['GET /api/pipelines/runners']);
  });

  it('an ordinary 403 (no org_settings:write) is not mistaken for the feature refusal', () => {
    const e = refused(403, { message: 'Missing permission org_settings:write', code: 'INSUFFICIENT_PERMISSIONS' });
    expect(() => explainRunnerError(e)).toThrow(e);
  });

  it('a 403 naming another feature is not mistaken for the runner feature refusal', () => {
    const e = refused(403, { message: 'This feature requires a higher plan (advanced_reporting)', code: 'INSUFFICIENT_PERMISSIONS' });
    expect(() => explainRunnerError(e)).toThrow(e);
  });

  it('the operator-granted wording of the refusal is recognised', () => {
    const e = refused(403, { message: 'This feature is not enabled for your organization; ask your platform operator to enable it (cross_account_runners)', code: 'INSUFFICIENT_PERMISSIONS' });
    expect(() => explainRunnerError(e)).toThrow(RUNNERS_NOT_ENABLED_MESSAGE);
  });

  it('available:false → this platform has no runner signing key', async () => {
    const f = fakeDeps({ available: false });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(NO_SIGNING_KEY_MESSAGE);
    expect(NO_SIGNING_KEY_MESSAGE).toMatch(/no runner signing key configured/);
    expect(f.calls).toEqual(['GET /api/pipelines/runners']);
  });

  it('422 RUNNER_PING_FAILED on the PATCH → the runner stays pending; check its logs and re-run', async () => {
    const f = fakeDeps({ patchError: refused(422, { message: 'no pong', error: { code: 'RUNNER_PING_FAILED' } }) });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(/RUNNER_PING_FAILED.*stays pending.*CloudWatch.*re-run setup-runner/s);
    expect((f.detail.deployStack as any[])).toHaveLength(1);
  });

  it('409 RUNNER_PENDING is explained', () => {
    expect(() => explainRunnerError(refused(409, { errorCode: 'RUNNER_PENDING' }))).toThrow(/still pending/);
  });
});

describe('delete', () => {
  it('revokes on the platform (step-up) BEFORE deleting the stack', async () => {
    const f = fakeDeps({ stack: { parameters: { RunnerId: 'run-1' } } });
    const r = await deleteRunner(basePlan({ delete: true }), f.deps);
    expect(f.calls).toEqual([STACK, 'stepUp', 'DELETE /api/pipelines/runners/run-1', 'deleteStack']);
    expect(f.detail.deleteStack).toEqual(['pipeline-builder-runner-default']);
    expect((f.detail['DELETE /api/pipelines/runners/run-1']![0] as any).headers).toEqual({ 'X-Step-Up-Token': 'su-1' });
    expect(r).toMatchObject({ action: 'deleted', runnerId: 'run-1' });
  });

  it('with no stack here, revokes a PENDING runner of that label (an install that never got its stack)', async () => {
    const f = fakeDeps({ own: [{ id: 'run-7', label: 'default', status: 'pending' }] });
    await deleteRunner(basePlan({ delete: true }), f.deps);
    expect(f.calls).toEqual([STACK, 'GET /api/pipelines/runners', 'stepUp', 'DELETE /api/pipelines/runners/run-7']);
  });

  it('with no stack here, never revokes an ACTIVE runner found only by label (its stack is in another account or region)', async () => {
    const f = fakeDeps({ own: [{ id: 'run-7', label: 'default', status: 'active' }] });
    await expect(deleteRunner(basePlan({ delete: true }), f.deps)).rejects.toThrow(/active.*another AWS account or region.*Pipeline runners/s);
    expect(f.calls).toEqual([STACK, 'GET /api/pipelines/runners']);
  });

  it('an already-revoked runner (404) still has its stack removed; any other failure stops before the stack', async () => {
    const gone = fakeDeps({ stack: { parameters: { RunnerId: 'run-1' } }, deleteError: refused(404, {}) });
    await deleteRunner(basePlan({ delete: true }), gone.deps);
    expect(gone.calls).toContain('deleteStack');
    expect(gone.warnings[0]).toMatch(/no such runner/);
    const paused = fakeDeps({ stack: { parameters: { RunnerId: 'run-1' } }, deleteError: refused(403, { message: 'feature (cross_account_runners)' }) });
    await expect(deleteRunner(basePlan({ delete: true }), paused.deps)).rejects.toThrow(RUNNERS_NOT_ENABLED_MESSAGE);
    expect(paused.calls).not.toContain('deleteStack');
  });

  it('nothing to delete is an error', async () => {
    const f = fakeDeps();
    await expect(deleteRunner(basePlan({ delete: true }), f.deps)).rejects.toThrow(/No runner/);
  });
});

describe('the CLI', () => {
  it('--dry-run prints the plan as JSON and makes no AWS or platform call', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    program.exitOverride();
    setupRunner(program.command('infra'));
    const out: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((() => { throw new Error('dry run called fetch'); }) as never);
    const savedToken = process.env.PLATFORM_TOKEN;
    delete process.env.PLATFORM_TOKEN;
    cpCalls.length = 0;
    try {
      await program.parseAsync(['node', 'pm', 'infra', 'setup-runner', '--region', 'us-east-1', '--regions', 'us-east-1,eu-west-2',
        '--pipeline-prefix', 'acme-', '--with-events', '--dry-run', '--json']);
    } finally {
      log.mockRestore();
      fetchSpy.mockRestore();
      if (savedToken !== undefined) process.env.PLATFORM_TOKEN = savedToken;
    }
    expect(JSON.parse(out.join('\n'))).toMatchObject({
      success: true, dryRun: true, regions: ['us-east-1', 'eu-west-2'], pipelinePrefixes: ['acme-'], entryPoint: 'function-url',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cpCalls).toEqual([]);
  });

  it('has --with-events and no --mode (push-only)', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    setupRunner(program.command('infra'));
    const cmd = program.commands[0]!.commands.find((c) => c.name() === 'setup-runner')!;
    const flags = cmd.options.map((o) => o.long);
    expect(flags).not.toContain('--mode');
    expect(flags).toEqual(expect.arrayContaining(['--with-events', '--api-gateway', '--allow-ip', '--pipeline-prefix', '--regions', '--delete', '--dry-run', '--json', '--yes']));
  });
});
