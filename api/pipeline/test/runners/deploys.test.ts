// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deploying a never-deployed pipeline through a runner, end to end over the
 * in-memory runner fakes: runner selection and the 409/429 refusals, the
 * capability gate BEFORE signing, the signed deploy claim (grant re-signed
 * from its encrypted copy), the runner's `deploying` answer, the job's grant
 * exchange and session, the sweep's deploy_status poll (deployed → the one
 * registry upsert with the runner link; failed / cancelled / timed out),
 * cancel, the DTO (logHint), and the undeploy a purge sends.
 */

import { describe, expect, it } from '@jest/globals';
import {
  DEPLOY_GRANT_PATTERN, DEPLOY_GRANT_TTL_MS, DEPLOY_JOB_PROTOCOL_VERSION, DEPLOY_SESSION_PATTERN, deployProjectName, RUN_REQUEST_TTL_MS, RUNNER_DEPLOY_METRICS,
} from '@pipeline-builder/api-core/pipeline-runners';
import { planUndeploy, startUndeploy } from '../../src/helpers/undeploy-on-purge.js';
import { interpretReply } from '../../src/runners/delivery.js';
import { authenticateDeploySession, exchangeDeployGrant, hashDeployToken } from '../../src/runners/deploy-grants.js';
import { deployTargets, startDeploy, type DeployPipelineFacts } from '../../src/runners/deploy-routing.js';
import { cancelDeploy, deployClaimFor, pollDeploys, readDeploy, recordDeployResult } from '../../src/runners/deploys.js';
import { processDelivery, runSweep } from '../../src/runners/lifecycle.js';
import { RunnerRouteError } from '../../src/runners/routing.js';
import { claimsOf, ORG, PARENT, PIPE, reply, runnerRow, testDeps, type TestDeps } from '../helpers/runner-fakes.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const BUILD = (runnerId: string) => `${deployProjectName(runnerId)}:0f8fad5b-d9cb-469f-a165-70867728950e`;

function facts(over: Partial<DeployPipelineFacts> = {}): DeployPipelineFacts {
  return {
    pipelineId: PIPE,
    orgId: ORG,
    pipelineName: 'acme-shop-pipeline',
    stackName: 'shop-acme',
    registered: false,
    toolchain: { releaseVersion: '1.2.0', imageDigest: DIGEST, deployJobProtocol: DEPLOY_JOB_PROTOCOL_VERSION },
    ...over,
  };
}

const deployable = (over: Partial<ReturnType<typeof runnerRow>> = {}) => runnerRow({ capabilities: ['deploy:1'], pipelinePrefixes: ['*'], regions: ['us-east-1'], ...over });

function withRunners(...rows: Array<ReturnType<typeof runnerRow>>): TestDeps {
  const deps = testDeps();
  for (const r of rows) deps.store.runners.set(r.id, r);
  return deps;
}

async function refusal(p: Promise<unknown>): Promise<RunnerRouteError> {
  const err = await p.then(() => null, (e: unknown) => e);
  if (!(err instanceof RunnerRouteError)) throw new Error(`expected a RunnerRouteError, got ${String(err)}`);
  return err;
}

/** Queue a deploy and deliver it; the runner answers `deploying`. */
async function accepted(deps: TestDeps, runner: ReturnType<typeof runnerRow>) {
  const queued = await startDeploy(deps, facts(), {}, 'user-1');
  deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploying', buildId: BUILD(runner.id) }) as never);
  await processDelivery(deps, queued.requestId);
  return queued.requestId;
}

/** The cleartext grant the platform signed into the last delivery. */
const signedGrant = (deps: TestDeps) => (claimsOf(String(deps.fetchMock.mock.calls.at(-1)![1].body)).deploy as { grant: string }).grant;

describe('delivery: a pong reports capabilities; deploy answers are validated', () => {
  it('parses capabilities and prefixes against the fixed lists (only on a pong)', () => {
    expect(interpretReply(200, { outcome: 'pong', capabilities: ['deploy:1', 'bogus', 'deploy:1'], pipelinePrefixes: ['acme-', '*', 'bad prefix!', 7] }))
      .toMatchObject({ kind: 'success', capabilities: ['deploy:1'], pipelinePrefixes: ['acme-', '*'] });
    expect(interpretReply(200, { outcome: 'pong' })).toMatchObject({ capabilities: [], pipelinePrefixes: [] });
    expect(interpretReply(200, { outcome: 'started', capabilities: ['deploy:1'] })).not.toHaveProperty('capabilities');
  });

  it('deploying needs a build id (project:uuid, never an ARN); deploy_status a build state', () => {
    expect(interpretReply(200, { outcome: 'deploying', buildId: 'p:0f8fad5b-d9cb-469f-a165-70867728950e' })).toMatchObject({ kind: 'success', buildId: 'p:0f8fad5b-d9cb-469f-a165-70867728950e' });
    expect(interpretReply(200, { outcome: 'deploying', buildId: 'arn:aws:codebuild:us-east-1:123456789012:build/p:x' })).toEqual({ kind: 'fail', code: 'RUNNER_ERROR' });
    expect(interpretReply(200, { outcome: 'deploying' })).toEqual({ kind: 'fail', code: 'RUNNER_ERROR' });
    expect(interpretReply(200, { outcome: 'deploy_status', buildState: 'succeeded', stage: 'done', resultCode: 'OK' }))
      .toMatchObject({ buildState: 'succeeded', stage: 'done', resultCode: 'OK' });
    expect(interpretReply(200, { outcome: 'deploy_status', buildState: 'failed', stage: 'nope', resultCode: 'some log line' }))
      .toMatchObject({ buildState: 'failed', stage: null, resultCode: null });
    expect(interpretReply(200, { outcome: 'deploy_status' })).toEqual({ kind: 'fail', code: 'RUNNER_ERROR' });
  });

  it('a runner\'s DEPLOY_IN_PROGRESS (its project builds this pipeline for another request) fails the delivery with that code', async () => {
    expect(interpretReply(409, { errorCode: 'DEPLOY_IN_PROGRESS' })).toMatchObject({ kind: 'fail', code: 'DEPLOY_IN_PROGRESS' });
    const r = deployable();
    const deps = withRunners(r);
    const { requestId } = await startDeploy(deps, facts(), {}, 'u');
    deps.fetchMock.mockResolvedValueOnce(reply(409, { errorCode: 'DEPLOY_IN_PROGRESS' }) as never);
    await processDelivery(deps, requestId);
    expect(deps.store.requests.get(requestId)).toMatchObject({ status: 'failed', errorCode: 'DEPLOY_IN_PROGRESS' });
  });

  it('a runner Test ping (setup-runner re-run, same endpoint) refreshes the stored capabilities and prefixes', async () => {
    const { testRunner } = await import('../../src/runners/admin.js');
    const r = runnerRow();
    const deps = withRunners(r);
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'pong', capabilities: ['deploy:1'], pipelinePrefixes: ['acme-'] }) as never);
    await testRunner(deps, ORG, 'u', r.id);
    expect(deps.store.runners.get(r.id)).toMatchObject({ capabilities: ['deploy:1'], pipelinePrefixes: ['acme-'] });
  });

  it('DEPLOY_BUSY is delivered again (the runner is fine); DEPLOY_NOT_ENABLED is final', () => {
    expect(interpretReply(409, { errorCode: 'DEPLOY_BUSY' })).toEqual({ kind: 'retry', code: 'DEPLOY_BUSY', transport: false });
    expect(interpretReply(403, { errorCode: 'DEPLOY_NOT_ENABLED' })).toMatchObject({ kind: 'fail', code: 'DEPLOY_NOT_ENABLED' });
  });

  it('a health pong stores what the bundle can do now', async () => {
    const runner = runnerRow();
    const deps = withRunners(runner);
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'pong', capabilities: ['deploy:1'], pipelinePrefixes: ['acme-'] }) as never);
    await runSweep(deps);
    expect(deps.store.runners.get(runner.id)).toMatchObject({ capabilities: ['deploy:1'], pipelinePrefixes: ['acme-'] });
  });
});

describe('runner selection (deploy-targets and POST deploys)', () => {
  it('exactly one deployable runner is used; the targets list says why the others are not', async () => {
    const good = deployable({ label: 'prod' });
    const old = runnerRow({ label: 'old' });
    const narrow = deployable({ label: 'narrow', pipelinePrefixes: ['other-'] });
    const down = deployable({ label: 'down', health: 'unreachable' });
    const deps = withRunners(good, old, narrow, down);
    const targets = await deployTargets(deps, facts());
    expect(targets.autoRunnerId).toBe(good.id);
    expect(Object.fromEntries(targets.runners.map((r) => [r.label, r.reason]))).toEqual({ prod: null, old: 'deploy_not_enabled', narrow: 'prefix_mismatch', down: 'unhealthy' });
    expect(targets.setupCommand).toBe('pipeline-manager infra setup-runner --enable-deploy');
    const queued = await startDeploy(deps, facts(), {}, 'user-1');
    expect(queued).toMatchObject({ status: 'queued', runnerLabel: 'prod', region: 'us-east-1', reused: false });
    expect(deps.enqueued.map((e) => e.requestId)).toEqual([queued.requestId]);
  });

  it('several deployable → 409 DEPLOY_RUNNER_REQUIRED with the choices; naming one deploys through it', async () => {
    const a = deployable({ label: 'a' });
    const b = deployable({ label: 'b' });
    const deps = withRunners(a, b);
    const err = await refusal(startDeploy(deps, facts(), {}, 'u'));
    expect(err.code).toBe('DEPLOY_RUNNER_REQUIRED');
    expect(err.details?.runners?.map((r) => r.label).sort()).toEqual(['a', 'b']);
    await expect(startDeploy(deps, facts(), { runnerId: b.id }, 'u')).resolves.toMatchObject({ runnerLabel: 'b' });
  });

  it('none: NO_RUNNER; only old bundles: RUNNER_DEPLOY_UNSUPPORTED (naming setup-runner --enable-deploy); else RUNNER_NOT_DEPLOYABLE with the reason', async () => {
    expect((await refusal(startDeploy(withRunners(), facts(), {}, 'u'))).code).toBe('NO_RUNNER');
    const old = await refusal(startDeploy(withRunners(runnerRow()), facts(), {}, 'u'));
    expect(old.code).toBe('RUNNER_DEPLOY_UNSUPPORTED');
    expect(old.message).toContain('--enable-deploy');
    const narrow = await refusal(startDeploy(withRunners(deployable({ pipelinePrefixes: ['x-'] })), facts(), {}, 'u'));
    expect([narrow.code, narrow.details?.reason]).toEqual(['RUNNER_NOT_DEPLOYABLE', 'prefix_mismatch']);
    const named = await refusal(startDeploy(withRunners(deployable()), facts(), { runnerId: '00000000-0000-4000-8000-999999999999' }, 'u'));
    expect(named.code).toBe('RUNNER_NOT_DEPLOYABLE');
  });

  it("a parent's shared runner deploys a team's pipeline only when the parent shares DEPLOYS with teams", async () => {
    const parentRunner = deployable({ orgId: PARENT, label: 'parent' });
    const deps = withRunners(parentRunner);
    deps.ancestors.push(PARENT);
    const err = await refusal(startDeploy(deps, facts(), {}, 'u'));
    expect([err.code, err.details?.reason]).toEqual(['RUNNER_NOT_DEPLOYABLE', 'team_deploys_not_shared']);
    deps.store.runners.set(parentRunner.id, { ...parentRunner, shareDeploysWithTeams: true });
    await expect(startDeploy(deps, facts(), {}, 'u')).resolves.toMatchObject({ runnerLabel: 'parent' });
  });

  it('region: the runner\'s only one; several need one named; outside them → DEPLOY_REGION_NOT_ALLOWED', async () => {
    const multi = deployable({ regions: ['us-east-1', 'eu-west-1'] });
    const deps = withRunners(multi);
    expect((await refusal(startDeploy(deps, facts(), {}, 'u'))).code).toBe('DEPLOY_REGION_NOT_ALLOWED');
    expect((await refusal(startDeploy(deps, facts(), { region: 'ap-south-1' }, 'u'))).details?.regions).toEqual(['us-east-1', 'eu-west-1']);
    await expect(startDeploy(deps, facts(), { region: 'eu-west-1' }, 'u')).resolves.toMatchObject({ region: 'eu-west-1' });
  });

  it('ALREADY_DEPLOYED for a registered pipeline; TOOLCHAIN_TOO_OLD_FOR_DEPLOY for a release without the protocol', async () => {
    const deps = withRunners(deployable());
    expect((await refusal(startDeploy(deps, facts({ registered: true }), {}, 'u'))).code).toBe('ALREADY_DEPLOYED');
    const old = await refusal(startDeploy(deps, facts({ toolchain: { releaseVersion: '1.0.0', imageDigest: DIGEST, deployJobProtocol: null } }), {}, 'u'));
    expect(old.code).toBe('TOOLCHAIN_TOO_OLD_FOR_DEPLOY');
    expect(old.details).toEqual({ toolchainRelease: '1.0.0', deployJobProtocol: null });
    expect(old.message).toMatch(/toolchain\.release/);
    expect(deps.store.requests.size).toBe(0);
  });

  it('one active deploy per pipeline: the same runner reuses it, another answers DEPLOY_IN_PROGRESS', async () => {
    const a = deployable({ label: 'a' });
    const b = deployable({ label: 'b' });
    const deps = withRunners(a, b);
    const first = await startDeploy(deps, facts(), { runnerId: a.id }, 'u');
    await expect(startDeploy(deps, facts(), { runnerId: a.id }, 'u')).resolves.toMatchObject({ requestId: first.requestId, reused: true });
    await expect(startDeploy(deps, facts(), {}, 'u')).resolves.toMatchObject({ requestId: first.requestId, reused: true });
    const other = await refusal(startDeploy(deps, facts(), { runnerId: b.id }, 'u'));
    expect([other.code, other.details?.requestId]).toEqual(['DEPLOY_IN_PROGRESS', first.requestId]);
  });

  it('DEPLOY_REQUESTS_PER_HOUR per org (fail closed) and MAX_ACTIVE_DEPLOYS_PER_RUNNER', async () => {
    const prev = { ...process.env };
    try {
      process.env.DEPLOY_REQUESTS_PER_HOUR = '1';
      const r = deployable();
      const deps = withRunners(r);
      await startDeploy(deps, facts(), {}, 'u');
      expect((await refusal(startDeploy(deps, facts({ pipelineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), {}, 'u'))).code).toBe('DEPLOY_RATE_LIMITED');
      process.env.DEPLOY_REQUESTS_PER_HOUR = '20';
      process.env.MAX_ACTIVE_DEPLOYS_PER_RUNNER = '1';
      expect((await refusal(startDeploy(deps, facts({ pipelineId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }), {}, 'u'))).code).toBe('TOO_MANY_DEPLOYS');
      // The limiter's own fail-closed flag reaches it.
      const seen: unknown[] = [];
      const deps2 = withRunners(deployable());
      deps2.limiter = { hit: async (_k, _m, _w, opts) => { seen.push(opts); return true; } };
      await startDeploy(deps2, facts(), {}, 'u');
      expect(seen).toContainEqual({ failClosed: true });
    } finally {
      process.env = prev;
    }
  });
});

describe('delivery of a deploy', () => {
  it('a runner whose bundle lacks deploy:1 is NEVER sent the action (no 401 SIGNATURE_INVALID page): RUNNER_DEPLOY_UNSUPPORTED', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const { requestId } = await startDeploy(deps, facts(), {}, 'u');
    deps.store.runners.set(r.id, { ...r, capabilities: [] });
    deps.fetchMock.mockClear();
    await processDelivery(deps, requestId);
    expect(deps.fetchMock).not.toHaveBeenCalled();
    expect(deps.store.requests.get(requestId)).toMatchObject({ status: 'failed', errorCode: 'RUNNER_DEPLOY_UNSUPPORTED' });
  });

  it('signs the deploy claim (grant, protocol, image by digest, names) and the deploying answer starts the deadline and re-bases the grant', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const { requestId } = await startDeploy(deps, facts(), {}, 'u');
    const stored = deps.store.deploys.get(requestId)!;
    // Only the hash and the org-encrypted copy are stored; the grant lives ≥ the delivery lifetime.
    expect(stored.grantHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.grantExpiresAt.getTime() - deps.clock.t).toBe(DEPLOY_GRANT_TTL_MS);
    expect(DEPLOY_GRANT_TTL_MS).toBeGreaterThanOrEqual(RUN_REQUEST_TTL_MS);
    deps.clock.t += 5_000;
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploying', buildId: BUILD(r.id) }) as never);
    await processDelivery(deps, requestId);
    const claims = claimsOf(String(deps.fetchMock.mock.calls.at(-1)![1].body));
    expect(claims).toMatchObject({
      action: 'deploy',
      jti: requestId,
      pipelineId: PIPE,
      deploy: { protocol: DEPLOY_JOB_PROTOCOL_VERSION, mode: 'deploy', region: 'us-east-1', pipelineName: 'acme-shop-pipeline', stackName: 'shop-acme', image: { repository: 'system/cdk-synth', digest: DIGEST }, toolchainRelease: '1.2.0' },
    });
    const grant = (claims.deploy as { grant: string }).grant;
    expect(grant).toMatch(DEPLOY_GRANT_PATTERN);
    expect(hashDeployToken(grant)).toBe(stored.grantHash);
    expect(deps.store.requests.get(requestId)).toMatchObject({ status: 'deploying' });
    const after = deps.store.deploys.get(requestId)!;
    expect(after).toMatchObject({ buildId: BUILD(r.id), stage: 'starting' });
    expect(after.deadlineAt!.getTime() - deps.clock.t).toBe(120 * 60_000);
    expect(after.grantExpiresAt.getTime() - deps.clock.t).toBe(DEPLOY_GRANT_TTL_MS);
  });

  it('DEPLOY_NOT_ENABLED clears the stored capabilities; PIPELINE_ALREADY_DEPLOYED registers it (no link) for the background probe', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const { requestId } = await startDeploy(deps, facts(), {}, 'u');
    deps.fetchMock.mockResolvedValueOnce(reply(403, { errorCode: 'DEPLOY_NOT_ENABLED' }) as never);
    await processDelivery(deps, requestId);
    expect(deps.store.runners.get(r.id)!.capabilities).toEqual([]);
    expect(deps.store.requests.get(requestId)).toMatchObject({ status: 'failed', errorCode: 'DEPLOY_NOT_ENABLED' });

    const r2 = deployable();
    const deps2 = withRunners(r2);
    const q2 = await startDeploy(deps2, facts(), {}, 'u');
    deps2.fetchMock.mockResolvedValueOnce(reply(409, { errorCode: 'PIPELINE_ALREADY_DEPLOYED' }) as never);
    await processDelivery(deps2, q2.requestId);
    expect(deps2.store.requests.get(q2.requestId)).toMatchObject({ status: 'failed', errorCode: 'PIPELINE_ALREADY_DEPLOYED' });
    expect(deps2.store.registry.get(PIPE)).toMatchObject({ pipelineName: 'acme-shop-pipeline', runnerId: null });
  });

  it('a redelivery re-signs the SAME grant; once exchanged, a fresh never-stored one', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const { requestId } = await startDeploy(deps, facts(), {}, 'u');
    deps.fetchMock.mockResolvedValueOnce(reply(500, {}) as never);
    await processDelivery(deps, requestId);
    const first = signedGrant(deps);
    deps.clock.t += 60_000;
    deps.fetchMock.mockResolvedValueOnce(reply(500, {}) as never);
    await processDelivery(deps, requestId);
    expect(signedGrant(deps)).toBe(first);
    await exchangeDeployGrant(deps, requestId, first);
    deps.clock.t += 60_000;
    deps.fetchMock.mockResolvedValueOnce(reply(500, {}) as never);
    await processDelivery(deps, requestId);
    expect(signedGrant(deps)).not.toBe(first);
    expect(signedGrant(deps)).toMatch(DEPLOY_GRANT_PATTERN);
  });
});

describe('the job grant and session', () => {
  it('an undeploy\'s job exchanges its grant while undeploying too', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const plan = await planUndeploy(deps, ORG, PIPE, undefined, { registryId: 'x', stackName: 's', region: 'us-east-1', pipelineName: 'p', runnerId: r.id },
      async () => ({ releaseVersion: '1.2.0', imageDigest: DIGEST, deployJobProtocol: DEPLOY_JOB_PROTOCOL_VERSION }));
    const requestId = await startUndeploy(deps, plan as Extract<typeof plan, { kind: 'undeploy' }>);
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'undeploying', buildId: BUILD(r.id) }) as never);
    await processDelivery(deps, requestId);
    expect(deps.store.requests.get(requestId)!.status).toBe('undeploying');
    const dto = await exchangeDeployGrant(deps, requestId, signedGrant(deps));
    await expect(authenticateDeploySession(deps, requestId, `Bearer ${dto.sessionToken}`)).resolves.toMatchObject({ request: { action: 'undeploy' } });
  });

  it('exchange once: a session for THIS request (no-store DTO), the grant copy wiped; a second exchange is a REUSE (metric + audit)', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    const grant = signedGrant(deps);
    const dto = await exchangeDeployGrant(deps, requestId, grant);
    expect(dto).toMatchObject({ requestId, pipelineId: PIPE, region: 'us-east-1', pipelineName: 'acme-shop-pipeline', stackName: 'shop-acme', protocol: DEPLOY_JOB_PROTOCOL_VERSION });
    expect(dto.sessionToken).toMatch(DEPLOY_SESSION_PATTERN);
    expect(deps.store.deploys.get(requestId)).toMatchObject({ grantEnc: null, stage: 'authenticating' });

    const again = await refusal(exchangeDeployGrant(deps, requestId, grant));
    expect([again.code, again.status, again.details?.reason]).toEqual(['DEPLOY_GRANT_INVALID', 401, 'reused']);
    expect(deps.counterAdds).toContainEqual([RUNNER_DEPLOY_METRICS.grantRejections, { reason: 'reused' }, 1]);
    expect(deps.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.deploy.grant_reuse', actorId: 'system', orgId: ORG, targetId: PIPE }));
    expect(JSON.stringify(deps.audits)).not.toContain(grant);

    // The session reaches only its own request id.
    await expect(authenticateDeploySession(deps, requestId, `Bearer ${dto.sessionToken}`)).resolves.toMatchObject({ request: { id: requestId } });
    const other = await accepted(withRunners(r), r).catch(() => '00000000-0000-4000-8000-000000000999');
    expect((await refusal(authenticateDeploySession(deps, other, `Bearer ${dto.sessionToken}`))).details?.reason).toBe('unknown');
    expect((await refusal(authenticateDeploySession(deps, requestId, 'Bearer pb_ds_short'))).details?.reason).toBe('unknown');
  });

  it('a deploy that finished between the state check and the claim is wrong_state — never a (paging) reuse', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    const grant = signedGrant(deps);
    const claim = deps.store.claimGrant.bind(deps.store);
    // The poll finishes the deploy just before this exchange's claim lands.
    deps.store.claimGrant = async (...args: Parameters<typeof claim>) => {
      deps.store.deploys.set(requestId, { ...deps.store.deploys.get(requestId)!, finishedAt: new Date(deps.clock.t), sessionHash: null });
      return claim(...args);
    };
    const err = await refusal(exchangeDeployGrant(deps, requestId, grant));
    expect(err.details?.reason).toBe('wrong_state');
    expect(deps.counterAdds).toContainEqual([RUNNER_DEPLOY_METRICS.grantRejections, { reason: 'wrong_state' }, 1]);
    expect(deps.counterAdds.some(([n, l]) => n === RUNNER_DEPLOY_METRICS.grantRejections && l.reason === 'reused')).toBe(false);
    expect(deps.audits.some((a) => a.action === 'pipeline.deploy.grant_reuse')).toBe(false);
  });

  it('two concurrent exchanges of one grant: one session, the loser is a reuse', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    const grant = signedGrant(deps);
    const results = await Promise.allSettled([exchangeDeployGrant(deps, requestId, grant), exchangeDeployGrant(deps, requestId, grant)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as RunnerRouteError).details?.reason).toBe('reused');
  });

  it('an exchange after the grant TTL is DEPLOY_GRANT_EXPIRED (its own reason; recorded for the dashboard), never "reused"', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    const grant = signedGrant(deps);
    deps.clock.t += DEPLOY_GRANT_TTL_MS + 1;
    const err = await refusal(exchangeDeployGrant(deps, requestId, grant));
    expect(err.details?.reason).toBe('expired');
    expect(deps.counterAdds).toContainEqual([RUNNER_DEPLOY_METRICS.grantRejections, { reason: 'expired' }, 1]);
    expect(deps.store.deploys.get(requestId)!.resultCode).toBe('DEPLOY_GRANT_EXPIRED');
    expect(deps.audits.some((a) => a.action === 'pipeline.deploy.grant_reuse')).toBe(false);
  });

  it('unknown grant, unknown request, and a finished deploy (wrong_state); the session dies at the terminal status', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    const grant = signedGrant(deps);
    expect((await refusal(exchangeDeployGrant(deps, requestId, `pb_dg_${'x'.repeat(43)}`))).details?.reason).toBe('unknown');
    expect((await refusal(exchangeDeployGrant(deps, requestId, 'not-a-grant'))).details?.reason).toBe('unknown');
    expect((await refusal(exchangeDeployGrant(deps, '00000000-0000-4000-8000-000000000999', grant))).details?.reason).toBe('unknown');
    const { sessionToken } = await exchangeDeployGrant(deps, requestId, grant);
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploy_status', buildState: 'failed', stage: 'deploying', resultCode: 'CFN_DEPLOY_FAILED' }) as never);
    deps.clock.t += 31_000;
    await pollDeploys(deps, deps.clock.t);
    expect(deps.store.deploys.get(requestId)).toMatchObject({ sessionHash: null, grantEnc: null });
    expect((await refusal(authenticateDeploySession(deps, requestId, `Bearer ${sessionToken}`))).details?.reason).toBe('unknown');
  });
});

describe('the sweep\'s deploy_status poll', () => {
  it('running: the stage updates and the next poll is scheduled; deploy_status carries the request and build, signed for a deploy:1 runner only', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    deps.clock.t += 31_000;
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploy_status', buildState: 'in_progress', stage: 'synthesizing', resultCode: null }) as never);
    expect(await pollDeploys(deps, deps.clock.t)).toMatchObject({ polled: 1, finished: 0 });
    expect(claimsOf(String(deps.fetchMock.mock.calls.at(-1)![1].body))).toMatchObject({ action: 'deploy_status', deployRequestId: requestId, buildId: BUILD(r.id), requestedBy: 'system:deploy-status' });
    expect(deps.store.deploys.get(requestId)).toMatchObject({ stage: 'synthesizing' });
    // Capability gone (setup re-run without --enable-deploy): never asked.
    deps.store.runners.set(r.id, { ...r, capabilities: [] });
    deps.clock.t += 31_000;
    deps.fetchMock.mockClear();
    await pollDeploys(deps, deps.clock.t);
    expect(deps.fetchMock).not.toHaveBeenCalled();
  });

  it('succeeded → deployed: the one registry upsert links the runner; counted, timed and audited (system actor, no account data)', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    deps.clock.t += 600_000;
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploy_status', buildState: 'succeeded', stage: 'done', resultCode: 'OK' }) as never);
    await pollDeploys(deps, deps.clock.t);
    expect(deps.store.requests.get(requestId)).toMatchObject({ status: 'deployed', errorCode: null });
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: r.id, linkStatus: 'linked', pipelineName: 'acme-shop-pipeline' });
    expect(deps.counterAdds).toContainEqual([RUNNER_DEPLOY_METRICS.deploys, { outcome: 'deployed' }, 1]);
    expect(deps.observed).toContainEqual([RUNNER_DEPLOY_METRICS.duration, { action: 'deploy' }, 600]);
    expect(deps.audits).toContainEqual(expect.objectContaining({
      action: 'pipeline.deploy.complete',
      actorId: 'system',
      targetId: PIPE,
      details: expect.objectContaining({ outcome: 'deployed', requestId, runnerId: r.id, region: 'us-east-1', linked: true, durationMs: 600_000, errorCode: null }),
    }));
    expect((await readDeploy(deps, ORG, PIPE, 'latest'))).toMatchObject({ status: 'deployed', stage: 'done', failureClass: null, retryable: false });
  });

  it('failed with the job\'s code → failed + its class; stopped after a cancel → cancelled; CodeBuild timeout → DEPLOY_TIMED_OUT', async () => {
    const cases: Array<[Record<string, unknown>, boolean, Record<string, unknown>]> = [
      [{ buildState: 'failed', stage: 'prechecking', resultCode: 'CDK_NOT_BOOTSTRAPPED' }, false, { status: 'failed', errorCode: 'CDK_NOT_BOOTSTRAPPED' }],
      [{ buildState: 'failed', stage: null, resultCode: null }, false, { status: 'failed', errorCode: 'DEPLOY_JOB_ERROR' }],
      [{ buildState: 'stopped', stage: 'deploying', resultCode: null }, true, { status: 'cancelled', errorCode: 'DEPLOY_CANCELLED' }],
      [{ buildState: 'timed_out', stage: 'deploying', resultCode: null }, false, { status: 'failed', errorCode: 'DEPLOY_TIMED_OUT' }],
    ];
    for (const [status, cancelled, want] of cases) {
      const r = deployable();
      const deps = withRunners(r);
      const requestId = await accepted(deps, r);
      if (cancelled) deps.store.deploys.set(requestId, { ...deps.store.deploys.get(requestId)!, cancelRequestedAt: new Date(deps.clock.t) });
      deps.clock.t += 31_000;
      deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploy_status', ...status }) as never);
      await pollDeploys(deps, deps.clock.t);
      expect(deps.store.requests.get(requestId)).toMatchObject(want);
      expect(deps.store.registry.get(PIPE)).toBeUndefined();
    }
    // The job's own result post is shown at once and decides a code-less failure.
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    const pair = { request: deps.store.requests.get(requestId)!, deploy: deps.store.deploys.get(requestId)! };
    await recordDeployResult(deps, pair, 'ACCOUNT_SECRETS_MISSING', 'prechecking');
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploy_status', buildState: 'failed' }) as never);
    await pollDeploys(deps, deps.clock.t);
    const dto = await readDeploy(deps, ORG, PIPE, requestId);
    expect(dto).toMatchObject({ status: 'failed', errorCode: 'ACCOUNT_SECRETS_MISSING', failureClass: 'account_setup', retryable: true, stage: 'prechecking' });
    expect(deps.counterAdds).toContainEqual([RUNNER_DEPLOY_METRICS.failuresByClass, { class: 'account_setup' }, 1]);
  });

  it('past the deadline: deploy_cancel (StopBuild) is sent and the deploy fails DEPLOY_TIMED_OUT; the overdue gauge is published', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    deps.clock.t += 121 * 60_000;
    deps.fetchMock.mockResolvedValue(reply(200, { outcome: 'deploy_cancelled', buildState: 'in_progress' }) as never);
    expect(await pollDeploys(deps, deps.clock.t)).toMatchObject({ timedOut: 1 });
    expect(claimsOf(String(deps.fetchMock.mock.calls.at(-1)![1].body))).toMatchObject({ action: 'deploy_cancel', deployRequestId: requestId });
    expect(deps.store.requests.get(requestId)).toMatchObject({ status: 'failed', errorCode: 'DEPLOY_TIMED_OUT' });
    expect(deps.gaugeValues.get(RUNNER_DEPLOY_METRICS.overdue)).toBe(0);
  });

  it('past the deadline, a build that already finished (nobody polled: the platform was down) keeps its real outcome — never cancelled or timed out', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    deps.clock.t += 121 * 60_000;
    deps.fetchMock.mockClear();
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploy_status', buildState: 'succeeded', stage: 'done', resultCode: 'OK' }) as never);
    expect(await pollDeploys(deps, deps.clock.t)).toMatchObject({ finished: 1, timedOut: 0 });
    expect(deps.fetchMock.mock.calls.map((c) => claimsOf(String(c[1].body)).action)).toEqual(['deploy_status']);
    expect(deps.store.requests.get(requestId)).toMatchObject({ status: 'deployed', errorCode: null });
    expect(deps.store.registry.get(PIPE)).toMatchObject({ runnerId: r.id, linkStatus: 'linked' });
  });

  it('DEPLOY_BUILD_NOT_FOUND fails it; a revoked runner expires it (RUNNER_REVOKED)', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    deps.clock.t += 31_000;
    deps.fetchMock.mockResolvedValueOnce(reply(404, { errorCode: 'DEPLOY_BUILD_NOT_FOUND' }) as never);
    await pollDeploys(deps, deps.clock.t);
    expect(deps.store.requests.get(requestId)).toMatchObject({ status: 'failed', errorCode: 'DEPLOY_BUILD_NOT_FOUND' });

    const r2 = deployable();
    const deps2 = withRunners(r2);
    const id2 = await accepted(deps2, r2);
    deps2.store.runners.set(r2.id, { ...r2, status: 'revoked' });
    deps2.clock.t += 31_000;
    await pollDeploys(deps2, deps2.clock.t);
    expect(deps2.store.requests.get(id2)).toMatchObject({ status: 'expired', errorCode: 'RUNNER_REVOKED' });
  });
});

describe('cancel', () => {
  it('queued → cancelled at once; a delivery in flight that then answers deploying gets its build stopped', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const { requestId } = await startDeploy(deps, facts(), {}, 'u');
    const pair = await cancelDeploy(deps, ORG, PIPE, requestId, 'user-2');
    expect(pair.request).toMatchObject({ status: 'cancelled', errorCode: 'DEPLOY_CANCELLED' });
    expect(pair.deploy).toMatchObject({ cancelledBy: 'user-2', grantEnc: null });
    expect((await refusal(cancelDeploy(deps, ORG, PIPE, requestId, 'u'))).code).toBe('DEPLOY_NOT_CANCELLABLE');
    expect((await refusal(cancelDeploy(deps, PARENT, PIPE, requestId, 'u'))).code).toBe('NOT_FOUND');

    // In flight: cancelled meanwhile, the runner's late `deploying` is answered with deploy_cancel.
    const deps2 = withRunners(r);
    const q = await startDeploy(deps2, facts(), {}, 'u');
    deps2.fetchMock.mockImplementationOnce(async () => {
      await cancelDeploy(deps2, ORG, PIPE, q.requestId, 'u');
      return reply(200, { outcome: 'deploying', buildId: BUILD(r.id) }) as never;
    });
    deps2.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploy_cancelled', buildState: 'in_progress' }) as never);
    await processDelivery(deps2, q.requestId);
    expect(claimsOf(String(deps2.fetchMock.mock.calls.at(-1)![1].body))).toMatchObject({ action: 'deploy_cancel', buildId: BUILD(r.id) });
    expect(deps2.store.requests.get(q.requestId)!.status).toBe('cancelled');
  });

  it('deploying → deploy_cancel now (and again on each poll until stopped); the poll records cancelled', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const requestId = await accepted(deps, r);
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploy_cancelled', buildState: 'in_progress' }) as never);
    const pair = await cancelDeploy(deps, ORG, PIPE, requestId, 'u');
    expect(pair.request.status).toBe('deploying');
    expect(claimsOf(String(deps.fetchMock.mock.calls.at(-1)![1].body))).toMatchObject({ action: 'deploy_cancel' });
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploy_status', buildState: 'stopped' }) as never);
    await pollDeploys(deps, deps.clock.t);
    expect(deps.store.requests.get(requestId)).toMatchObject({ status: 'cancelled', errorCode: 'DEPLOY_CANCELLED' });
  });
});

describe('the DTO', () => {
  it('logHint names the runner\'s project, log group and build — never an account id', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const { requestId } = await startDeploy(deps, facts(), {}, 'u');
    expect((await readDeploy(deps, ORG, PIPE, requestId))!.logHint).toBeNull();
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploying', buildId: BUILD(r.id) }) as never);
    await processDelivery(deps, requestId);
    const dto = (await readDeploy(deps, ORG, PIPE, requestId))!;
    expect(dto.logHint).toEqual({ project: deployProjectName(r.id), logGroup: `/aws/codebuild/${deployProjectName(r.id)}`, buildId: BUILD(r.id) });
    expect(dto).toMatchObject({ status: 'deploying', runnerLabel: r.label, region: 'us-east-1', stage: 'starting' });
    expect(dto.deadlineAt).not.toBeNull();
    expect(JSON.stringify(dto)).not.toMatch(/arn:|:\d{12}:/);
    expect(await readDeploy(deps, PARENT, PIPE, requestId)).toBeNull();
  });
});

describe('undeploy on purge', () => {
  const deployment = (runnerId: string | null) => ({ registryId: 'reg', stackName: 'shop-acme', region: 'us-east-1', pipelineName: 'acme-shop-pipeline', runnerId });
  const toolchain = async () => ({ releaseVersion: '1.2.0', imageDigest: DIGEST, deployJobProtocol: DEPLOY_JOB_PROTOCOL_VERSION });

  it('the stack stays when no runner is linked, the runner lacks deploy:1, or the toolchain has no deploy job', async () => {
    const old = runnerRow();
    const deps = withRunners(old);
    expect(await planUndeploy(deps, ORG, PIPE, undefined, deployment(null), toolchain)).toEqual({ kind: 'retained', reason: 'no_runner' });
    expect(await planUndeploy(deps, ORG, PIPE, undefined, deployment(old.id), toolchain)).toEqual({ kind: 'retained', reason: 'runner_not_deploy_capable' });
    const r = deployable();
    deps.store.runners.set(r.id, r);
    expect(await planUndeploy(deps, ORG, PIPE, undefined, deployment(r.id), async () => ({ releaseVersion: '1.0.0', imageDigest: DIGEST, deployJobProtocol: null })))
      .toEqual({ kind: 'retained', reason: 'toolchain_too_old' });
  });

  it('a deploy-capable linked runner gets a signed undeploy (mode undeploy, the stack\'s names); its outcome is audited pipeline.undeploy.complete', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const plan = await planUndeploy(deps, ORG, PIPE, undefined, deployment(r.id), toolchain);
    expect(plan).toMatchObject({ kind: 'undeploy', runnerId: r.id });
    const requestId = await startUndeploy(deps, plan as Extract<typeof plan, { kind: 'undeploy' }>);
    expect(deps.store.requests.get(requestId)).toMatchObject({ action: 'undeploy', requestedBy: 'system:undeploy', status: 'queued' });
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'undeploying', buildId: BUILD(r.id) }) as never);
    await processDelivery(deps, requestId);
    expect(claimsOf(String(deps.fetchMock.mock.calls.at(-1)![1].body))).toMatchObject({ action: 'undeploy', deploy: { mode: 'undeploy', stackName: 'shop-acme', region: 'us-east-1' } });
    expect(deps.store.requests.get(requestId)!.status).toBe('undeploying');
    deps.clock.t += 31_000;
    deps.fetchMock.mockResolvedValueOnce(reply(200, { outcome: 'deploy_status', buildState: 'succeeded', stage: 'done', resultCode: 'OK' }) as never);
    await pollDeploys(deps, deps.clock.t);
    expect(deps.store.requests.get(requestId)!.status).toBe('undeployed');
    expect(deps.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.undeploy.complete', actorId: 'system', details: expect.objectContaining({ outcome: 'undeployed', requestId }) }));
    // An undeploy never (re-)registers the pipeline.
    expect(deps.store.registry.get(PIPE)).toBeUndefined();
  });

  it('the claim of an undeploy is the same signed block (KMS-wrapped by the runner), with mode undeploy', async () => {
    const r = deployable();
    const deps = withRunners(r);
    const plan = await planUndeploy(deps, ORG, PIPE, undefined, deployment(r.id), toolchain);
    const requestId = await startUndeploy(deps, plan as Extract<typeof plan, { kind: 'undeploy' }>);
    const claim = await deployClaimFor(deps, deps.store.requests.get(requestId)!, deps.store.deploys.get(requestId)!);
    expect(claim).toMatchObject({ mode: 'undeploy', protocol: DEPLOY_JOB_PROTOCOL_VERSION, image: { repository: 'system/cdk-synth', digest: DIGEST } });
  });
});
