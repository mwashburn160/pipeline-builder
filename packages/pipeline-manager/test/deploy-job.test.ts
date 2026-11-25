// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pipeline-manager pipeline deploy-job` — the runner's deploy CodeBuild job
 * (commands/deploy-job.ts), every AWS / platform / cdk dependency faked:
 * KMS unwrap → grant exchange → env scrub → protocol check → fetch (through
 * the session facade) → prechecks (bootstrap version, the deploy role) →
 * the stack's state (change 2: clean a failed first deploy only when it is
 * this pipeline's; another pipeline's stack is never touched) → synth →
 * assembly checks (names, Docker assets, secrets) → deploy → registry →
 * result; and the undeploy mode (deletes only a stack tagged for this
 * pipeline). The result is always a code from the fixed list, and the grant,
 * its ciphertext and the session token never reach a log line.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  DEPLOY_JOB_PROTOCOL_VERSION, deployGrantEncryptionContext, runnerDeployPath,
} from '@pipeline-builder/api-core/pipeline-runners';

const WORK = mkdtempSync(join(tmpdir(), 'pm-deploy-job-'));
process.env.HOME = WORK;
process.env.CLI_CONFIG_PATH = join(WORK, 'none.yml');
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const { runDeployJob, deployJobCommand, MIN_CDK_BOOTSTRAP_VERSION } = await import('../src/commands/deploy-job.js');
type DeployJobDeps = import('../src/commands/deploy-job.js').DeployJobDeps;
type StackState = import('../src/commands/deploy-job.js').StackState;
const { Command } = await import('commander');

const GRANT = `pb_dg_${'G'.repeat(43)}`;
const TOKEN = `pb_ds_${'S'.repeat(43)}`;
const CIPHERTEXT = Buffer.from('kms-blob-for-the-grant-0123456789').toString('base64');
const ACCOUNT = '123456789012';

const ENV = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  PLATFORM_BASE_URL: 'https://platform.example',
  PB_RUNNER_ID: 'runner-1',
  PB_CDK_QUALIFIER: 'hnb659fds',
  PB_REQUEST_ID: 'req-1',
  PB_PIPELINE_ID: 'pipe-1',
  PB_TARGET_REGION: 'eu-west-2',
  PB_PIPELINE_NAME: 'acme-shop-pipeline',
  PB_STACK_NAME: 'shop-acme',
  PB_DEPLOY_GRANT_CIPHERTEXT: CIPHERTEXT,
  PB_TOOLCHAIN_RELEASE: '1.4.0',
  PB_DEPLOY_PROTOCOL: String(DEPLOY_JOB_PROTOCOL_VERSION),
  PB_JOB_MODE: 'deploy',
  ...over,
});
const SESSION = {
  sessionToken: TOKEN,
  expiresAt: '2026-11-25T14:00:00.000Z',
  requestId: 'req-1',
  pipelineId: 'pipe-1',
  region: 'eu-west-2',
  pipelineName: 'acme-shop-pipeline',
  stackName: 'shop-acme',
  toolchainRelease: '1.4.0',
  protocol: DEPLOY_JOB_PROTOCOL_VERSION,
};
const PIPELINE = { id: 'pipe-1', orgId: 'org-1', project: 'shop', organization: 'acme', pipelineName: 'acme-shop-pipeline' };
const PROPS = {
  project: 'shop',
  organization: 'acme',
  pipelineName: 'acme-shop-pipeline',
  pipelineId: 'pipe-1',
  orgId: 'org-1',
  resolvedBootstrap: { toolchain: { releaseVersion: '1.4.0' } },
};

/** A cloud assembly as `cdk synth` writes one. */
function writeAssembly(dir: string, opts: { stackName?: string; docker?: boolean; secrets?: string[]; env?: string } = {}): void {
  mkdirSync(dir, { recursive: true });
  const name = opts.stackName ?? 'shop-acme';
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    artifacts: { [name]: { type: 'aws:cloudformation:stack', environment: opts.env ?? 'aws://unknown-account/unknown-region', properties: { templateFile: `${name}.template.json` } } },
  }));
  writeFileSync(join(dir, `${name}.template.json`), JSON.stringify({
    Resources: {
      Synth: {
        Type: 'AWS::CodeBuild::Project',
        Properties: { Environment: { EnvironmentVariables: (opts.secrets ?? ['pipeline-builder/org-1/platform']).map((v) => ({ Name: 'PLATFORM_SECRET_NAME', Type: 'PLAINTEXT', Value: v })) } },
      },
    },
  }));
  writeFileSync(join(dir, `${name}.assets.json`), JSON.stringify({ files: {}, dockerImages: opts.docker ? { abc: {} } : {} }));
  writeFileSync(join(dir, 'pb-step-manifest.json'), JSON.stringify([{ stage: 'synth', plugin: 'cdk-synth' }]));
}

interface World {
  posts: Array<{ url: string; body?: unknown; auth?: string }>;
  calls: string[];
  stack?: StackState;
  everCompleted: boolean;
  deleteFails: boolean;
  deleted: Array<{ stackName: string; roleArn: string }>;
  assumed: string[];
}

function setup(over: Partial<DeployJobDeps> & { stack?: StackState; everCompleted?: boolean; deleteFails?: boolean; assembly?: Parameters<typeof writeAssembly>[1]; exchange?: () => unknown; facade?: (url: string, body?: unknown) => unknown; heartbeatMs?: number } = {}) {
  const dir = mkdtempSync(join(WORK, 'job-'));
  const world: World = { posts: [], calls: [], ...(over.stack ? { stack: over.stack } : {}), everCompleted: !!over.everCompleted, deleteFails: !!over.deleteFails, deleted: [], assumed: [] };
  const deps: DeployJobDeps = {
    decryptGrant: jest.fn(async () => GRANT),
    http: {
      async request(_method, url, body, headers) {
        world.posts.push({ url, ...(body !== undefined ? { body } : {}), ...(headers.Authorization ? { auth: headers.Authorization } : {}) });
        if (url === runnerDeployPath('req-1', 'session')) {
          const out = over.exchange ? over.exchange() : { data: SESSION };
          if (out instanceof Error) throw out;
          return out;
        }
        const answer = over.facade?.(url, body);
        if (answer instanceof Error) throw answer;
        return answer ?? { success: true };
      },
    },
    caller: async () => ({ accountId: ACCOUNT, partition: 'aws' }),
    bootstrapVersion: jest.fn(async () => 28),
    assumeRole: async (roleArn) => { world.assumed.push(roleArn); return { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T' }; },
    stacks: () => ({
      describe: async () => world.stack,
      everCompleted: async () => world.everCompleted,
      delete: async (stackName, roleArn) => {
        world.calls.push('delete');
        if (world.deleteFails) throw new Error('DELETE_FAILED');
        world.deleted.push({ stackName, roleArn });
        world.stack = undefined;
      },
    }),
    secretExists: jest.fn(async () => true),
    fetchPipeline: jest.fn(async () => ({ pipeline: PIPELINE, propsWithIds: { ...PROPS } })),
    synth: jest.fn(async ({ output }) => { world.calls.push('synth'); writeAssembly(output, over.assembly); }),
    deploy: jest.fn(async (input: import('../src/utils/deploy-runner.js').RunDeployInput) => { world.calls.push('deploy'); await input.register?.({ region: input.region!, output: input.output }); }),
    ...over,
  } as DeployJobDeps;
  const resultFile = join(dir, 'result.env');
  const run = (env = ENV()) => runDeployJob({ env, resultFile, output: join(dir, 'cdk.out'), deps, ...(over.heartbeatMs ? { heartbeatMs: over.heartbeatMs } : {}) });
  const stages = () => world.posts.filter((p) => p.url.endsWith('/progress')).map((p) => (p.body as { stage: string }).stage);
  const result = () => world.posts.find((p) => p.url.endsWith('/result'))?.body;
  return { world, deps, run, resultFile, dir, stages, result };
}

const tagged = (status: string, pipelineId: string | null = 'pipe-1'): StackState => ({ status, tags: pipelineId ? { 'pb.pipeline-id': pipelineId } : {} });
const awsError = (name: string) => Object.assign(new Error(name), { name });
/** The facade's answer once the platform wiped the session (deploy cancelled or past its deadline). */
const sessionGone = () => Object.assign(new Error('Request failed with status code 401'), { response: { status: 401, data: { code: 'DEPLOY_SESSION_INVALID' } } });

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const m of ['log', 'error', 'warn', 'info'] as const) {
    jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
  }
  jest.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { logged.push(String(s)); return true; }) as never);
});

describe('deploy mode: the happy path', () => {
  it('unwraps the grant, exchanges it, deploys the inspected assembly, registers, and reports OK / done', async () => {
    const t = setup();
    const env = ENV();
    const r = await t.run(env);
    expect(r).toEqual({ code: 'OK', stage: 'done' });

    expect(t.deps.decryptGrant).toHaveBeenCalledWith(CIPHERTEXT, deployGrantEncryptionContext('runner-1', 'req-1'));
    // The job's own request id: KMS refuses a ciphertext wrapped for another request.
    expect((t.deps.decryptGrant as jest.Mock).mock.calls[0]![1]).toMatchObject({ requestId: 'req-1' });
    expect(t.world.posts[0]).toEqual({ url: runnerDeployPath('req-1', 'session'), body: { grant: GRANT } });
    // Every later call carries the session token, never the grant.
    for (const p of t.world.posts.slice(1)) {
      expect(p.auth).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(p.body ?? {})).not.toContain(GRANT);
    }
    expect(t.stages()).toEqual(['fetching', 'prechecking', 'synthesizing', 'deploying', 'registering']);
    expect(t.result()).toEqual({ code: 'OK', stage: 'done' });

    const deployInput = (t.deps.deploy as jest.Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(deployInput).toMatchObject({ region: 'eu-west-2', requireApproval: 'never', app: join(t.dir, 'cdk.out') });
    expect(deployInput.output).not.toBe(deployInput.app);
    expect(t.world.posts.find((p) => p.url.endsWith('/registry'))!.body).toEqual({
      pipelineName: 'acme-shop-pipeline', stackName: 'shop-acme', region: 'eu-west-2', steps: [{ stage: 'synth', plugin: 'cdk-synth' }],
    });
    expect(t.deps.bootstrapVersion).toHaveBeenCalledWith('eu-west-2', 'hnb659fds');
    expect(t.deps.secretExists).toHaveBeenCalledWith('pipeline-builder/org-1/platform', 'eu-west-2');
    // The deploy role (and the file-publishing role cdk uploads the template with) are assumed before anything changes.
    expect(t.world.assumed).toEqual([
      `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-deploy-role-${ACCOUNT}-eu-west-2`,
      `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-file-publishing-role-${ACCOUNT}-eu-west-2`,
    ]);
    expect(t.world.calls).toEqual(['synth', 'deploy']);
  });

  it('scrubs the ciphertext from the env before anything runs, and writes the result file (0600) for the buildspec to export', async () => {
    const t = setup();
    const env = ENV();
    let seen: unknown = 'not checked';
    (t.deps.fetchPipeline as jest.Mock).mockImplementation(async () => { seen = env.PB_DEPLOY_GRANT_CIPHERTEXT; return { pipeline: PIPELINE, propsWithIds: { ...PROPS } }; });
    await t.run(env);
    expect(seen).toBeUndefined();
    expect(env.PB_DEPLOY_GRANT_CIPHERTEXT).toBeUndefined();
    expect(readFileSync(t.resultFile, 'utf-8')).toBe('PB_DEPLOY_RESULT=OK\nPB_DEPLOY_STAGE=done\n');
    expect((statSync(t.resultFile).mode % 0o1000).toString(8)).toBe('600');
  });

  it('never logs the grant, its ciphertext or the session token', async () => {
    const t = setup();
    await t.run();
    const all = logged.join('\n');
    expect(all).not.toContain(GRANT);
    expect(all).not.toContain(CIPHERTEXT);
    expect(all).not.toContain(TOKEN);
  });

  it('a failed registry post does not fail a deploy that succeeded (the platform\'s deployed fallback registers)', async () => {
    const t = setup({
      http: {
        async request(_m, url) {
          if (url.endsWith('/session')) return { data: SESSION };
          if (url.endsWith('/registry')) throw Object.assign(new Error('503'), { response: { status: 503 } });
          return {};
        },
      },
    });
    expect(await t.run()).toEqual({ code: 'OK', stage: 'done' });
  });
});

describe('deploy mode: refusals, each with its code', () => {
  it.each([
    ['the env protocol', { PB_DEPLOY_PROTOCOL: String(DEPLOY_JOB_PROTOCOL_VERSION + 1) }, {}],
    ['the session protocol', {}, { protocol: DEPLOY_JOB_PROTOCOL_VERSION + 1 }],
  ])('%s is not this image\'s: DEPLOY_JOB_PROTOCOL_MISMATCH, nothing fetched', async (_n, envOver, sessionOver) => {
    const t = setup({ exchange: () => ({ data: { ...SESSION, ...sessionOver } }) });
    expect(await t.run(ENV(envOver))).toMatchObject({ code: 'DEPLOY_JOB_PROTOCOL_MISMATCH' });
    expect(t.deps.fetchPipeline).not.toHaveBeenCalled();
    expect(t.result()).toMatchObject({ code: 'DEPLOY_JOB_PROTOCOL_MISMATCH' });
  });

  it.each([
    ['expired', 'DEPLOY_GRANT_EXPIRED'],
    ['reused', 'DEPLOY_GRANT_REJECTED'],
    ['wrong_state', 'DEPLOY_GRANT_REJECTED'],
  ])('a grant refused as %s: %s (no session, so no result post — the exported result tells)', async (reason, code) => {
    const t = setup({ exchange: () => Object.assign(new Error('401'), { response: { status: 401, data: { code: 'DEPLOY_GRANT_INVALID', details: { reason } } } }) });
    expect(await t.run()).toEqual({ code, stage: 'authenticating' });
    expect(t.result()).toBeUndefined();
    expect(readFileSync(t.resultFile, 'utf-8')).toBe(`PB_DEPLOY_RESULT=${code}\nPB_DEPLOY_STAGE=authenticating\n`);
  });

  it('the platform unreachable at the exchange: PIPELINE_FETCH_FAILED (retryable)', async () => {
    const t = setup({ exchange: () => new Error('ECONNREFUSED') });
    expect(await t.run()).toEqual({ code: 'PIPELINE_FETCH_FAILED', stage: 'authenticating' });
  });

  it.each([
    ['a ciphertext KMS will not open', awsError('InvalidCiphertextException'), 'DEPLOY_GRANT_REJECTED'],
    ['the key policy refusing the deploy role', awsError('AccessDeniedException'), 'DEPLOY_PERMISSION_DENIED'],
  ])('%s: %s, the grant never exchanged', async (_n, err, code) => {
    const t = setup({ decryptGrant: async () => { throw err; } });
    expect(await t.run()).toMatchObject({ code });
    expect(t.world.posts).toEqual([]);
  });

  it('a session for other names than the request\'s: DEPLOY_TARGET_MISMATCH', async () => {
    const t = setup({ exchange: () => ({ data: { ...SESSION, stackName: 'other-stack' } }) });
    expect(await t.run()).toMatchObject({ code: 'DEPLOY_TARGET_MISMATCH' });
    expect(t.deps.fetchPipeline).not.toHaveBeenCalled();
  });

  it.each([
    ['another pipeline record', { pipeline: { ...PIPELINE, id: 'pipe-2' }, propsWithIds: { ...PROPS } }],
    ['props that would tag the stack for another pipeline', { pipeline: PIPELINE, propsWithIds: { ...PROPS, pipelineId: 'pipe-2' } }],
  ])('the session answering with %s: DEPLOY_TARGET_MISMATCH, nothing synthesized', async (_n, fetched) => {
    const t = setup({ fetchPipeline: jest.fn(async () => fetched) as DeployJobDeps['fetchPipeline'] });
    expect(await t.run()).toEqual({ code: 'DEPLOY_TARGET_MISMATCH', stage: 'fetching' });
    expect(t.world.calls).toEqual([]);
  });

  it('the pipeline unreadable through the session: PIPELINE_FETCH_FAILED; a plugin that does not resolve: PLUGIN_RESOLUTION_FAILED', async () => {
    const t = setup({ fetchPipeline: async () => { throw new Error('503'); } });
    expect(await t.run()).toEqual({ code: 'PIPELINE_FETCH_FAILED', stage: 'fetching' });
    const { PluginResolutionError } = await import('../src/utils/plugin-resolver.js');
    const u = setup({ fetchPipeline: async () => { throw new PluginResolutionError([{ plugin: 'x', code: 'PLUGIN_NOT_FOUND', message: 'm' }]); } });
    expect(await u.run()).toEqual({ code: 'PLUGIN_RESOLUTION_FAILED', stage: 'fetching' });
  });

  it.each([
    ['another pipeline name', { pipelineName: 'acme-other-pipeline' }],
    ['another project (another stack name)', { project: 'other' }],
    ['another toolchain release than the image\'s', { resolvedBootstrap: { toolchain: { releaseVersion: '1.5.0' } } }],
  ])('a definition that now names %s: DEPLOY_TARGET_MISMATCH, nothing synthesized', async (_n, propsOver) => {
    const t = setup({ fetchPipeline: async () => ({ pipeline: PIPELINE, propsWithIds: { ...PROPS, ...propsOver } }) });
    expect(await t.run()).toMatchObject({ code: 'DEPLOY_TARGET_MISMATCH', stage: 'fetching' });
    expect(t.world.calls).toEqual([]);
  });

  it('no CDK bootstrap in the region: CDK_NOT_BOOTSTRAPPED; an old one: CDK_BOOTSTRAP_OUTDATED', async () => {
    const t = setup({ bootstrapVersion: async () => undefined });
    expect(await t.run()).toEqual({ code: 'CDK_NOT_BOOTSTRAPPED', stage: 'prechecking' });
    const u = setup({ bootstrapVersion: async () => MIN_CDK_BOOTSTRAP_VERSION - 1 });
    expect(await u.run()).toEqual({ code: 'CDK_BOOTSTRAP_OUTDATED', stage: 'prechecking' });
    expect(u.world.calls).toEqual([]);
  });

  it('a bootstrap role the deploy role cannot assume: DEPLOY_PERMISSION_DENIED', async () => {
    const t = setup({ assumeRole: async () => { throw awsError('AccessDenied'); } });
    expect(await t.run()).toEqual({ code: 'DEPLOY_PERMISSION_DENIED', stage: 'prechecking' });
  });

  it('a Docker image asset in the assembly (the build is not privileged): DEPLOY_NEEDS_PRIVILEGED, nothing deployed', async () => {
    const t = setup({ assembly: { docker: true } });
    expect(await t.run()).toEqual({ code: 'DEPLOY_NEEDS_PRIVILEGED', stage: 'synthesizing' });
    expect(t.world.calls).toEqual(['synth']);
  });

  it('a synthesized stack of another name, or for another region: DEPLOY_TARGET_MISMATCH', async () => {
    expect(await setup({ assembly: { stackName: 'renamed' } }).run()).toMatchObject({ code: 'DEPLOY_TARGET_MISMATCH', stage: 'synthesizing' });
    expect(await setup({ assembly: { env: `aws://${ACCOUNT}/us-east-1` } }).run()).toMatchObject({ code: 'DEPLOY_TARGET_MISMATCH' });
    expect(await setup({ assembly: { env: `aws://${ACCOUNT}/eu-west-2` } }).run()).toMatchObject({ code: 'OK' });
  });

  it('a secret the pipeline needs is not in the account: ACCOUNT_SECRETS_MISSING, nothing deployed', async () => {
    const t = setup({ assembly: { secrets: ['pipeline-builder/org-1/platform', 'pipeline-builder/org-1/sonar'] }, secretExists: async (n) => n.endsWith('/platform') });
    expect(await t.run()).toEqual({ code: 'ACCOUNT_SECRETS_MISSING', stage: 'synthesizing' });
    expect(t.world.calls).toEqual(['synth']);
  });

  it('cdk deploy failing: CFN_DEPLOY_FAILED', async () => {
    const t = setup({ deploy: async () => { throw new Error('cdk deploy exited 1'); } });
    expect(await t.run()).toEqual({ code: 'CFN_DEPLOY_FAILED', stage: 'deploying' });
    expect(t.result()).toEqual({ code: 'CFN_DEPLOY_FAILED', stage: 'deploying' });
  });

  it('a plain-http PLATFORM_BASE_URL in production: DEPLOY_JOB_ERROR before the grant is unwrapped or sent', async () => {
    const t = setup();
    expect(await t.run(ENV({ PLATFORM_BASE_URL: 'http://platform.example', NODE_ENV: 'production' }))).toMatchObject({ code: 'DEPLOY_JOB_ERROR', stage: 'starting' });
    expect(t.deps.decryptGrant).not.toHaveBeenCalled();
    expect(t.world.posts).toEqual([]);
  });

  it('a missing job setting: DEPLOY_JOB_ERROR before any call', async () => {
    const t = setup();
    expect(await t.run(ENV({ PB_REQUEST_ID: undefined }))).toMatchObject({ code: 'DEPLOY_JOB_ERROR', stage: 'starting' });
    expect(t.deps.decryptGrant).not.toHaveBeenCalled();
    expect(await t.run(ENV({ PB_JOB_MODE: 'destroy' }))).toMatchObject({ code: 'DEPLOY_JOB_ERROR' });
  });
});

describe('change 2: the target stack\'s state before deploying', () => {
  it('absent: deploys, nothing deleted', async () => {
    const t = setup();
    expect((await t.run()).code).toBe('OK');
    expect(t.world.deleted).toEqual([]);
  });

  it('ROLLBACK_COMPLETE, tagged for THIS pipeline (a failed first deploy): deleted through the bootstrap roles, then deployed', async () => {
    const t = setup({ stack: tagged('ROLLBACK_COMPLETE') });
    expect(await t.run()).toEqual({ code: 'OK', stage: 'done' });
    expect(t.world.deleted).toEqual([{ stackName: 'shop-acme', roleArn: `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-eu-west-2` }]);
    expect(t.stages()).toEqual(['fetching', 'prechecking', 'cleaning', 'synthesizing', 'deploying', 'registering']);
    expect(t.world.calls).toEqual(['delete', 'synth', 'deploy']);
  });

  it('DELETE_FAILED, this pipeline\'s, never completed: cleaned the same way', async () => {
    const t = setup({ stack: tagged('DELETE_FAILED'), everCompleted: false });
    expect((await t.run()).code).toBe('OK');
    expect(t.world.deleted).toHaveLength(1);
  });

  it('DELETE_FAILED, this pipeline\'s, but it once completed (a real pipeline): STACK_DELETE_FAILED, never deleted here', async () => {
    const t = setup({ stack: tagged('DELETE_FAILED'), everCompleted: true });
    expect(await t.run()).toEqual({ code: 'STACK_DELETE_FAILED', stage: 'prechecking' });
    expect(t.world.calls).toEqual([]);
  });

  it('the cleanup not reaching DELETE_COMPLETE: STACK_DELETE_FAILED', async () => {
    const t = setup({ stack: tagged('ROLLBACK_COMPLETE'), deleteFails: true });
    expect(await t.run()).toEqual({ code: 'STACK_DELETE_FAILED', stage: 'cleaning' });
    expect(t.world.calls).toEqual(['delete']);
  });

  it.each([
    ['tagged for ANOTHER pipeline', tagged('CREATE_COMPLETE', 'pipe-2')],
    ['tagged for another pipeline, even when rolled back', tagged('ROLLBACK_COMPLETE', 'pipe-2')],
    ['an untagged stack of that name', tagged('CREATE_COMPLETE', null)],
    ['an untagged rolled-back stack', tagged('ROLLBACK_COMPLETE', null)],
  ])('%s: STACK_OWNED_BY_OTHER_PIPELINE, never touched', async (_n, stack) => {
    const t = setup({ stack });
    expect(await t.run()).toEqual({ code: 'STACK_OWNED_BY_OTHER_PIPELINE', stage: 'prechecking' });
    expect(t.world.calls).toEqual([]);
  });

  it('a stack of that name created by another pipeline WHILE this job synthesized: STACK_OWNED_BY_OTHER_PIPELINE, never deployed over', async () => {
    const t = setup({
      synth: jest.fn(async ({ output }: { output: string }) => {
        writeAssembly(output);
        t.world.stack = tagged('CREATE_IN_PROGRESS', 'pipe-2');
      }) as DeployJobDeps['synth'],
    });
    expect((await t.run()).code).toBe('STACK_OWNED_BY_OTHER_PIPELINE');
    expect(t.deps.deploy).not.toHaveBeenCalled();
  });

  it('this pipeline\'s healthy stack (deployed, never registered): deployed over in place', async () => {
    const t = setup({ stack: tagged('CREATE_COMPLETE') });
    expect((await t.run()).code).toBe('OK');
    expect(t.world.deleted).toEqual([]);
  });
});

describe('the session wiped (401 from the facade: cancelled or past the deadline)', () => {
  it('a 401 on the pipeline read: DEPLOY_CANCELLED, nothing synthesized or deployed', async () => {
    // Through the session client, as fetchPipelineProps reads it.
    const t = setup({
      facade: (url) => (url.endsWith('/pipeline') ? sessionGone() : undefined),
      fetchPipeline: jest.fn(async (client: import('../src/utils/api-client.js').PlatformReadClient) => {
        await client.get('/api/pipelines/pipe-1');
        return { pipeline: PIPELINE, propsWithIds: { ...PROPS } };
      }) as DeployJobDeps['fetchPipeline'],
    });
    expect(await t.run()).toEqual({ code: 'DEPLOY_CANCELLED', stage: 'fetching' });
    expect(t.world.calls).toEqual([]);
  });

  it('a 401 on the progress post right before cdk deploy: DEPLOY_CANCELLED, cdk deploy never starts', async () => {
    const t = setup({
      facade: (url, body) => (url.endsWith('/progress') && (body as { stage?: string })?.stage === 'deploying' ? sessionGone() : undefined),
    });
    expect(await t.run()).toEqual({ code: 'DEPLOY_CANCELLED', stage: 'deploying' });
    expect(t.deps.deploy).not.toHaveBeenCalled();
  });

  it('a 401 on any earlier progress post stops the job there', async () => {
    const t = setup({ facade: (url) => (url.endsWith('/progress') ? sessionGone() : undefined) });
    expect(await t.run()).toEqual({ code: 'DEPLOY_CANCELLED', stage: 'fetching' });
    expect(t.deps.fetchPipeline).not.toHaveBeenCalled();
  });

  it('a 401 on the heartbeat WHILE cdk deploy runs aborts cdk: DEPLOY_CANCELLED, never registered', async () => {
    let wiped = false;
    let seenSignal: AbortSignal | undefined;
    const t = setup({
      heartbeatMs: 20,
      facade: (url) => (wiped && url.endsWith('/progress') ? sessionGone() : undefined),
      deploy: jest.fn(async (input: import('../src/utils/deploy-runner.js').RunDeployInput) => {
        seenSignal = input.signal;
        wiped = true; // the platform cancels mid-deploy
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          input.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
        });
        await input.register?.({ region: input.region!, output: input.output });
      }) as DeployJobDeps['deploy'],
    });
    const started = Date.now();
    expect(await t.run()).toEqual({ code: 'DEPLOY_CANCELLED', stage: 'deploying' });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(seenSignal?.aborted).toBe(true);
    expect(t.world.posts.some((p) => p.url.endsWith('/registry'))).toBe(false);
  });

  it('a heartbeat that fails for another reason (5xx, network) does not stop cdk', async () => {
    let seenSignal: AbortSignal | undefined;
    const t = setup({
      heartbeatMs: 10,
      facade: (url, body) => (url.endsWith('/progress') && (body as { stage?: string })?.stage === 'deploying' && seenSignal
        ? Object.assign(new Error('503'), { response: { status: 503 } }) : undefined),
      deploy: jest.fn(async (input: import('../src/utils/deploy-runner.js').RunDeployInput) => {
        seenSignal = input.signal;
        await new Promise((r) => setTimeout(r, 80));
      }) as DeployJobDeps['deploy'],
    });
    expect((await t.run()).code).toBe('OK');
    expect(seenSignal?.aborted).toBe(false);
  });

  it('undeploy: a 401 before the delete stops it, the stack untouched', async () => {
    const t = setup({ stack: tagged('UPDATE_COMPLETE'), facade: (url, body) => (url.endsWith('/progress') && (body as { stage?: string })?.stage === 'removing' ? sessionGone() : undefined) });
    expect(await t.run(ENV({ PB_JOB_MODE: 'undeploy' }))).toEqual({ code: 'DEPLOY_CANCELLED', stage: 'removing' });
    expect(t.world.calls).toEqual([]);
  });
});

describe('undeploy mode', () => {
  const UNDEPLOY = () => ENV({ PB_JOB_MODE: 'undeploy' });

  it('deletes the stack only when it is tagged for this pipeline; never fetches or synthesizes', async () => {
    const t = setup({ stack: tagged('UPDATE_COMPLETE') });
    expect(await t.run(UNDEPLOY())).toEqual({ code: 'OK', stage: 'done' });
    expect(t.world.deleted).toEqual([{ stackName: 'shop-acme', roleArn: `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-eu-west-2` }]);
    expect(t.stages()).toEqual(['prechecking', 'removing']);
    expect(t.deps.fetchPipeline).not.toHaveBeenCalled();
    expect(t.world.calls).toEqual(['delete']);
  });

  it('already gone: OK, nothing to delete', async () => {
    const t = setup();
    expect(await t.run(UNDEPLOY())).toEqual({ code: 'OK', stage: 'done' });
    expect(t.world.calls).toEqual([]);
  });

  it.each([
    ['another pipeline\'s stack', tagged('CREATE_COMPLETE', 'pipe-2')],
    ['an untagged stack', tagged('CREATE_COMPLETE', null)],
  ])('%s of that name: STACK_OWNED_BY_OTHER_PIPELINE, never deleted', async (_n, stack) => {
    const t = setup({ stack });
    expect(await t.run(UNDEPLOY())).toEqual({ code: 'STACK_OWNED_BY_OTHER_PIPELINE', stage: 'removing' });
    expect(t.world.calls).toEqual([]);
  });

  it('a delete that fails: STACK_DELETE_FAILED', async () => {
    const t = setup({ stack: tagged('CREATE_COMPLETE'), deleteFails: true });
    expect(await t.run(UNDEPLOY())).toEqual({ code: 'STACK_DELETE_FAILED', stage: 'removing' });
  });
});

describe('the command', () => {
  it('`pipeline deploy-job --protocol` prints the deploy-job protocol this CLI speaks, and nothing else', async () => {
    const out: string[] = [];
    (process.stdout.write as unknown as jest.Mock).mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
    (console.log as unknown as jest.Mock).mockImplementation((...a: unknown[]) => { out.push(`${a.join(' ')}\n`); });
    const program = new Command();
    program.exitOverride();
    deployJobCommand(program.command('pipeline'));
    await program.parseAsync(['node', 'pm', 'pipeline', 'deploy-job', '--protocol']);
    expect(out.join('')).toBe(`${DEPLOY_JOB_PROTOCOL_VERSION}\n`);
  });

  it('is hidden from help (an operator never runs it)', () => {
    const program = new Command();
    const pipeline = program.command('pipeline');
    deployJobCommand(pipeline);
    expect(pipeline.helpInformation()).not.toContain('deploy-job');
  });
});
