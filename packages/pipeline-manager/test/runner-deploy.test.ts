// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner's DEPLOY actions (deploy / deploy_status / deploy_cancel /
 * undeploy, opt-in with EnableDeploy): the capability it advertises, the
 * allowlist, the already-deployed check, the idempotent StartBuild (token =
 * jti, the in-progress scan), the KMS-wrapped grant (the cleartext never
 * reaches a CodeBuild override or a log line), only the job's own env names
 * overridden, and the ownership checks on status / cancel — every AWS / HTTP
 * dependency faked.
 */

import { describe, it, expect } from '@jest/globals';
import {
  DEPLOY_JOB_ENV, DEPLOY_JOB_OVERRIDE_ENV, deployGrantEncryptionContext, deployProjectName,
} from '@pipeline-builder/api-core/pipeline-runners';
import { awsError, claims, clock, fakeFetch, fakeSender, makeKey, signJws, type SentCommand } from './helpers/runner-fixtures.js';

const { createRunner, configFromEnv, accountFromFunctionArn } = await import('../src/lambda/runner-handler.js');
type RunnerConfig = import('../src/lambda/runner-handler.js').RunnerConfig;

const ACCOUNT = '123456789012';
const FN_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:pipeline-builder-runner-runner-1`;
const key = makeKey('k1');
const PROJECT = deployProjectName('runner-1');
const GRANT = `pb_dg_${'G'.repeat(43)}`;
const DIGEST = `sha256:${'d'.repeat(64)}`;
const CIPHERTEXT = Buffer.from('kms-wrapped-grant-blob-0123456789').toString('base64');
const KEY_ARN = `arn:aws:kms:us-east-1:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`;
const BUILD = (uuid = '0f3b8c1e-9d4a-4e6f-8a7b-1c2d3e4f5a6b') => `${PROJECT}:${uuid}`;

const deployBlock = (over: Record<string, unknown> = {}) => ({
  grant: GRANT,
  protocol: 1,
  mode: 'deploy',
  region: 'eu-west-2',
  pipelineName: 'acme-shop-pipeline',
  stackName: 'shop-acme',
  image: { repository: 'system/cdk-synth', digest: DIGEST },
  toolchainRelease: '1.4.0',
  ...over,
});

type Responder = (name: string, input: any, region?: string) => unknown;

interface BuildFake { id: string; projectName?: string; buildStatus?: string; env?: Record<string, string>; exported?: Record<string, string>; phases?: Array<{ phaseType: string; phaseStatus?: string }> }
const asBuild = (b: BuildFake) => ({
  id: b.id,
  projectName: b.projectName ?? PROJECT,
  buildStatus: b.buildStatus ?? 'IN_PROGRESS',
  environment: { environmentVariables: Object.entries(b.env ?? {}).map(([name, value]) => ({ name, value, type: 'PLAINTEXT' })) },
  ...(b.exported ? { exportedEnvironmentVariables: Object.entries(b.exported).map(([name, value]) => ({ name, value })) } : {}),
  ...(b.phases ? { phases: b.phases } : {}),
});

/** A CodeBuild fake over a list of builds (newest first), answering StartBuild with `started`. */
function codebuildFake(builds: BuildFake[] = [], opts: { start?: () => unknown; stop?: () => unknown } = {}): Responder {
  return (name, input) => {
    if (name === 'ListBuildsForProjectCommand') return { ids: builds.map((b) => b.id) };
    if (name === 'BatchGetBuildsCommand') {
      const found = (input.ids as string[]).map((id) => builds.find((b) => b.id === id)).filter(Boolean) as BuildFake[];
      return { builds: found.map(asBuild), buildsNotFound: (input.ids as string[]).filter((id) => !builds.some((b) => b.id === id)) };
    }
    if (name === 'StartBuildCommand') return opts.start ? opts.start() : { build: { id: BUILD('11111111-2222-4333-8444-555555555555') } };
    if (name === 'StopBuildCommand') return opts.stop ? opts.stop() : { build: { id: input.id, buildStatus: 'IN_PROGRESS' } };
    throw new Error(`unexpected codebuild ${name}`);
  };
}

function setup(opts: { config?: Partial<RunnerConfig>; deploy?: Partial<RunnerConfig['deploy']>; tagging?: Responder; codebuild?: Responder; kms?: Responder } = {}) {
  const c = clock();
  const aws: SentCommand[] = [];
  const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const f = fakeFetch({ '/api/pipelines/runner/runners/runner-1/jwks.json': () => ({ status: 200, body: { keys: [key.jwk] } }) });
  const config: RunnerConfig = {
    runnerId: 'runner-1',
    platformBaseUrl: 'https://platform.example',
    allowedRegions: ['us-east-1', 'eu-west-2'],
    allowedPrefixes: ['acme-'],
    version: '9.9.9',
    deploy: {
      enabled: true,
      projectName: PROJECT,
      registryPullHost: 'registry.example.com',
      registryCredentialSecret: 'pipeline-builder/org-1/registry-push',
      grantKeyArn: KEY_ARN,
      ...opts.deploy,
    },
    ...opts.config,
  };
  const runner = createRunner(config, {
    fetch: f.fn,
    now: c.now,
    tagging: (region) => fakeSender(opts.tagging ?? (() => ({ ResourceTagMappingList: [] })), aws, region),
    codepipeline: (region) => fakeSender(() => ({}), aws, region),
    codebuild: () => fakeSender(opts.codebuild ?? codebuildFake(), aws, 'stack'),
    kms: () => fakeSender(opts.kms ?? (() => ({ CiphertextBlob: Buffer.from(CIPHERTEXT, 'base64') })), aws, 'stack'),
    log: (level, msg, data) => { logs.push({ level, msg, ...(data ? { data } : {}) }); },
  });
  const account = accountFromFunctionArn(FN_ARN)!;
  const send = (cl: Record<string, unknown>, jti = 'req-1') => runner.process(signJws(key, claims({ ...cl, jti })), { account });
  return { aws, logs, runner, send };
}

const deploy = (over: Record<string, unknown> = {}) => ({ action: 'deploy', deploy: deployBlock(over) });
const names = (aws: SentCommand[]) => aws.map((a) => a.name);

describe('capability', () => {
  it('a pong advertises deploy:1 and the prefix allowlist when deploys are enabled', async () => {
    const t = setup();
    expect(await t.send({ action: 'ping', pipelineId: undefined })).toEqual({
      status: 200,
      body: { outcome: 'pong', regions: ['us-east-1', 'eu-west-2'], capabilities: ['deploy:1'], pipelinePrefixes: ['acme-'], runnerVersion: '9.9.9' },
    });
  });

  it('…and no capability without EnableDeploy (the prefixes are still reported)', async () => {
    const t = setup({ deploy: { enabled: false } });
    expect((await t.send({ action: 'ping', pipelineId: undefined })).body).toMatchObject({ capabilities: [], pipelinePrefixes: ['acme-'] });
  });

  it.each([
    ['deploy', deploy()],
    ['undeploy', { action: 'undeploy', deploy: deployBlock({ mode: 'undeploy' }) }],
    ['deploy_status', { action: 'deploy_status', deployRequestId: 'req-0', buildId: BUILD() }],
    ['deploy_cancel', { action: 'deploy_cancel', deployRequestId: 'req-0', buildId: BUILD() }],
  ])('%s without EnableDeploy: 403 DEPLOY_NOT_ENABLED before any AWS call', async (_n, cl) => {
    const t = setup({ deploy: { enabled: false } });
    expect(await t.send(cl)).toEqual({ status: 403, body: { errorCode: 'DEPLOY_NOT_ENABLED', runnerVersion: '9.9.9' } });
    expect(t.aws).toEqual([]);
  });
});

describe('deploy', () => {
  it('starts ONE build: token = jti, the stack\'s pull host + the claim\'s digest, the stack\'s credential, only the job\'s env — and the grant only KMS-wrapped', async () => {
    const t = setup();
    const r = await t.send(deploy());
    expect(r).toEqual({ status: 200, body: { outcome: 'deploying', buildId: BUILD('11111111-2222-4333-8444-555555555555'), runnerVersion: '9.9.9' } });

    const enc = t.aws.find((a) => a.name === 'EncryptCommand')!;
    expect(enc.input).toEqual({ KeyId: KEY_ARN, Plaintext: Buffer.from(GRANT, 'utf8'), EncryptionContext: deployGrantEncryptionContext('runner-1', 'req-1') });
    expect(enc.input.EncryptionContext).toMatchObject({ requestId: 'req-1' });

    const start = t.aws.find((a) => a.name === 'StartBuildCommand')!;
    expect(Object.keys(start.input).sort()).toEqual([
      'environmentVariablesOverride', 'idempotencyToken', 'imageOverride', 'imagePullCredentialsTypeOverride', 'projectName', 'registryCredentialOverride',
    ]);
    expect(start.input).toMatchObject({
      projectName: PROJECT,
      idempotencyToken: 'req-1',
      imageOverride: `registry.example.com/system/cdk-synth@${DIGEST}`,
      imagePullCredentialsTypeOverride: 'SERVICE_ROLE',
      registryCredentialOverride: { credential: 'pipeline-builder/org-1/registry-push', credentialProvider: 'SECRETS_MANAGER' },
    });
    const env = Object.fromEntries((start.input.environmentVariablesOverride as Array<{ name: string; value: string; type: string }>).map((v) => {
      expect(v.type).toBe('PLAINTEXT');
      return [v.name, v.value];
    }));
    expect(Object.keys(env).sort()).toEqual([...DEPLOY_JOB_OVERRIDE_ENV].sort());
    expect(env).toEqual({
      [DEPLOY_JOB_ENV.requestId]: 'req-1',
      [DEPLOY_JOB_ENV.pipelineId]: 'pipe-1',
      [DEPLOY_JOB_ENV.region]: 'eu-west-2',
      [DEPLOY_JOB_ENV.pipelineName]: 'acme-shop-pipeline',
      [DEPLOY_JOB_ENV.stackName]: 'shop-acme',
      [DEPLOY_JOB_ENV.grantCiphertext]: CIPHERTEXT,
      [DEPLOY_JOB_ENV.toolchainRelease]: '1.4.0',
      [DEPLOY_JOB_ENV.protocol]: '1',
      [DEPLOY_JOB_ENV.mode]: 'deploy',
    });
    // The cleartext grant reaches neither the build (visible to BatchGetBuilds / CloudTrail) nor a log line.
    expect(JSON.stringify(start.input)).not.toContain(GRANT);
    expect(JSON.stringify(t.logs)).not.toContain(GRANT);
    expect(JSON.stringify(t.logs)).not.toContain(CIPHERTEXT);
    expect(JSON.stringify(r)).not.toContain(GRANT);
  });

  it('the image host is the stack\'s, whatever the claim says (only repository + digest come from the request)', async () => {
    const t = setup({ deploy: { registryPullHost: 'reg.internal:8443' } });
    await t.send(deploy());
    expect(t.aws.find((a) => a.name === 'StartBuildCommand')!.input.imageOverride).toBe(`reg.internal:8443/system/cdk-synth@${DIGEST}`);
  });

  it.each([
    ['a region outside ALLOWED_REGIONS', { region: 'ap-south-1' }],
    ['a pipeline name outside ALLOWED_PIPELINE_PREFIXES', { pipelineName: 'other-shop-pipeline' }],
  ])('%s: RUNNER_REFUSED, no build', async (_n, over) => {
    const t = setup();
    expect(await t.send(deploy(over))).toEqual({ status: 403, body: { errorCode: 'RUNNER_REFUSED', runnerVersion: '9.9.9' } });
    expect(names(t.aws).filter((n) => /Build|Encrypt/.test(n))).toEqual([]);
  });

  it('a pipeline already tagged with this id in the account: PIPELINE_ALREADY_DEPLOYED, no build', async () => {
    const t = setup({
      tagging: (_n, _i, region) => ({ ResourceTagMappingList: region === 'us-east-1' ? [{ ResourceARN: `arn:aws:codepipeline:us-east-1:${ACCOUNT}:acme-shop-pipeline` }] : [] }),
    });
    expect(await t.send(deploy())).toEqual({ status: 409, body: { errorCode: 'PIPELINE_ALREADY_DEPLOYED', runnerVersion: '9.9.9' } });
    expect(names(t.aws)).not.toContain('StartBuildCommand');
    expect(names(t.aws)).not.toContain('EncryptCommand');
  });

  it('a redelivery whose build is already running returns THAT build (no second StartBuild, no new ciphertext)', async () => {
    const running = BUILD('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const t = setup({ codebuild: codebuildFake([{ id: running, env: { PB_REQUEST_ID: 'req-1', PB_PIPELINE_ID: 'pipe-1' } }]) });
    expect(await t.send(deploy())).toEqual({ status: 200, body: { outcome: 'deploying', buildId: running, runnerVersion: '9.9.9' } });
    expect(names(t.aws)).not.toContain('StartBuildCommand');
    expect(names(t.aws)).not.toContain('EncryptCommand');
    expect(t.aws.find((a) => a.name === 'ListBuildsForProjectCommand')!.input).toEqual({ projectName: PROJECT, sortOrder: 'DESCENDING' });
  });

  it('a redelivery after its build FINISHED returns that build (CodeBuild\'s 5-minute idempotency token has lapsed; a second build would burn the single-use grant)', async () => {
    const done = BUILD('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const t = setup({ codebuild: codebuildFake([{ id: done, buildStatus: 'FAILED', env: { PB_REQUEST_ID: 'req-1', PB_PIPELINE_ID: 'pipe-1' } }]) });
    expect(await t.send(deploy())).toEqual({ status: 200, body: { outcome: 'deploying', buildId: done, runnerVersion: '9.9.9' } });
    expect(names(t.aws)).not.toContain('StartBuildCommand');
    expect(names(t.aws)).not.toContain('EncryptCommand');
  });

  it('a redelivery after its build deployed the pipeline returns that build, not PIPELINE_ALREADY_DEPLOYED', async () => {
    const done = BUILD('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const t = setup({
      tagging: () => ({ ResourceTagMappingList: [{ ResourceARN: `arn:aws:codepipeline:eu-west-2:${ACCOUNT}:acme-shop-pipeline` }] }),
      codebuild: codebuildFake([{ id: done, buildStatus: 'SUCCEEDED', env: { PB_REQUEST_ID: 'req-1', PB_PIPELINE_ID: 'pipe-1' } }]),
    });
    expect(await t.send(deploy())).toEqual({ status: 200, body: { outcome: 'deploying', buildId: done, runnerVersion: '9.9.9' } });
    expect(names(t.aws)).not.toContain('StartBuildCommand');
  });

  it('another request\'s build of the same pipeline still running: 409 DEPLOY_IN_PROGRESS', async () => {
    const t = setup({ codebuild: codebuildFake([{ id: BUILD(), env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-1' } }]) });
    expect(await t.send(deploy())).toEqual({ status: 409, body: { errorCode: 'DEPLOY_IN_PROGRESS', runnerVersion: '9.9.9' } });
    expect(names(t.aws)).not.toContain('StartBuildCommand');
  });

  it('finished builds and other pipelines\' builds do not block', async () => {
    const t = setup({
      codebuild: codebuildFake([
        { id: BUILD('aaaaaaaa-bbbb-4ccc-8ddd-000000000001'), buildStatus: 'FAILED', env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-1' } },
        { id: BUILD('aaaaaaaa-bbbb-4ccc-8ddd-000000000002'), env: { PB_REQUEST_ID: 'req-9', PB_PIPELINE_ID: 'pipe-9' } },
      ]),
    });
    expect((await t.send(deploy())).body).toMatchObject({ outcome: 'deploying' });
    expect(names(t.aws)).toContain('StartBuildCommand');
  });

  it('the project at its concurrent build limit: DEPLOY_BUSY (delivered again: the jti is not remembered)', async () => {
    let busy = true;
    const t = setup({ codebuild: codebuildFake([], { start: () => (busy ? awsError('AccountLimitExceededException', 400) : { build: { id: BUILD() } }) }) });
    expect(await t.send(deploy())).toEqual({ status: 409, body: { errorCode: 'DEPLOY_BUSY', runnerVersion: '9.9.9' } });
    busy = false;
    expect((await t.send(deploy())).body).toMatchObject({ outcome: 'deploying', buildId: BUILD() });
  });

  it('KMS or CodeBuild refusing the runner role: RUNNER_PERMISSION_DENIED', async () => {
    const t = setup({ kms: () => awsError('AccessDeniedException', 400) });
    expect(await t.send(deploy())).toEqual({ status: 403, body: { errorCode: 'RUNNER_PERMISSION_DENIED', runnerVersion: '9.9.9' } });
    expect(names(t.aws)).not.toContain('StartBuildCommand');
  });

  it('a final answer is replayed for the same jti without a second StartBuild', async () => {
    const t = setup();
    const first = await t.send(deploy());
    const again = await t.send(deploy());
    expect(again).toEqual(first);
    expect(names(t.aws).filter((n) => n === 'StartBuildCommand')).toHaveLength(1);
  });
});

describe('undeploy', () => {
  it('runs the same project in undeploy mode, with no already-deployed check (the stack is meant to exist)', async () => {
    const t = setup({
      tagging: () => ({ ResourceTagMappingList: [{ ResourceARN: `arn:aws:codepipeline:eu-west-2:${ACCOUNT}:acme-shop-pipeline` }] }),
    });
    const r = await t.send({ action: 'undeploy', deploy: deployBlock({ mode: 'undeploy' }) });
    expect(r.body).toMatchObject({ outcome: 'undeploying', buildId: BUILD('11111111-2222-4333-8444-555555555555') });
    expect(names(t.aws)).not.toContain('GetResourcesCommand');
    const env = Object.fromEntries((t.aws.find((a) => a.name === 'StartBuildCommand')!.input.environmentVariablesOverride as Array<{ name: string; value: string }>).map((v) => [v.name, v.value]));
    expect(env[DEPLOY_JOB_ENV.mode]).toBe('undeploy');
  });

  it('is still held to the allowlist', async () => {
    const t = setup();
    expect((await t.send({ action: 'undeploy', deploy: deployBlock({ mode: 'undeploy', pipelineName: 'zzz-x' }) })).body).toMatchObject({ errorCode: 'RUNNER_REFUSED' });
  });
});

describe('deploy_status', () => {
  const status = (over: Record<string, unknown> = {}) => ({ action: 'deploy_status', deployRequestId: 'req-0', buildId: BUILD(), ...over });

  it('a running build: in_progress, no stage or result yet — and only state, stage and code in the answer', async () => {
    const t = setup({ codebuild: codebuildFake([{ id: BUILD(), env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-1' } }]) });
    expect(await t.send(status())).toEqual({
      status: 200, body: { outcome: 'deploy_status', buildState: 'in_progress', stage: null, resultCode: null, runnerVersion: '9.9.9' },
    });
    expect(t.aws.find((a) => a.name === 'BatchGetBuildsCommand')!.input).toEqual({ ids: [BUILD()] });
    expect(names(t.aws)).toEqual(['BatchGetBuildsCommand']);
  });

  it('a finished build: its exported stage and result', async () => {
    const t = setup({
      codebuild: codebuildFake([{ id: BUILD(), buildStatus: 'SUCCEEDED', env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-1' }, exported: { PB_DEPLOY_STAGE: 'done', PB_DEPLOY_RESULT: 'OK' } }]),
    });
    expect((await t.send(status())).body).toEqual({ outcome: 'deploy_status', buildState: 'succeeded', stage: 'done', resultCode: 'OK', runnerVersion: '9.9.9' });
  });

  it('exported values outside the fixed vocabularies are dropped, never passed on', async () => {
    const t = setup({
      codebuild: codebuildFake([{ id: BUILD(), buildStatus: 'FAILED', env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-1' }, exported: { PB_DEPLOY_STAGE: 'arn:aws:x', PB_DEPLOY_RESULT: 'see log 123456789012' } }]),
    });
    expect((await t.send(status())).body).toMatchObject({ buildState: 'failed', stage: null, resultCode: null });
  });

  it('a build that failed provisioning (the image could not be pulled): DEPLOY_IMAGE_PULL_FAILED', async () => {
    const t = setup({
      codebuild: codebuildFake([{
        id: BUILD(),
        buildStatus: 'FAILED',
        env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-1' },
        phases: [{ phaseType: 'SUBMITTED', phaseStatus: 'SUCCEEDED' }, { phaseType: 'PROVISIONING', phaseStatus: 'FAILED' }],
      }]),
    });
    expect((await t.send(status())).body).toMatchObject({ buildState: 'failed', stage: 'starting', resultCode: 'DEPLOY_IMAGE_PULL_FAILED' });
  });

  it('timed out / stopped map to the normalized states', async () => {
    for (const [cb, state] of [['TIMED_OUT', 'timed_out'], ['STOPPED', 'stopped'], ['FAULT', 'failed']] as const) {
      const t = setup({ codebuild: codebuildFake([{ id: BUILD(), buildStatus: cb, env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-1' } }]) });
      expect((await t.send(status())).body).toMatchObject({ buildState: state });
    }
  });

  it('no such build: 404 DEPLOY_BUILD_NOT_FOUND', async () => {
    const t = setup();
    expect(await t.send(status())).toEqual({ status: 404, body: { errorCode: 'DEPLOY_BUILD_NOT_FOUND', runnerVersion: '9.9.9' } });
  });

  it.each([
    ['of another project', { id: BUILD(), projectName: 'someone-elses-project', env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-1' } }],
    ['of another request', { id: BUILD(), env: { PB_REQUEST_ID: 'req-7', PB_PIPELINE_ID: 'pipe-1' } }],
    ['of another pipeline', { id: BUILD(), env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-2' } }],
    ['without a request id', { id: BUILD(), env: {} }],
  ])('a build %s: RUNNER_REFUSED', async (_n, b) => {
    const t = setup({ codebuild: codebuildFake([b as BuildFake]) });
    expect((await t.send(status())).body).toMatchObject({ errorCode: 'RUNNER_REFUSED' });
  });

  it('a build id naming another project is refused before any call', async () => {
    const t = setup();
    expect((await t.send(status({ buildId: 'other-project:0f3b8c1e-9d4a-4e6f-8a7b-1c2d3e4f5a6b' }))).body).toMatchObject({ errorCode: 'RUNNER_REFUSED' });
    expect(t.aws).toEqual([]);
  });
});

describe('deploy_cancel', () => {
  const cancel = (over: Record<string, unknown> = {}) => ({ action: 'deploy_cancel', deployRequestId: 'req-0', buildId: BUILD(), ...over });

  it('stops the runner\'s own running build of that request', async () => {
    const t = setup({ codebuild: codebuildFake([{ id: BUILD(), env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-1' } }]) });
    expect(await t.send(cancel())).toEqual({ status: 200, body: { outcome: 'deploy_cancelled', buildState: 'in_progress', runnerVersion: '9.9.9' } });
    expect(t.aws.find((a) => a.name === 'StopBuildCommand')!.input).toEqual({ id: BUILD() });
  });

  it('an already finished build is not stopped: its final state', async () => {
    const t = setup({ codebuild: codebuildFake([{ id: BUILD(), buildStatus: 'SUCCEEDED', env: { PB_REQUEST_ID: 'req-0', PB_PIPELINE_ID: 'pipe-1' } }]) });
    expect((await t.send(cancel())).body).toMatchObject({ outcome: 'deploy_cancelled', buildState: 'succeeded' });
    expect(names(t.aws)).not.toContain('StopBuildCommand');
  });

  it('never stops another request\'s build', async () => {
    const t = setup({ codebuild: codebuildFake([{ id: BUILD(), env: { PB_REQUEST_ID: 'req-7', PB_PIPELINE_ID: 'pipe-1' } }]) });
    expect((await t.send(cancel())).body).toMatchObject({ errorCode: 'RUNNER_REFUSED' });
    expect(names(t.aws)).not.toContain('StopBuildCommand');
  });
});

describe('configFromEnv: deploys', () => {
  const env = { PLATFORM_BASE_URL: 'https://p', ALLOWED_REGIONS: 'us-east-1', ALLOWED_PIPELINE_PREFIXES: 'acme-', RUNNER_ID: 'r1' };
  const on = {
    ...env,
    DEPLOY_ENABLED: 'true',
    DEPLOY_PROJECT_NAME: 'pipeline-builder-runner-deploy-r1',
    REGISTRY_PULL_HOST: 'registry.example.com:8443',
    REGISTRY_CREDENTIAL_SECRET: 'pipeline-builder/o/registry-push',
    DEPLOY_GRANT_KEY_ARN: KEY_ARN,
  };

  it('off unless DEPLOY_ENABLED is exactly "true"', () => {
    expect(configFromEnv(env).deploy).toEqual({ enabled: false });
    expect(configFromEnv({ ...env, DEPLOY_ENABLED: 'false', DEPLOY_PROJECT_NAME: '' }).deploy).toEqual({ enabled: false });
  });

  it('on: every deploy setting from the stack', () => {
    expect(configFromEnv(on).deploy).toEqual({
      enabled: true,
      projectName: 'pipeline-builder-runner-deploy-r1',
      registryPullHost: 'registry.example.com:8443',
      registryCredentialSecret: 'pipeline-builder/o/registry-push',
      grantKeyArn: KEY_ARN,
    });
  });

  it.each(['DEPLOY_PROJECT_NAME', 'REGISTRY_PULL_HOST', 'REGISTRY_CREDENTIAL_SECRET', 'DEPLOY_GRANT_KEY_ARN'])('on without %s: misconfigured', (k) => {
    expect(() => configFromEnv({ ...on, [k]: '' })).toThrow(new RegExp(k));
  });

  it('refuses a pull host that is not a host[:port]', () => {
    expect(() => configFromEnv({ ...on, REGISTRY_PULL_HOST: 'https://registry.example.com/x' })).toThrow(/REGISTRY_PULL_HOST/);
  });
});
