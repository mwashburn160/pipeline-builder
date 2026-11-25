// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cross-account runner Lambda: allowlist, tag lookup (one / none / many /
 * paging / hint fallback / mismatch / untagged / not-yet-visible), each action,
 * the exact response vocabulary, replay, and the push (HTTP) entry point —
 * every AWS / HTTP / clock dependency faked.
 */

import { describe, it, expect } from '@jest/globals';
import { awsError, claims, clock, fakeFetch, fakeSender, makeKey, signJws, type SentCommand } from './helpers/runner-fixtures.js';

const {
  createRunner, configFromEnv, isAllowed, parsePipelineArn, accountFromFunctionArn, handler, _resetRunnerForTests,
} = await import('../src/lambda/runner-handler.js');
type RunnerConfig = import('../src/lambda/runner-handler.js').RunnerConfig;

const ACCOUNT = '123456789012';
const FN_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:pipeline-builder-runner-default`;
const arn = (region: string, name: string) => `arn:aws:codepipeline:${region}:${ACCOUNT}:${name}`;
const key = makeKey('k1');

type Responder = (name: string, input: any, region?: string) => unknown;

function setup(opts: { config?: Partial<RunnerConfig>; tagging?: Responder; cp?: Responder; routes?: Parameters<typeof fakeFetch>[0] } = {}) {
  const c = clock();
  const aws: SentCommand[] = [];
  const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const f = fakeFetch({
    '/api/pipelines/runner/runners/runner-1/jwks.json': () => ({ status: 200, body: { keys: [key.jwk] } }),
    ...(opts.routes ?? {}),
  });
  const config: RunnerConfig = {
    runnerId: 'runner-1',
    platformBaseUrl: 'https://platform.example',
    allowedRegions: ['us-east-1', 'eu-west-2'],
    allowedPrefixes: ['acme-'],
    version: '9.9.9',
    deploy: { enabled: false },
    ...opts.config,
  };
  const runner = createRunner(config, {
    fetch: f.fn,
    now: c.now,
    tagging: (region) => fakeSender(opts.tagging ?? (() => ({ ResourceTagMappingList: [] })), aws, region),
    codepipeline: (region) => fakeSender(opts.cp ?? ((n) => (n === 'StartPipelineExecutionCommand' ? { pipelineExecutionId: 'exec-1' } : {})), aws, region),
    codebuild: () => fakeSender(() => { throw new Error('no deploy here'); }, aws),
    kms: () => fakeSender(() => { throw new Error('no deploy here'); }, aws),
    log: (level, msg, data) => { logs.push({ level, msg, ...(data ? { data } : {}) }); },
  });
  const account = accountFromFunctionArn(FN_ARN)!;
  const send = (cl: Record<string, unknown> = {}, jti?: string) => runner.process(signJws(key, claims({ ...cl, ...(jti ? { jti } : {}) })), { account });
  return { c, aws, logs, f, runner, send, account };
}

/** Tag lookup answering one ARN set per region. */
const tagged = (byRegion: Record<string, string[]>): Responder => (_n, _i, region) => ({
  ResourceTagMappingList: (byRegion[region!] ?? []).map((a) => ({ ResourceARN: a, Tags: [{ Key: 'pb.pipeline-id', Value: 'pipe-1' }] })),
});

const names = (aws: SentCommand[]) => aws.map((a) => a.name);

describe('helpers', () => {
  it('isAllowed: region and prefix both required; * allows every name', () => {
    const cfg = { allowedRegions: ['us-east-1'], allowedPrefixes: ['acme-', 'ops-'] };
    expect(isAllowed(cfg, 'us-east-1', 'acme-app-pipeline')).toBe(true);
    expect(isAllowed(cfg, 'us-east-1', 'ops-x')).toBe(true);
    expect(isAllowed(cfg, 'us-east-1', 'other-app')).toBe(false);
    expect(isAllowed(cfg, 'eu-west-1', 'acme-app')).toBe(false);
    expect(isAllowed({ allowedRegions: ['us-east-1'], allowedPrefixes: ['*'] }, 'us-east-1', 'anything')).toBe(true);
  });

  it('parses pipeline and function ARNs', () => {
    expect(parsePipelineArn(arn('eu-west-2', 'acme-x'))).toEqual({ region: 'eu-west-2', accountId: ACCOUNT, name: 'acme-x' });
    expect(parsePipelineArn('arn:aws:s3:::bucket')).toBeUndefined();
    expect(accountFromFunctionArn(FN_ARN)).toEqual({ partition: 'aws', accountId: ACCOUNT });
    expect(accountFromFunctionArn('arn:aws-us-gov:lambda:us-gov-west-1:111122223333:function:f')).toEqual({ partition: 'aws-us-gov', accountId: '111122223333' });
  });

  it('configFromEnv validates required settings', () => {
    const env = { PLATFORM_BASE_URL: 'https://p/', ALLOWED_REGIONS: 'us-east-1, eu-west-2', ALLOWED_PIPELINE_PREFIXES: 'acme-', RUNNER_ID: 'r1' };
    expect(configFromEnv(env)).toMatchObject({ platformBaseUrl: 'https://p', allowedRegions: ['us-east-1', 'eu-west-2'], runnerId: 'r1', version: '0.0.0' });
    expect(() => configFromEnv({ ...env, ALLOWED_REGIONS: '' })).toThrow(/ALLOWED_REGIONS/);
    expect(() => configFromEnv({ ...env, ALLOWED_PIPELINE_PREFIXES: '' })).toThrow(/PREFIXES/);
    // Push-only: no mode switch, no key — a leftover MODE / KEY_SECRET_NAME changes nothing.
    expect(configFromEnv({ ...env, MODE: 'poll', KEY_SECRET_NAME: 'x' })).toEqual(configFromEnv(env));
    expect(() => configFromEnv({ ...env, PLATFORM_BASE_URL: 'http://p', NODE_ENV: 'production' })).toThrow(/https/);
  });
});

describe('tag lookup', () => {
  it('one match: acts on the name and region from the ARN', async () => {
    const t = setup({ tagging: tagged({ 'eu-west-2': [arn('eu-west-2', 'acme-renamed-pipeline')] }) });
    const r = await t.send();
    expect(r).toEqual({ status: 200, body: { outcome: 'started', executionId: 'exec-1', runnerVersion: '9.9.9' } });
    const start = t.aws.find((a) => a.name === 'StartPipelineExecutionCommand')!;
    expect(start).toEqual({ name: 'StartPipelineExecutionCommand', input: { name: 'acme-renamed-pipeline', clientRequestToken: 'req-1' }, region: 'eu-west-2' });
  });

  it('queries with the pb.pipeline-id tag filter and the pipeline resource type, hint region first', async () => {
    const t = setup();
    await t.send({ hint: { region: 'eu-west-2', pipelineName: 'acme-x' } });
    const lookups = t.aws.filter((a) => a.name === 'GetResourcesCommand');
    expect(lookups.map((l) => l.region)).toEqual(['eu-west-2', 'us-east-1']);
    expect(lookups[0]!.input).toEqual({ TagFilters: [{ Key: 'pb.pipeline-id', Values: ['pipe-1'] }], ResourceTypeFilters: ['codepipeline:pipeline'] });
  });

  it('follows every page', async () => {
    const t = setup({
      tagging: (_n, input, region) => {
        if (region !== 'us-east-1') return { ResourceTagMappingList: [] };
        return input.PaginationToken === 'p2'
          ? { ResourceTagMappingList: [{ ResourceARN: arn('us-east-1', 'acme-app') }] }
          : { ResourceTagMappingList: [], PaginationToken: 'p2' };
      },
    });
    const r = await t.send();
    expect(r.body).toMatchObject({ outcome: 'started' });
    expect(t.aws.filter((a) => a.name === 'GetResourcesCommand' && a.region === 'us-east-1').map((a) => a.input.PaginationToken)).toEqual([undefined, 'p2']);
  });

  it('many matches (across regions): AMBIGUOUS_PIPELINE, nothing started', async () => {
    const t = setup({ tagging: tagged({ 'us-east-1': [arn('us-east-1', 'acme-a')], 'eu-west-2': [arn('eu-west-2', 'acme-b')] }) });
    expect(await t.send()).toEqual({ status: 409, body: { errorCode: 'AMBIGUOUS_PIPELINE', runnerVersion: '9.9.9' } });
    expect(names(t.aws)).not.toContain('StartPipelineExecutionCommand');
  });

  it('none, no hint: NOT_YET_VISIBLE', async () => {
    const t = setup();
    expect(await t.send()).toEqual({ status: 409, body: { errorCode: 'NOT_YET_VISIBLE', runnerVersion: '9.9.9' } });
  });

  it('none, hint tagged with this id: falls back to the hinted pipeline', async () => {
    const t = setup({
      cp: (n, input) => {
        if (n === 'ListTagsForResourceCommand') {
          expect(input.resourceArn).toBe(arn('us-east-1', 'acme-new'));
          return { tags: [{ key: 'pb.pipeline-id', value: 'pipe-1' }] };
        }
        return { pipelineExecutionId: 'exec-9' };
      },
    });
    const r = await t.send({ hint: { region: 'us-east-1', pipelineName: 'acme-new' } });
    expect(r.body).toEqual({ outcome: 'started', executionId: 'exec-9', runnerVersion: '9.9.9' });
  });

  it('hint carrying another pipeline\'s tag: PIPELINE_IDENTITY_MISMATCH', async () => {
    const t = setup({ cp: () => ({ tags: [{ key: 'pb.pipeline-id', value: 'pipe-OTHER' }] }) });
    expect((await t.send({ hint: { region: 'us-east-1', pipelineName: 'acme-x' } })).body).toMatchObject({ errorCode: 'PIPELINE_IDENTITY_MISMATCH' });
    expect(names(t.aws)).not.toContain('StartPipelineExecutionCommand');
  });

  it('untagged hint (paged tags): PIPELINE_NOT_TAGGED', async () => {
    const t = setup({ cp: (_n, input) => (input.nextToken ? { tags: [{ key: 'team', value: 'x' }] } : { tags: [], nextToken: 't2' }) });
    expect((await t.send({ hint: { region: 'us-east-1', pipelineName: 'acme-x' } })).body).toMatchObject({ errorCode: 'PIPELINE_NOT_TAGGED' });
  });

  it('hinted pipeline does not exist either: 404 PIPELINE_NOT_FOUND (the platform clears a stale link and re-discovers)', async () => {
    const t = setup({ cp: () => awsError('ResourceNotFoundException') });
    expect(await t.send({ hint: { region: 'us-east-1', pipelineName: 'acme-x' } })).toEqual({ status: 404, body: { errorCode: 'PIPELINE_NOT_FOUND', runnerVersion: '9.9.9' } });
    // A probe of a pipeline that is provably not here is a plain no_match.
    expect((await t.send({ action: 'probe', hint: { region: 'us-east-1', pipelineName: 'acme-x' } }, 'r2')).body).toEqual({ outcome: 'no_match', runnerVersion: '9.9.9' });
    expect(names(t.aws)).not.toContain('StartPipelineExecutionCommand');
  });

  it('hint outside the allowlist: RUNNER_REFUSED without touching it', async () => {
    const t = setup();
    expect((await t.send({ hint: { region: 'ap-south-1', pipelineName: 'acme-x' } })).body).toMatchObject({ errorCode: 'RUNNER_REFUSED' });
    expect((await t.send({ hint: { region: 'us-east-1', pipelineName: 'other-x' } }, 'r2')).body).toMatchObject({ errorCode: 'RUNNER_REFUSED' });
    expect(names(t.aws)).not.toContain('ListTagsForResourceCommand');
  });

  it('match outside the prefix allowlist: RUNNER_REFUSED (403), nothing started', async () => {
    const t = setup({ tagging: tagged({ 'us-east-1': [arn('us-east-1', 'other-team-pipeline')] }) });
    expect(await t.send()).toEqual({ status: 403, body: { errorCode: 'RUNNER_REFUSED', runnerVersion: '9.9.9' } });
    expect(names(t.aws)).not.toContain('StartPipelineExecutionCommand');
  });
});

describe('actions', () => {
  const one = tagged({ 'us-east-1': [arn('us-east-1', 'acme-app')] });

  it('start: a pipeline gone since the index listed it is PIPELINE_NOT_FOUND', async () => {
    const t = setup({ tagging: one, cp: () => awsError('PipelineNotFoundException') });
    expect(await t.send()).toEqual({ status: 404, body: { errorCode: 'PIPELINE_NOT_FOUND', runnerVersion: '9.9.9' } });
  });

  it('stop: checks the execution belongs to the pipeline, then stops it', async () => {
    const t = setup({ tagging: one, cp: (n) => (n === 'GetPipelineExecutionCommand' ? { pipelineExecution: { pipelineName: 'acme-app' } } : {}) });
    expect(await t.send({ action: 'stop', executionId: 'exec-7' })).toEqual({ status: 200, body: { outcome: 'stopped', executionId: 'exec-7', runnerVersion: '9.9.9' } });
    const cp = t.aws.filter((a) => a.name !== 'GetResourcesCommand');
    expect(cp.map((a) => a.name)).toEqual(['GetPipelineExecutionCommand', 'StopPipelineExecutionCommand']);
    expect(cp[1]!.input).toMatchObject({ pipelineName: 'acme-app', pipelineExecutionId: 'exec-7', abandon: false });
  });

  it('stop: an execution of another pipeline is refused, never stopped', async () => {
    const t = setup({ tagging: one, cp: (n) => (n === 'GetPipelineExecutionCommand' ? awsError('PipelineExecutionNotFoundException') : {}) });
    expect((await t.send({ action: 'stop', executionId: 'exec-x' })).body).toMatchObject({ errorCode: 'RUNNER_REFUSED' });
    expect(names(t.aws)).not.toContain('StopPipelineExecutionCommand');
  });

  it('stop: an execution already stopping/stopped is stopped (a redelivery that reaches the other container)', async () => {
    for (const status of ['Stopping', 'Stopped']) {
      const t = setup({
        tagging: one,
        cp: (n) => (n === 'GetPipelineExecutionCommand' ? { pipelineExecution: { pipelineName: 'acme-app', status } } : awsError('PipelineExecutionNotStoppableException')),
      });
      expect(await t.send({ action: 'stop', executionId: 'e1' })).toEqual({ status: 200, body: { outcome: 'stopped', executionId: 'e1', runnerVersion: '9.9.9' } });
      expect(names(t.aws)).not.toContain('StopPipelineExecutionCommand');
    }
  });

  it('stop: a duplicate stop is still stopped; a finished execution is refused', async () => {
    let stopErr = 'DuplicatedStopRequestException';
    const t = setup({ tagging: one, cp: (n) => (n === 'StopPipelineExecutionCommand' ? awsError(stopErr) : {}) });
    expect((await t.send({ action: 'stop', executionId: 'e1' })).body).toMatchObject({ outcome: 'stopped' });
    stopErr = 'PipelineExecutionNotStoppableException';
    expect((await t.send({ action: 'stop', executionId: 'e1' }, 'r2')).body).toMatchObject({ errorCode: 'RUNNER_REFUSED' });
  });

  it('status: read-only GetPipelineExecution after the tag lookup', async () => {
    const t = setup({ tagging: one, cp: (n) => (n === 'GetPipelineExecutionCommand' ? { pipelineExecution: { pipelineName: 'acme-app', status: 'InProgress' } } : {}) });
    expect(await t.send({ action: 'status', executionId: 'exec-3' })).toEqual({
      status: 200, body: { outcome: 'status', executionId: 'exec-3', executionStatus: 'InProgress', runnerVersion: '9.9.9' },
    });
    const cp = t.aws.filter((a) => a.name !== 'GetResourcesCommand');
    expect(cp).toEqual([{ name: 'GetPipelineExecutionCommand', input: { pipelineName: 'acme-app', pipelineExecutionId: 'exec-3' }, region: 'us-east-1' }]);
  });

  it('status: an execution of another pipeline is refused; the lookup refusals apply', async () => {
    const other = setup({ tagging: one, cp: () => awsError('PipelineExecutionNotFoundException') });
    expect((await other.send({ action: 'status', executionId: 'x' })).body).toMatchObject({ errorCode: 'RUNNER_REFUSED' });
    const outside = setup({ tagging: tagged({ 'us-east-1': [arn('us-east-1', 'zzz-app')] }) });
    expect((await outside.send({ action: 'status', executionId: 'x' })).body).toMatchObject({ errorCode: 'RUNNER_REFUSED' });
    expect(outside.aws.map((a) => a.name)).toEqual(['GetResourcesCommand', 'GetResourcesCommand']);
    const none = setup();
    expect((await none.send({ action: 'status', executionId: 'x' })).body).toMatchObject({ errorCode: 'NOT_YET_VISIBLE' });
  });

  it('probe: match / no_match, never starts', async () => {
    const hit = setup({ tagging: one });
    expect(await hit.send({ action: 'probe' })).toEqual({ status: 200, body: { outcome: 'match', runnerVersion: '9.9.9' } });
    const miss = setup();
    expect((await miss.send({ action: 'probe' })).body).toEqual({ outcome: 'no_match', runnerVersion: '9.9.9' });
    const outside = setup({ tagging: tagged({ 'us-east-1': [arn('us-east-1', 'zzz')] }) });
    expect((await outside.send({ action: 'probe' })).body).toMatchObject({ outcome: 'no_match' });
    for (const t of [hit, miss, outside]) expect(names(t.aws)).not.toContain('StartPipelineExecutionCommand');
  });

  it('ping: pong with the allowed regions, no AWS call', async () => {
    const t = setup();
    expect(await t.send({ action: 'ping', pipelineId: undefined })).toEqual({ status: 200, body: { outcome: 'pong', regions: ['us-east-1', 'eu-west-2'], capabilities: [], pipelinePrefixes: ['acme-'], runnerVersion: '9.9.9' } });
    expect(t.aws).toEqual([]);
  });
});

describe('response vocabulary', () => {
  it('a runner without RUNNER_ID answers every request 401, before any AWS call', async () => {
    const t = setup({ config: { runnerId: undefined } });
    expect(await t.send({ action: 'ping', pipelineId: undefined })).toEqual({ status: 401, body: { errorCode: 'SIGNATURE_INVALID', runnerVersion: '9.9.9' } });
    expect((await t.send({}, 'r2')).status).toBe(401);
    expect(t.aws).toEqual([]);
  });

  it('every response carries runnerVersion (RUNNER_VERSION, semver default 0.0.0)', async () => {
    expect(configFromEnv({ PLATFORM_BASE_URL: 'https://p', ALLOWED_REGIONS: 'us-east-1', ALLOWED_PIPELINE_PREFIXES: 'a-' }).version).toBe('0.0.0');
    const t = setup({ tagging: tagged({ 'us-east-1': [arn('us-east-1', 'acme-app')] }) });
    const bodies = [
      (await t.send()).body,
      (await t.send({ action: 'probe' }, 'r2')).body,
      (await t.send({ action: 'ping', pipelineId: undefined }, 'r3')).body,
      (await t.runner.process('garbage')).body,
    ];
    for (const b of bodies) expect(b).toMatchObject({ runnerVersion: '9.9.9' });
  });

  it('a bad signature is 401 SIGNATURE_INVALID before any AWS call', async () => {
    const t = setup();
    const r = await t.runner.process(signJws(makeKey('k1'), claims()), { account: t.account });
    expect(r).toEqual({ status: 401, body: { errorCode: 'SIGNATURE_INVALID', runnerVersion: '9.9.9' } });
    expect(t.aws).toEqual([]);
  });

  it('AWS refusing the role is 403 RUNNER_PERMISSION_DENIED', async () => {
    const t = setup({ tagging: () => awsError('AccessDeniedException', 400) });
    expect(await t.send()).toEqual({ status: 403, body: { errorCode: 'RUNNER_PERMISSION_DENIED', runnerVersion: '9.9.9' } });
  });

  it('anything else is exactly 500 { errorCode: RUNNER_ERROR }', async () => {
    const t = setup({ tagging: () => awsError('ThrottlingException', 400) });
    expect(await t.send()).toEqual({ status: 500, body: { errorCode: 'RUNNER_ERROR' } });
  });

  it('unreachable JWKS is a 500 (the platform retries), not a 401', async () => {
    const t = setup({ routes: { '/api/pipelines/runner/runners/runner-1/jwks.json': () => ({ status: 503, body: {} }) } });
    expect(await t.send()).toEqual({ status: 500, body: { errorCode: 'RUNNER_ERROR' } });
  });

  it('verifies against its OWN key set: PLATFORM_BASE_URL + /api/pipelines/runner/runners/<RUNNER_ID>/jwks.json', async () => {
    const t = setup({ tagging: tagged({ 'us-east-1': [arn('us-east-1', 'acme-app')] }) });
    expect((await t.send()).status).toBe(200);
    expect(t.f.calls.map((c) => c.url)).toEqual(['https://platform.example/api/pipelines/runner/runners/runner-1/jwks.json']);
    expect(t.f.calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('a 404 on its key set (unknown or revoked runner) fails closed: 401 SIGNATURE_INVALID, no AWS call', async () => {
    const t = setup({ routes: { '/api/pipelines/runner/runners/runner-1/jwks.json': () => ({ status: 404, body: {} }) }, tagging: tagged({ 'us-east-1': [arn('us-east-1', 'acme-app')] }) });
    expect(await t.send()).toEqual({ status: 401, body: { errorCode: 'SIGNATURE_INVALID', runnerVersion: '9.9.9' } });
    expect(t.aws).toEqual([]);
  });

  it('a key rotated in mid-cache is picked up on its first use (unknown kid refetch), at most once a minute', async () => {
    const rotated = makeKey('k2');
    const keys = [key.jwk];
    const t = setup({ routes: { '/api/pipelines/runner/runners/runner-1/jwks.json': () => ({ status: 200, body: { keys } }) }, tagging: tagged({ 'us-east-1': [arn('us-east-1', 'acme-app')] }) });
    expect((await t.send({ action: 'probe' })).body).toMatchObject({ outcome: 'match' });
    t.c.advance(2 * 60_000);
    keys.push(rotated.jwk);
    const fresh = (jti: string) => claims({ action: 'probe', jti, iat: Math.floor(t.c.now() / 1000), exp: Math.floor(t.c.now() / 1000) + 300 });
    const r = await t.runner.process(signJws(rotated, fresh('r2')), { account: t.account });
    expect(r.body).toMatchObject({ outcome: 'match' });
    expect(t.f.calls).toHaveLength(2);
    // Another unknown kid inside the minute: refused without a third fetch.
    const bogus = await t.runner.process(signJws(makeKey('k9'), fresh('r3')), { account: t.account });
    expect(bogus).toEqual({ status: 401, body: { errorCode: 'SIGNATURE_INVALID', runnerVersion: '9.9.9' } });
    expect(t.f.calls).toHaveLength(2);
  });

  it('with no RUNNER_ID nothing is fetched and every request is refused', async () => {
    const t = setup({ config: { runnerId: undefined } });
    expect(await t.send()).toEqual({ status: 401, body: { errorCode: 'SIGNATURE_INVALID', runnerVersion: '9.9.9' } });
    expect(t.f.calls).toEqual([]);
  });

  it('never logs the account id or an ARN', async () => {
    const t = setup({ tagging: tagged({ 'us-east-1': [arn('us-east-1', 'acme-app')] }) });
    await t.send();
    await t.send({ action: 'stop', executionId: 'e' }, 'r2');
    await t.runner.process('garbage', { account: t.account });
    const all = JSON.stringify(t.logs);
    expect(all).not.toContain(ACCOUNT);
    expect(all).not.toMatch(/arn:/);
  });
});

describe('replay', () => {
  const one = tagged({ 'us-east-1': [arn('us-east-1', 'acme-app')] });

  it('a repeated jti returns the earlier result and starts once', async () => {
    const t = setup({ tagging: one });
    const a = await t.send();
    const b = await t.send();
    expect(b).toEqual(a);
    expect(t.aws.filter((x) => x.name === 'StartPipelineExecutionCommand')).toHaveLength(1);
  });

  it('a repeat while the first is in flight is DUPLICATE', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = createRunnerWithSlowStart(gate);
    const first = slow.send();
    await new Promise((r) => setTimeout(r, 5));
    expect(await slow.send()).toEqual({ status: 409, body: { errorCode: 'DUPLICATE', runnerVersion: '9.9.9' } });
    release();
    expect((await first).body).toMatchObject({ outcome: 'started' });
  });

  it('NOT_YET_VISIBLE and 5xx are retried afresh, not replayed', async () => {
    let visible = false;
    let fail = true;
    const t = setup({
      tagging: (_n, _i, region) => {
        if (fail) { fail = false; return awsError('ThrottlingException', 400); }
        return { ResourceTagMappingList: visible && region === 'us-east-1' ? [{ ResourceARN: arn('us-east-1', 'acme-app') }] : [] };
      },
    });
    expect((await t.send()).status).toBe(500);
    expect((await t.send()).body).toMatchObject({ errorCode: 'NOT_YET_VISIBLE' });
    visible = true;
    expect((await t.send()).body).toMatchObject({ outcome: 'started' });
  });

  function createRunnerWithSlowStart(gate: Promise<void>) {
    const c = clock();
    const f = fakeFetch({ 'jwks.json': () => ({ status: 200, body: { keys: [key.jwk] } }) });
    const r = createRunner({ runnerId: 'runner-1', platformBaseUrl: 'https://p', allowedRegions: ['us-east-1'], allowedPrefixes: ['acme-'], version: '9.9.9', deploy: { enabled: false } }, {
      fetch: f.fn,
      now: c.now,
      log: () => {},
      tagging: () => fakeSender(tagged({ 'us-east-1': [arn('us-east-1', 'acme-app')] }), [], 'us-east-1'),
      codepipeline: () => ({ send: async () => { await gate; return { pipelineExecutionId: 'e' }; } }),
      codebuild: () => ({ send: async () => ({}) }),
      kms: () => ({ send: async () => ({}) }),
    });
    return { send: () => r.process(signJws(key, claims()), { account: { partition: 'aws', accountId: ACCOUNT } }) };
  }
});

describe('push handler', () => {
  const one = tagged({ 'us-east-1': [arn('us-east-1', 'acme-app')] });
  const urlEvent = (body: string, over: Record<string, unknown> = {}) => ({
    version: '2.0', requestContext: { http: { method: 'POST' } }, headers: { 'content-type': 'application/jwt' }, body, isBase64Encoded: false, ...over,
  });

  it('Function URL event: status + JSON body', async () => {
    const t = setup({ tagging: one });
    const res = await t.runner.handler(urlEvent(signJws(key, claims())), { invokedFunctionArn: FN_ARN }) as any;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({ outcome: 'started', executionId: 'exec-1', runnerVersion: '9.9.9' });
  });

  it('base64 bodies are decoded; API Gateway (REST) events work', async () => {
    const t = setup({ tagging: one });
    const jws = signJws(key, claims({ action: 'probe' }));
    const b = await t.runner.handler(urlEvent(Buffer.from(jws).toString('base64'), { isBase64Encoded: true }), { invokedFunctionArn: FN_ARN }) as any;
    expect(JSON.parse(b.body)).toMatchObject({ outcome: 'match' });
    const g = await t.runner.handler({ httpMethod: 'POST', headers: { 'Content-Type': 'application/jwt; charset=utf-8' }, body: signJws(key, claims({ action: 'probe', jti: 'r2' })) }, { invokedFunctionArn: FN_ARN }) as any;
    expect(g.statusCode).toBe(200);
  });

  it('a GET, the wrong content type or an empty body is 401 SIGNATURE_INVALID', async () => {
    const t = setup({ tagging: one });
    const jws = signJws(key, claims());
    for (const ev of [
      urlEvent(jws, { requestContext: { http: { method: 'GET' } } }),
      urlEvent(jws, { headers: { 'content-type': 'application/json' } }),
      urlEvent(''),
    ]) {
      const r = await t.runner.handler(ev, { invokedFunctionArn: FN_ARN }) as any;
      expect(r.statusCode).toBe(401);
      expect(JSON.parse(r.body)).toEqual({ errorCode: 'SIGNATURE_INVALID', runnerVersion: '9.9.9' });
    }
    expect(names(t.aws)).not.toContain('StartPipelineExecutionCommand');
  });

  it('ignores an invocation that is not an HTTP request (there is no schedule)', async () => {
    const t = setup();
    expect(await t.runner.handler({ 'source': 'aws.events', 'detail-type': 'Scheduled Event' }, {})).toEqual({ statusCode: 400 });
    expect(t.f.calls).toEqual([]);
    expect(t.aws).toEqual([]);
  });

  it('the module handler answers 500 RUNNER_ERROR when misconfigured', async () => {
    _resetRunnerForTests();
    const saved = { ...process.env };
    delete process.env.PLATFORM_BASE_URL;
    try {
      const r = await handler(urlEvent('x'), {}) as any;
      expect(r.statusCode).toBe(500);
      expect(JSON.parse(r.body)).toEqual({ errorCode: 'RUNNER_ERROR' });
    } finally {
      process.env = saved;
      _resetRunnerForTests();
    }
  });
});
