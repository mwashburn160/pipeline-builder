// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `infra setup-runner`: flag validation; the ORDER of every flow — list the
 * account's runner stacks, register a pending runner, deploy ONCE with its id
 * (stack pipeline-builder-runner-<runnerId>, label as a tag), PATCH the endpoint
 * (the platform pings), update in place, delete; one runner per AWS account per
 * org (refuse a second of the same org, warn beside another org's, ask beside a
 * parent's shared runner); the signing-key check and --generate-key; step-up on
 * every platform write; the operator-facing messages for the platform's
 * refusals; the events-stack check and --with-events; the bundle SHA-256; and a
 * dry run that makes no call at all.
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
  planRunner, describePlan, setupRunnerFlow, deleteRunner, prefixesFromPipelineNames, setupRunner, explainRunnerError, scanRegionStacks,
  runnersUnavailableMessage, NO_ORG_KEY_MESSAGE, KEY_UNREADABLE_MESSAGE, classifyAccountRunners, prefixesOverlap, runnerStackInfo, SETUP_RUNNER_HELP,
} = await import('../src/commands/setup-runner.js');
type SetupRunnerDeps = import('../src/commands/setup-runner.js').SetupRunnerDeps;
type RunnerStackInfo = import('../src/commands/setup-runner.js').RunnerStackInfo;

const ENDPOINT = 'https://abc123.lambda-url.us-east-1.on.aws/';
const SHA = 'a'.repeat(64);
const PKG_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }).version;

/** An ApiError-shaped refusal (the CLI client rejects with `status` + `response.data`). */
const refused = (status: number, data: Record<string, unknown>) => Object.assign(new Error(String(data.message ?? status)), { status, response: { status, data } });

const keySummary = (kid: string) => ({ kid, state: 'active', createdAt: '2026-11-01T00:00:00Z', createdBy: 'u1', activatesAt: '2026-11-01T00:00:00Z', retireAfter: null, ageDays: 18 });
/** An own-mode root org with an active key: the ordinary case. */
const ACTIVE_KEY = {
  mode: 'own',
  isRootOrg: true,
  active: keySummary('kid-active-123456'),
  next: null,
  retiring: null,
  rotation: 'none',
  inheritedFrom: null,
  inheritingTeams: 0,
  inheritingTeamNames: [],
  inheritingRunners: 1,
  transition: null,
  unreadable: false,
  maxAgeDays: 365,
};
const NO_KEY = { ...ACTIVE_KEY, active: null, inheritingRunners: 0 };

/** A runner stack in the account. */
const stack = (runnerId: string, over: Partial<RunnerStackInfo> = {}): RunnerStackInfo => ({
  stackName: `pipeline-builder-runner-${runnerId}`, region: 'us-east-1', runnerId, prefixes: ['acme-'], ...over,
});

function fakeDeps(opts: {
  /** The account's runner stacks (what listRunnerStacks finds). */
  stacks?: RunnerStackInfo[];
  eventsStack?: boolean;
  own?: Array<Record<string, unknown>>;
  inherited?: Array<Record<string, unknown>>;
  signingKey?: Record<string, unknown> | null;
  available?: boolean;
  unavailableReason?: string;
  getError?: unknown;
  patchError?: unknown;
  patchStatus?: string;
  testResult?: Record<string, unknown>;
  names?: string[];
  deleteError?: unknown;
  confirm?: boolean;
  /** The account's enabled regions (EC2 DescribeRegions), or the error reading them. */
  enabledRegions?: string[] | Error;
} = {}) {
  const calls: string[] = [];
  const detail: Record<string, unknown[]> = {};
  const warnings: string[] = [];
  const questions: string[] = [];
  const rec = (name: string, d?: unknown) => { calls.push(name); (detail[name] ??= []).push(d); };
  const deployed = new Set((opts.stacks ?? []).map((s) => s.stackName));
  let stepUps = 0;
  const deps: SetupRunnerDeps = {
    platformBaseUrl: 'https://platform.example',
    stepUp: async () => { stepUps += 1; rec('stepUp'); return `su-${stepUps}`; },
    platform: {
      async get(url) {
        rec(`GET ${url}`);
        if (opts.getError) throw opts.getError;
        return {
          data: {
            available: opts.available ?? true,
            unavailableReason: opts.unavailableReason ?? null,
            platformEgressIps: null,
            own: opts.own ?? [],
            inherited: opts.inherited ?? [],
            signingKey: opts.signingKey === undefined ? ACTIVE_KEY : opts.signingKey,
          },
        } as any;
      },
      async post(url, data, headers) {
        rec(`POST ${url}`, { data, headers });
        if (url.endsWith('/test')) return { data: opts.testResult ?? { ok: true, outcome: 'pong' } } as any;
        if (url.endsWith('/signing-key')) return { data: { ...NO_KEY, active: keySummary('kid-generated-abcdef') } } as any;
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
    async deployStack(a) { deployed.add(a.stackName); rec('deployStack', a); },
    async describeStack(name) {
      rec(`describeStack ${name}`);
      const none: Record<string, string> = {};
      if (name === 'pipeline-builder-events') return opts.eventsStack === false ? undefined : { outputs: none, parameters: none };
      if (!deployed.has(name)) return undefined;
      return { outputs: { EndpointUrl: ENDPOINT }, parameters: {} };
    },
    // Recorded in `detail` only: the flows' call order below stays about the platform and the stacks.
    async enabledRegions(region) {
      (detail.enabledRegions ??= []).push(region);
      if (opts.enabledRegions instanceof Error) throw opts.enabledRegions;
      return opts.enabledRegions ?? ['us-east-1'];
    },
    async listRunnerStacks(regions, required) { rec('listRunnerStacks', { regions, required }); return opts.stacks ?? []; },
    async deleteStack(name, region) { rec('deleteStack', { name, region }); },
    async uploadCode(fn) { rec('uploadCode', fn); },
    async registeredPipelineNames() { rec('registry'); return opts.names ?? ['acme-app-pipeline', 'acme-web-pipeline']; },
    bundleSha256: () => SHA,
    async runSetupEvents(region) { rec('setupEvents', region); },
    async confirm(q) { questions.push(q); return opts.confirm ?? false; },
    warn: (m) => { warnings.push(m); },
  };
  return { deps, calls, detail, warnings, questions };
}

const basePlan = (over: Record<string, unknown> = {}) => planRunner({ region: 'us-east-1', pipelinePrefix: 'acme-', ...over });
const STACK = 'describeStack pipeline-builder-runner-run-1';
const EVENTS = 'describeStack pipeline-builder-events';

describe('planRunner', () => {
  it('defaults: label default, Function ENDPOINT, the stack region as the only allowed region', () => {
    expect(planRunner({ region: 'us-east-1' })).toMatchObject({
      label: 'default', regions: ['us-east-1'], scanRegions: ['us-east-1'], apiGateway: false, withEvents: false, generateKey: false,
    });
    expect(planRunner({ region: 'us-east-1' }).prefixes).toBeUndefined();
  });

  it('looks for runner stacks in the stack region and every --regions region', () => {
    expect(planRunner({ region: 'us-east-1', regions: 'eu-west-2,us-east-1,ap-south-1' }).scanRegions).toEqual(['us-east-1', 'eu-west-2', 'ap-south-1']);
  });

  it('--generate-key and --delete contradict each other', () => {
    expect(() => planRunner({ region: 'us-east-1', generateKey: true, delete: true })).toThrow(/--generate-key/);
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

  it('--api-gateway gets a WAF rate limit by default; --waf-rate-limit sets it, --no-waf drops it', () => {
    const gw = { region: 'us-east-1', apiGateway: true, allowIp: ['1.2.3.4/32'] };
    expect(planRunner(gw)).toMatchObject({ waf: true, wafRateLimit: 1000 });
    expect(planRunner({ ...gw, wafRateLimit: '250' })).toMatchObject({ waf: true, wafRateLimit: 250 });
    expect(planRunner({ ...gw, waf: false })).toMatchObject({ waf: false });
    // The Function URL entry point has no WAF to configure.
    expect(planRunner({ region: 'us-east-1' })).toMatchObject({ waf: false });
  });

  it('--waf-rate-limit is an integer in the WAFv2 range, needs --api-gateway, and conflicts with --no-waf', () => {
    const gw = { region: 'us-east-1', apiGateway: true, allowIp: ['1.2.3.4/32'] };
    expect(() => planRunner({ ...gw, wafRateLimit: '9' })).toThrow(/waf-rate-limit/);
    expect(() => planRunner({ ...gw, wafRateLimit: '1.5' })).toThrow(/waf-rate-limit/);
    expect(() => planRunner({ ...gw, wafRateLimit: 'lots' })).toThrow(/waf-rate-limit/);
    expect(() => planRunner({ ...gw, wafRateLimit: '3000000000' })).toThrow(/waf-rate-limit/);
    expect(() => planRunner({ region: 'us-east-1', wafRateLimit: '500' })).toThrow(/--api-gateway/);
    expect(() => planRunner({ ...gw, waf: false, wafRateLimit: '500' })).toThrow(/--no-waf/);
  });

  it('describePlan names the WAF with --api-gateway (and says when it is off)', () => {
    const gw = { apiGateway: true, allowIp: ['1.2.3.4/32'] };
    expect((describePlan(basePlan({ ...gw, wafRateLimit: '400' })) as any).waf).toEqual({ rateLimit: 400, per: '5 minutes per source IP', action: 'block' });
    expect((describePlan(basePlan({ ...gw, waf: false })) as any).waf).toBe('disabled (--no-waf)');
    expect((describePlan(basePlan()) as any).waf).toBeUndefined();
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
    expect(d.steps[0]).toMatch(/list the account's runner stacks in every enabled region of the account \(EC2 DescribeRegions; us-east-1, eu-west-2 always\): one runner per AWS account per organization/);
    expect(d.steps[1]).toMatch(/register a pending runner/);
    expect(d.steps[2]).toMatch(/deploy stack pipeline-builder-runner-<runnerId> with its RUNNER_ID/);
    expect(d.stackName).toBe('pipeline-builder-runner-<runnerId>');
    expect(d.stackTags).toEqual({ 'pb.runner-label': 'default' });
    expect(d.jwksUrl).toBe('<platform>/api/pipelines/runner/runners/<runnerId>/jwks.json');
    expect(d.steps.at(-1)).toMatch(/setup-events --scoped-ingest/);
  });
});


describe('account scan: every enabled region of the account', () => {
  // The rule is one runner per ACCOUNT: a runner stack in a region outside the
  // stack region and --regions was invisible, so a second one was installed.
  it('lists the runner stacks of every enabled region, the stack region and --regions first (and required)', async () => {
    const f = fakeDeps({ enabledRegions: ['ap-south-1', 'eu-west-2', 'sa-east-1', 'us-east-1'] });
    await setupRunnerFlow(basePlan({ regions: 'us-east-1,eu-west-2' }), f.deps);
    expect(f.detail.enabledRegions).toEqual(['us-east-1']);
    expect(f.detail.listRunnerStacks).toEqual([{
      regions: ['us-east-1', 'eu-west-2', 'ap-south-1', 'sa-east-1'], required: ['us-east-1', 'eu-west-2'],
    }]);
  });

  it('refuses a second runner of the org found in a region outside --regions', async () => {
    const f = fakeDeps({
      enabledRegions: ['us-east-1', 'sa-east-1'],
      stacks: [stack('run-9', { region: 'sa-east-1', label: 'ops' })],
      own: [{ id: 'run-9', label: 'ops', status: 'active', regions: ['sa-east-1'] }],
    });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(/runner "ops" \(run-9, stack pipeline-builder-runner-run-9 in sa-east-1\)/);
    expect(f.calls).not.toContain('deployStack');
  });

  it('--delete finds the runner in any enabled region', async () => {
    const f = fakeDeps({
      enabledRegions: ['us-east-1', 'ca-central-1'],
      stacks: [stack('run-4', { region: 'ca-central-1', label: 'default' })],
      own: [{ id: 'run-4', label: 'default', status: 'active', regions: ['ca-central-1'] }],
    });
    await expect(deleteRunner(basePlan({ delete: true }), f.deps)).rejects.toThrow(/lives in stack pipeline-builder-runner-run-4 in ca-central-1/);
    expect((f.detail.listRunnerStacks as any[])[0].regions).toEqual(['us-east-1', 'ca-central-1']);
  });

  it('stops before anything is created when the enabled regions cannot be read', async () => {
    const f = fakeDeps({ enabledRegions: new Error('UnauthorizedOperation') });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(/ec2:DescribeRegions.*UnauthorizedOperation/);
    expect(f.calls).toEqual(['GET /api/pipelines/runners']);
  });
});

describe('scanRegionStacks', () => {
  it('reads every region in parallel', async () => {
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const p = scanRegionStacks(['us-east-1', 'eu-west-2', 'ap-south-1'], ['us-east-1'], (region) => {
      started.push(region);
      return new Promise((resolve) => gates.push(() => resolve([stack(`r-${region}`, { region })])));
    }, () => {});
    await Promise.resolve();
    expect(started).toEqual(['us-east-1', 'eu-west-2', 'ap-south-1']);
    gates.forEach((g) => g());
    expect((await p).map((s) => s.region)).toEqual(['us-east-1', 'eu-west-2', 'ap-south-1']);
  });

  it('a region it must cover fails the scan; any other unreadable region is warned and skipped', async () => {
    const warnings: string[] = [];
    const list = async (region: string) => {
      if (region === 'me-south-1') throw new Error('AccessDenied by SCP');
      if (region === 'eu-west-2') throw new Error('throttled');
      return [stack(`r-${region}`, { region })];
    };
    await expect(scanRegionStacks(['us-east-1', 'eu-west-2'], ['us-east-1', 'eu-west-2'], list, (m) => warnings.push(m)))
      .rejects.toThrow(/eu-west-2.*throttled/);
    const found = await scanRegionStacks(['us-east-1', 'me-south-1'], ['us-east-1'], list, (m) => warnings.push(m));
    expect(found.map((s) => s.region)).toEqual(['us-east-1']);
    expect(warnings).toEqual([expect.stringMatching(/me-south-1.*AccessDenied by SCP/)]);
  });
});

describe('install', () => {
  it('GET → list account runner stacks → register pending (step-up) → deploy ONCE as pipeline-builder-runner-<id> → upload → read ENDPOINT → PATCH (step-up) → events check', async () => {
    const f = fakeDeps();
    const r = await setupRunnerFlow(basePlan({ regions: 'us-east-1,eu-west-2' }), f.deps);
    expect(f.calls).toEqual([
      'GET /api/pipelines/runners',
      'listRunnerStacks',
      'stepUp', 'POST /api/pipelines/runners',
      'deployStack', 'uploadCode',
      STACK,
      'stepUp', 'PATCH /api/pipelines/runners/run-1',
      EVENTS,
    ]);
    expect(f.detail.listRunnerStacks).toEqual([{ regions: ['us-east-1', 'eu-west-2'], required: ['us-east-1', 'eu-west-2'] }]);
    const register = f.detail['POST /api/pipelines/runners']![0] as any;
    expect(register.data).toEqual({ label: 'default', regions: ['us-east-1', 'eu-west-2'] });
    expect(register.headers).toEqual({ 'X-Step-Up-Token': 'su-1' });
    const deploys = f.detail.deployStack as any[];
    expect(deploys).toHaveLength(1);
    expect(deploys[0].stackName).toBe('pipeline-builder-runner-run-1');
    expect(deploys[0].tags).toEqual({ 'pb.runner-label': 'default' });
    expect(deploys[0].parameters).toContain('RunnerId=run-1');
    expect(deploys[0].parameters).toContain('NameSuffix=-run-1');
    expect(deploys[0].parameters).toContain(`PipelineManagerVersion=${PKG_VERSION}`);
    expect(f.detail.uploadCode).toEqual(['pipeline-builder-runner-run-1']);
    const patch = f.detail['PATCH /api/pipelines/runners/run-1']![0] as any;
    expect(patch).toEqual({ data: { functionUrl: ENDPOINT }, headers: { 'X-Step-Up-Token': 'su-2' } });
    expect(r).toMatchObject({
      action: 'created',
      runnerId: 'run-1',
      stackName: 'pipeline-builder-runner-run-1',
      status: 'active',
      bundleSha256: SHA,
      eventsStack: 'present',
      jwksUrl: 'https://platform.example/api/pipelines/runner/runners/run-1/jwks.json',
      signingKey: { origin: 'existing', kid: 'kid-active-123456' },
    });
    expect(r.test).toBeUndefined(); // the PATCH's ping is the check
    // The endpoint is a secret: never in the result.
    expect(JSON.stringify(r)).not.toContain('lambda-url');
    expect(f.warnings).toEqual([]);
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
    expect(a.parameters).toContain('EnableWaf=true');
    expect(a.template.Resources.RunnerWebAcl.Type).toBe('AWS::WAFv2::WebACL');
  });

  it('--waf-rate-limit / --no-waf reach the stack parameters', async () => {
    const f = fakeDeps();
    await setupRunnerFlow(basePlan({ apiGateway: true, allowIp: ['203.0.113.1/32'], wafRateLimit: '600' }), f.deps);
    expect((f.detail.deployStack as any[])[0].parameters).toEqual(expect.arrayContaining(['EnableWaf=true', 'WafRateLimit=600']));
    const g = fakeDeps();
    await setupRunnerFlow(basePlan({ apiGateway: true, allowIp: ['203.0.113.1/32'], waf: false }), g.deps);
    expect((g.detail.deployStack as any[])[0].parameters).toContain('EnableWaf=false');
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
    expect((f.detail.deployStack as any[])[0].stackName).toBe('pipeline-builder-runner-run-9');
    expect((f.detail.deployStack as any[])[0].parameters).toContain('RunnerId=run-9');
    expect(f.calls).toContain('PATCH /api/pipelines/runners/run-9');
    expect(r.action).toBe('updated');
  });
});

describe('update in place', () => {
  const mine = (over: Record<string, unknown> = {}) => ({ id: 'run-1', label: 'default', status: 'active', functionUrl: ENDPOINT, ...over });

  it('this org\'s runner with this label in the account: redeploy + upload + test ping, no registration, no PATCH', async () => {
    const f = fakeDeps({ stacks: [stack('run-1')], own: [mine()] });
    const r = await setupRunnerFlow(basePlan(), f.deps);
    expect(f.calls).toEqual(['GET /api/pipelines/runners', 'listRunnerStacks', 'deployStack', 'uploadCode', STACK, 'stepUp', 'POST /api/pipelines/runners/run-1/test', EVENTS]);
    expect(r).toMatchObject({ action: 'updated', test: { ok: true, outcome: 'pong' } });
  });

  it('a pending runner gets its ENDPOINT PATCHed', async () => {
    const f = fakeDeps({ stacks: [stack('run-1')], own: [mine({ status: 'pending', functionUrl: null })] });
    await setupRunnerFlow(basePlan(), f.deps);
    expect(f.calls).toContain('PATCH /api/pipelines/runners/run-1');
    expect(f.calls).not.toContain('POST /api/pipelines/runners');
  });

  it('an endpoint that changed (e.g. Function ENDPOINT → API Gateway) is PATCHed', async () => {
    const f = fakeDeps({ stacks: [stack('run-1')], own: [mine({ functionUrl: 'https://old.lambda-url.us-east-1.on.aws/' })] });
    await setupRunnerFlow(basePlan(), f.deps);
    expect(f.calls).toContain('PATCH /api/pipelines/runners/run-1');
  });

  it('a stack of this label naming a runner the platform has revoked is refused before any deploy', async () => {
    const f = fakeDeps({ stacks: [stack('run-1')], own: [mine({ status: 'revoked' })] });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(/revoked.*--delete/s);
    expect(f.calls).not.toContain('deployStack');
  });

  it('the runner lives in another region of the account: update it there', async () => {
    const f = fakeDeps({ stacks: [stack('run-1', { region: 'eu-west-2' })], own: [mine()] });
    await expect(setupRunnerFlow(basePlan({ regions: 'us-east-1,eu-west-2' }), f.deps)).rejects.toThrow(/eu-west-2.*--region eu-west-2/s);
    expect(f.calls).not.toContain('deployStack');
  });

  it('a failed test ping is reported, not thrown', async () => {
    const f = fakeDeps({ stacks: [stack('run-1')], own: [mine()], testResult: { ok: false, errorCode: 'SIGNATURE_INVALID' } });
    expect((await setupRunnerFlow(basePlan(), f.deps)).test).toEqual({ ok: false, errorCode: 'SIGNATURE_INVALID' });
  });
});

describe('one runner per AWS account per organization', () => {
  it('refuses a second runner of the same org in the account, before registering or deploying anything', async () => {
    const f = fakeDeps({ stacks: [stack('run-1')], own: [{ id: 'run-1', label: 'ops', status: 'active' }] });
    await expect(setupRunnerFlow(basePlan({ label: 'web' }), f.deps)).rejects.toThrow(
      /already has your organization's runner "ops" \(run-1, stack pipeline-builder-runner-run-1 in us-east-1\).*at most one runner per AWS account.*--label ops --region us-east-1/s);
    expect(f.calls).toEqual(['GET /api/pipelines/runners', 'listRunnerStacks']);
  });

  it('also refuses when that runner is still pending (its stack is already here)', async () => {
    const f = fakeDeps({ stacks: [stack('run-1')], own: [{ id: 'run-1', label: 'ops', status: 'pending' }] });
    await expect(setupRunnerFlow(basePlan({ label: 'web' }), f.deps)).rejects.toThrow(/at most one runner per AWS account/);
  });

  it("allows another org's runner in the account, warning about the shared trust boundary and prefixes", async () => {
    const f = fakeDeps({ stacks: [stack('other-org-runner', { prefixes: ['globex-'] })] });
    const r = await setupRunnerFlow(basePlan(), f.deps);
    expect(r.action).toBe('created');
    expect(f.calls).toContain('deployStack');
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toMatch(/not your organization's.*pipeline-builder-runner-other-org-runner.*shared trust boundary.*distinct pipeline-name prefixes \(ALLOWED_PIPELINE_PREFIXES/s);
    expect(f.warnings[0]).not.toMatch(/overlap/);
    // Two orgs' runners never collide: each stack is named by its own runner id.
    expect((f.detail.deployStack as any[])[0].stackName).toBe('pipeline-builder-runner-run-1');
  });

  it("names overlapping prefixes with another org's runner", async () => {
    const f = fakeDeps({ stacks: [stack('other-org-runner', { prefixes: ['acme-web-'] })] });
    await setupRunnerFlow(basePlan(), f.deps);
    expect(f.warnings[0]).toMatch(/Your prefixes \(acme-\) overlap those of pipeline-builder-runner-other-org-runner \(acme-web-\)/);
  });

  it("warns and asks when a parent organization's shared runner is in the account; no means nothing is created", async () => {
    const f = fakeDeps({ stacks: [stack('parent-run')], inherited: [{ id: 'parent-run', label: 'shared', status: 'active', fromOrgName: 'Acme Corp' }], confirm: false });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(/--yes/);
    expect(f.warnings[0]).toMatch(/parent organization's shared runner: "shared" of Acme Corp.*already reaches this account's pipelines through it/s);
    expect(f.questions).toHaveLength(1);
    expect(f.calls).toEqual(['GET /api/pipelines/runners', 'listRunnerStacks']);
  });

  it("installs beside the parent's runner when confirmed, or with --yes without asking", async () => {
    const parent = { stacks: [stack('parent-run')], inherited: [{ id: 'parent-run', label: 'shared', status: 'active', fromOrgName: 'Acme Corp' }] };
    const asked = fakeDeps({ ...parent, confirm: true });
    expect((await setupRunnerFlow(basePlan(), asked.deps)).action).toBe('created');
    expect(asked.questions).toHaveLength(1);
    const yes = fakeDeps(parent);
    expect((await setupRunnerFlow(basePlan({ yes: true }), yes.deps)).action).toBe('created');
    expect(yes.questions).toEqual([]);
    expect(yes.warnings[0]).toMatch(/Acme Corp/);
  });

  it('classifyAccountRunners reads each RunnerId against the org\'s own and inherited runners', () => {
    const list = { own: [{ id: 'a', label: 'x' }], inherited: [{ id: 'b', label: 'y' }], signingKey: null };
    const c = classifyAccountRunners([stack('a'), stack('b'), stack('c'), { stackName: 'pipeline-builder-runner-x', region: 'us-east-1', prefixes: [] }], list as any);
    expect(c.own.map((o) => o.runner.id)).toEqual(['a']);
    expect(c.inherited.map((o) => o.runner.id)).toEqual(['b']);
    expect(c.foreign.map((s) => s.stackName)).toEqual(['pipeline-builder-runner-c', 'pipeline-builder-runner-x']);
  });

  it('prefixesOverlap', () => {
    expect(prefixesOverlap(['acme-'], ['globex-'])).toBe(false);
    expect(prefixesOverlap(['acme-'], ['acme-web-'])).toBe(true);
    expect(prefixesOverlap(['acme-web-'], ['acme-'])).toBe(true);
    expect(prefixesOverlap(['*'], ['globex-'])).toBe(true);
    expect(prefixesOverlap(['acme-'], [])).toBe(false);
  });

  it('runnerStackInfo reads RunnerId, the label tag and the prefixes; ignores other stacks', () => {
    expect(runnerStackInfo({
      StackName: 'pipeline-builder-runner-run-1',
      StackStatus: 'UPDATE_COMPLETE',
      CreationTime: new Date(),
      Parameters: [{ ParameterKey: 'RunnerId', ParameterValue: 'run-1' }, { ParameterKey: 'AllowedPipelinePrefixes', ParameterValue: 'acme-,ops-' }],
      Tags: [{ Key: 'pb.runner-label', Value: 'default' }],
    }, 'eu-west-2')).toEqual({ stackName: 'pipeline-builder-runner-run-1', region: 'eu-west-2', runnerId: 'run-1', label: 'default', prefixes: ['acme-', 'ops-'] });
    expect(runnerStackInfo({ StackName: 'pipeline-builder-events', StackStatus: 'CREATE_COMPLETE', CreationTime: new Date() }, 'us-east-1')).toBeUndefined();
  });

  it('the help states the rule', () => {
    expect(SETUP_RUNNER_HELP).toMatch(/One runner per AWS account per organization/);
    expect(SETUP_RUNNER_HELP).toMatch(/shared trust boundary/);
    expect(SETUP_RUNNER_HELP).toMatch(/ALLOWED_PIPELINE_PREFIXES/);
    expect(SETUP_RUNNER_HELP).toMatch(/--yes/);
    expect(SETUP_RUNNER_HELP).toMatch(/--generate-key/);
    expect(SETUP_RUNNER_HELP).toContain('/api/pipelines/runner/runners/<runnerId>/jwks.json');
  });
});

describe('signing key', () => {
  it('a root org with no key yet: the platform creates it with the first runner (no extra call)', async () => {
    const f = fakeDeps({ signingKey: NO_KEY });
    const r = await setupRunnerFlow(basePlan(), f.deps);
    expect(r.signingKey).toEqual({ origin: 'with-first-runner', kid: null });
    expect(f.calls).not.toContain('POST /api/pipelines/runners/signing-key');
  });

  it('no key and no new registration (an update): refused before deploying, pointing to --generate-key and the dashboard', async () => {
    const f = fakeDeps({ signingKey: NO_KEY, stacks: [stack('run-1')], own: [{ id: 'run-1', label: 'default', status: 'active', functionUrl: ENDPOINT }] });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(NO_ORG_KEY_MESSAGE);
    expect(NO_ORG_KEY_MESSAGE).toMatch(/--generate-key.*Settings → Organization → Pipeline runners/s);
    expect(f.calls).not.toContain('deployStack');
  });

  it('a sub-organization in own mode with no key is refused without --generate-key', async () => {
    const f = fakeDeps({ signingKey: { ...NO_KEY, isRootOrg: false } });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(NO_ORG_KEY_MESSAGE);
    expect(f.calls).not.toContain('POST /api/pipelines/runners');
  });

  it('--generate-key creates it (step-up) before the runner is registered', async () => {
    const f = fakeDeps({ signingKey: { ...NO_KEY, isRootOrg: false } });
    const r = await setupRunnerFlow(basePlan({ generateKey: true }), f.deps);
    expect(f.calls.slice(0, 6)).toEqual(['GET /api/pipelines/runners', 'listRunnerStacks', 'stepUp', 'POST /api/pipelines/runners/signing-key', 'stepUp', 'POST /api/pipelines/runners']);
    expect((f.detail['POST /api/pipelines/runners/signing-key']![0] as any).headers).toEqual({ 'X-Step-Up-Token': 'su-1' });
    expect(r.signingKey).toEqual({ origin: 'generated', kid: 'kid-generated-abcdef' });
  });

  it('--generate-key that loses a race (409 RUNNER_KEY_EXISTS: the key was just created elsewhere) carries on with that key', async () => {
    const f = fakeDeps({ signingKey: { ...NO_KEY, isRootOrg: false } });
    const post = f.deps.platform.post.bind(f.deps.platform);
    f.deps.platform.post = (async (url: string, data?: unknown, headers?: Record<string, string>) => {
      if (url.endsWith('/signing-key')) throw refused(409, { error: { code: 'RUNNER_KEY_EXISTS' } });
      return post(url, data, headers);
    }) as typeof f.deps.platform.post;
    const r = await setupRunnerFlow(basePlan({ generateKey: true }), f.deps);
    expect(r.signingKey).toEqual({ origin: 'existing', kid: null });
    expect(f.calls).toContain('POST /api/pipelines/runners');
  });

  it('--generate-key is a no-op when the org already has a key', async () => {
    const f = fakeDeps();
    expect((await setupRunnerFlow(basePlan({ generateKey: true }), f.deps)).signingKey).toEqual({ origin: 'existing', kid: 'kid-active-123456' });
    expect(f.calls).not.toContain('POST /api/pipelines/runners/signing-key');
  });

  it("an inheriting team uses its parent's key", async () => {
    const f = fakeDeps({ signingKey: { ...NO_KEY, mode: 'inherit', isRootOrg: false, inheritedFrom: { orgId: 'p', orgName: 'Acme Corp', activeKid: 'kid-parent', rotation: 'none' } } });
    expect((await setupRunnerFlow(basePlan(), f.deps)).signingKey).toEqual({ origin: 'inherited', kid: 'kid-parent', inheritedFrom: 'Acme Corp' });
  });

  it("an inheriting team whose parent has no key is told to ask the parent (--generate-key can't help)", async () => {
    const f = fakeDeps({ signingKey: { ...NO_KEY, mode: 'inherit', isRootOrg: false, inheritedFrom: { orgId: 'p', orgName: 'Acme Corp', activeKid: null, rotation: 'none' } } });
    await expect(setupRunnerFlow(basePlan({ generateKey: true }), f.deps)).rejects.toThrow(/"Acme Corp", which has no key yet.*Use our own key/s);
    expect(f.calls).toEqual(['GET /api/pipelines/runners', 'listRunnerStacks']);
  });

  it('an unreadable key stops before anything is created', async () => {
    const f = fakeDeps({ signingKey: { ...ACTIVE_KEY, unreadable: true } });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(KEY_UNREADABLE_MESSAGE);
    expect(f.calls).not.toContain('POST /api/pipelines/runners');
  });

  it('the result names key ids only', async () => {
    const r = await setupRunnerFlow(basePlan(), fakeDeps().deps);
    expect(JSON.stringify(r)).not.toMatch(/PRIVATE KEY|private_key|privateKey|pem/i);
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
  it('an ordinary 403 (no org_settings:write) is rethrown as-is, before touching AWS', async () => {
    const e = refused(403, { message: 'Missing permission org_settings:write', code: 'INSUFFICIENT_PERMISSIONS' });
    expect(() => explainRunnerError(e)).toThrow(e);
    const f = fakeDeps({ getError: e });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toBe(e);
    expect(f.calls).toEqual(['GET /api/pipelines/runners']);
  });

  it('available:false names the reason, before touching AWS', async () => {
    const f = fakeDeps({ available: false, unavailableReason: 'paused' });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(runnersUnavailableMessage('paused'));
    expect(runnersUnavailableMessage('paused')).toMatch(/paused/);
    expect(runnersUnavailableMessage('encryption_not_configured')).toMatch(/secret encryption/);
    expect(runnersUnavailableMessage('tables_missing')).toMatch(/runner tables/);
    expect(f.calls).toEqual(['GET /api/pipelines/runners']);
  });

  it('422 RUNNER_PING_FAILED on the PATCH → the runner stays pending; check its logs and re-run', async () => {
    const f = fakeDeps({ patchError: refused(422, { message: 'no pong', error: { code: 'RUNNER_PING_FAILED' } }) });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(/RUNNER_PING_FAILED.*stays pending.*pipeline-builder-runner-<runnerId>.*re-run setup-runner/s);
    expect((f.detail.deployStack as any[])).toHaveLength(1);
  });

  it('409 RUNNER_KEY_MISSING on the PATCH points to --generate-key and the dashboard', async () => {
    const f = fakeDeps({ patchError: refused(409, { error: { code: 'RUNNER_KEY_MISSING' } }) });
    await expect(setupRunnerFlow(basePlan(), f.deps)).rejects.toThrow(NO_ORG_KEY_MESSAGE);
  });

  it('409 RUNNER_PENDING / RUNNER_KEY_UNREADABLE / RUNNERS_UNAVAILABLE are explained', () => {
    expect(() => explainRunnerError(refused(409, { errorCode: 'RUNNER_PENDING' }))).toThrow(/still pending/);
    expect(() => explainRunnerError(refused(409, { error: { code: 'RUNNER_KEY_UNREADABLE' } }))).toThrow(KEY_UNREADABLE_MESSAGE);
    expect(() => explainRunnerError(refused(409, { error: { code: 'RUNNERS_UNAVAILABLE' } }))).toThrow(/unavailable/);
  });
});

describe('delete', () => {
  const mine = { id: 'run-1', label: 'default', status: 'active' };

  it("finds this org's runner of that label in the account, revokes it (step-up) BEFORE deleting its stack", async () => {
    const f = fakeDeps({ stacks: [stack('run-1')], own: [mine] });
    const r = await deleteRunner(basePlan({ delete: true }), f.deps);
    expect(f.calls).toEqual(['GET /api/pipelines/runners', 'listRunnerStacks', 'stepUp', 'DELETE /api/pipelines/runners/run-1', 'deleteStack']);
    expect(f.detail.deleteStack).toEqual([{ name: 'pipeline-builder-runner-run-1', region: 'us-east-1' }]);
    expect((f.detail['DELETE /api/pipelines/runners/run-1']![0] as any).headers).toEqual({ 'X-Step-Up-Token': 'su-1' });
    expect(r).toMatchObject({ action: 'deleted', runnerId: 'run-1', stackName: 'pipeline-builder-runner-run-1' });
  });

  it("never touches another org's stack, even one with the same label", async () => {
    const f = fakeDeps({ stacks: [stack('foreign', { label: 'default' })] });
    await expect(deleteRunner(basePlan({ delete: true }), f.deps)).rejects.toThrow(/No runner "default"/);
    expect(f.calls).not.toContain('deleteStack');
    expect(f.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('with no stack here, revokes a PENDING runner of that label (an install that never got its stack)', async () => {
    const f = fakeDeps({ own: [{ id: 'run-7', label: 'default', status: 'pending' }] });
    await deleteRunner(basePlan({ delete: true }), f.deps);
    expect(f.calls).toEqual(['GET /api/pipelines/runners', 'listRunnerStacks', 'stepUp', 'DELETE /api/pipelines/runners/run-7']);
  });

  it('with no stack in any enabled region, never revokes an ACTIVE runner found only by label (its stack is in another account)', async () => {
    const f = fakeDeps({ own: [{ id: 'run-7', label: 'default', status: 'active' }] });
    await expect(deleteRunner(basePlan({ delete: true }), f.deps)).rejects.toThrow(/active.*any of this account's 1 enabled regions.*another AWS account.*Pipeline runners/s);
    expect(f.calls).toEqual(['GET /api/pipelines/runners', 'listRunnerStacks']);
  });

  it('a stack in another region of the scan: re-run there', async () => {
    const f = fakeDeps({ stacks: [stack('run-1', { region: 'eu-west-2' })], own: [mine] });
    await expect(deleteRunner(basePlan({ delete: true, regions: 'us-east-1,eu-west-2' }), f.deps)).rejects.toThrow(/--region eu-west-2/);
    expect(f.calls).not.toContain('deleteStack');
  });

  it('an already-revoked runner (404) still has its stack removed; any other failure stops before the stack', async () => {
    const gone = fakeDeps({ stacks: [stack('run-1')], own: [mine], deleteError: refused(404, { message: 'Pipeline runner not found.', code: 'NOT_FOUND' }) });
    await deleteRunner(basePlan({ delete: true }), gone.deps);
    expect(gone.calls).toContain('deleteStack');
    expect(gone.warnings[0]).toMatch(/no such runner/);
    const paused = fakeDeps({ stacks: [stack('run-1')], own: [mine], deleteError: refused(409, { error: { code: 'RUNNERS_UNAVAILABLE' } }) });
    await expect(deleteRunner(basePlan({ delete: true }), paused.deps)).rejects.toThrow(/unavailable/);
    expect(paused.calls).not.toContain('deleteStack');
  });

  it('a 404 that is not the runner route\'s NOT_FOUND (a proxy or a missing route) keeps the stack of a runner the platform may still have', async () => {
    const f = fakeDeps({ stacks: [stack('run-1')], own: [mine], deleteError: refused(404, { message: 'Not Found' }) });
    await expect(deleteRunner(basePlan({ delete: true }), f.deps)).rejects.toThrow(/Not Found/);
    expect(f.calls).not.toContain('deleteStack');
  });

  it('nothing to delete is an error that names the runner this account does have', async () => {
    const f = fakeDeps({ stacks: [stack('run-1')], own: [{ id: 'run-1', label: 'ops', status: 'active' }] });
    await expect(deleteRunner(basePlan({ delete: true }), f.deps)).rejects.toThrow(/No runner "default".*your runner "ops"/s);
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
      success: true,
      dryRun: true,
      regions: ['us-east-1', 'eu-west-2'],
      pipelinePrefixes: ['acme-'],
      entryPoint: 'function-url',
      stackName: 'pipeline-builder-runner-<runnerId>',
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
    expect(flags).toEqual(expect.arrayContaining(['--with-events', '--api-gateway', '--allow-ip', '--pipeline-prefix', '--regions', '--delete', '--dry-run', '--json', '--yes', '--waf-rate-limit', '--no-waf', '--generate-key']));
  });

  it('--dry-run --api-gateway shows the WAF rate limit from --waf-rate-limit', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    program.exitOverride();
    setupRunner(program.command('infra'));
    const out: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    try {
      await program.parseAsync(['node', 'pm', 'infra', 'setup-runner', '--region', 'us-east-1', '--pipeline-prefix', 'acme-',
        '--api-gateway', '--allow-ip', '203.0.113.1/32', '--waf-rate-limit', '700', '--dry-run', '--json']);
    } finally {
      log.mockRestore();
    }
    expect(JSON.parse(out.join('\n'))).toMatchObject({ entryPoint: 'api-gateway', waf: { rateLimit: 700 } });
  });
});
