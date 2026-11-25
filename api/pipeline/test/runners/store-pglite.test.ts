// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The Drizzle runner store against a REAL Postgres (PGlite + the shipped init script, as the app role under RLS). */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { PENDING_RUN_REQUEST_STATUSES } from '@pipeline-builder/api-core/pipeline-runners';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';

process.env.JWT_SECRET ||= 'runner-store-test-secret';
const { createDrizzleRunnerStore } = await import('../../src/runners/store.js');

const ORG = '0123456789abcdef01234567';
const OTHER = '0123456789abcdef01234568';
const PIPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const URL_A = 'https://abc123.lambda-url.us-east-1.on.aws/';

let tdb: TenantTestDb;
const store = createDrizzleRunnerStore();
const T = new Date('2026-11-19T12:00:00Z');

beforeAll(async () => { tdb = await bootTenantDb(); }, 120_000);
afterAll(async () => { await tdb?.close(); });
beforeEach(async () => {
  await tdb.asOwner((q) => q.exec('DELETE FROM pipeline_run_requests; DELETE FROM pipeline_runners; DELETE FROM pipeline_registry; DELETE FROM pipelines;'));
});

async function registry(orgId = ORG, runnerId: string | null = null) {
  await tdb.asOwner((q) => q.query(
    "INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, props) VALUES ($1, $2, 'p', 'o', 'acme', '{}')", [PIPE, orgId]));
  await tdb.asOwner((q) => q.query(
    "INSERT INTO pipeline_registry (pipeline_id, org_id, pipeline_name, region, runner_id) VALUES ($1, $2, 'acme-pipe', 'eu-west-1', $3)", [PIPE, orgId, runnerId]));
}

describe('Drizzle runner store (real SQL)', () => {
  it('one PENDING start per pipeline: a second queued/delivering start is rejected (23505), a finished one is not', async () => {
    const r = await store.insertRunner({ orgId: ORG, label: 'a', functionUrl: URL_A, status: 'active' });
    const mk = (over: Record<string, unknown> = {}) => store.insertRequest({
      orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u', requestedAt: T, expiresAt: new Date(T.getTime() + 600_000), runnerId: r.id, ...over,
    });
    const first = await mk();
    const dup = await mk().then(() => null, (err: unknown) => err as { code?: string; cause?: { code?: string } });
    expect(dup?.code ?? dup?.cause?.code).toBe('23505');
    await expect(mk({ status: 'started' })).resolves.toBeTruthy();
    await expect(mk({ action: 'stop', executionId: 'e' })).resolves.toBeTruthy();
    await store.updateRequest(first.id, { status: 'started' });
    const second = await mk();
    // Every PENDING status holds the slot (the same set as PENDING_RUN_REQUEST_STATUSES).
    for (const status of PENDING_RUN_REQUEST_STATUSES) {
      await store.updateRequest(second.id, { status });
      expect(await mk().then(() => 'inserted', () => 'rejected')).toBe('rejected');
    }
  });

  it("a deploy half is tied to its request's org: a cross-org reference is refused (23503), even by a role that bypasses RLS", async () => {
    const reqId = '11111111-1111-4111-8111-111111111111';
    await tdb.asOwner((q) => q.query(
      "INSERT INTO pipeline_run_requests (id, org_id, pipeline_id, action, requested_by, expires_at) VALUES ($1, $2, $3, 'deploy', 'u', now() + interval '10 minutes')",
      [reqId, ORG, PIPE]));
    const deployRow = (orgId: string) => tdb.asOwner((q) => q.query(
      `INSERT INTO pipeline_runner_deploys (request_id, org_id, pipeline_id, region, pipeline_name, stack_name, image_digest, toolchain_release, grant_expires_at)
       VALUES ($1, $2, $3, 'us-east-1', 'p', 's', 'sha256:x', '1.0.0', now())`, [reqId, orgId, PIPE]));
    const crossOrg = await deployRow(OTHER).then(() => null, (err: unknown) => err as { code?: string; cause?: { code?: string } });
    expect(crossOrg?.code ?? crossOrg?.cause?.code).toBe('23503');
    await expect(deployRow(ORG)).resolves.toBeTruthy();
    // The request's delete still takes its deploy half with it.
    await tdb.asOwner((q) => q.query('DELETE FROM pipeline_run_requests WHERE id = $1', [reqId]));
    expect((await tdb.asOwner((q) => q.query('SELECT 1 FROM pipeline_runner_deploys WHERE request_id = $1', [reqId]))).rows).toHaveLength(0);
  });

  it('markRunnerUnreachable: only the call that finds it healthy takes the transition', async () => {
    const a = await store.insertRunner({ orgId: ORG, label: 'a', functionUrl: URL_A, status: 'active' });
    expect((await store.markRunnerUnreachable(a.id))!.health).toBe('unreachable');
    expect(await store.markRunnerUnreachable(a.id)).toBeNull();
  });

  it('runners: insert (pending by default), get, list (active filter), count, update, failure counter, unhealthy count', async () => {
    const a = await store.insertRunner({ orgId: ORG, label: 'a', functionUrl: URL_A, status: 'active' });
    const p = await store.insertRunner({ orgId: ORG, label: 'pending' });
    expect(p).toMatchObject({ status: 'pending', functionUrl: null, regions: [], health: 'healthy' });
    await store.insertRunner({ orgId: OTHER, label: 'o', functionUrl: URL_A, status: 'active' });
    expect((await store.getRunner(a.id))!.label).toBe('a');
    expect((await store.listRunners([ORG])).map((r) => r.label).sort()).toEqual(['a', 'pending']);
    expect((await store.listRunners([ORG], { activeOnly: true })).map((r) => r.label)).toEqual(['a']);
    expect(await store.listRunners([])).toEqual([]);
    expect((await store.listActiveRunners()).length).toBe(2);
    expect(await store.countRunners(ORG)).toBe(2);
    expect((await store.updateRunner(a.id, { health: 'unreachable', regions: ['us-east-1'] }))!.regions).toEqual(['us-east-1']);
    expect((await store.recordRunnerFailure(a.id))!.consecutiveFailures).toBe(1);
    expect(await store.countUnhealthyRunners()).toBe(1);
    expect(await store.getRunner('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await store.updateRunner('00000000-0000-4000-8000-000000000000', { label: 'x' })).toBeNull();
    expect(await store.recordRunnerFailure('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('requests: insert, conditional update, expired / queued listings, caps, pending start, children, retention', async () => {
    const r = await store.insertRunner({ orgId: ORG, label: 'a', functionUrl: URL_A, status: 'active' });
    const mk = (over: Record<string, unknown> = {}) => store.insertRequest({
      orgId: ORG, pipelineId: PIPE, action: 'start', requestedBy: 'u', requestedAt: T, expiresAt: new Date(T.getTime() + 600_000), runnerId: r.id, ...over,
    });
    const q = await mk();
    expect(q).toMatchObject({ status: 'queued', attempts: 0 });
    expect((await store.updateRequest(q.id, { status: 'delivering' }, ['queued']))!.status).toBe('delivering');
    expect(await store.updateRequest(q.id, { status: 'started' }, ['queued'])).toBeNull();
    expect(await store.countDelivering(r.id)).toBe(1);
    expect((await store.findPendingStart(ORG, PIPE))!.id).toBe(q.id);
    expect(await store.countPending(ORG)).toBe(1);
    const probe = await mk({ action: 'probe', parentRequestId: q.id, status: 'failed' });
    expect(await store.hasChildRequests(q.id)).toBe(true);
    expect(await store.hasChildRequests(probe.id)).toBe(false);
    const queued = await mk({ action: 'stop', executionId: 'e' });
    expect((await store.listQueued(10)).map((x) => x.id)).toEqual([queued.id]);
    expect((await store.listRunnerRequests(r.id, ['queued', 'delivering'])).length).toBe(2);
    expect((await store.listExpired(new Date(T.getTime() + 600_001))).map((x) => x.id).sort()).toEqual([q.id, queued.id].sort());
    expect(await store.listExpired(T)).toEqual([]);
    expect((await store.getRequest(q.id))!.id).toBe(q.id);
    expect(await store.deleteRequestsBefore(['failed'], new Date(T.getTime() + 1))).toBe(1);
    expect(await store.getRequest(probe.id)).toBeNull();
  });

  it('pending runners older than the cutoff are deleted, nothing else', async () => {
    await store.insertRunner({ orgId: ORG, label: 'old', createdAt: new Date(T.getTime() - 86_400_001) });
    await store.insertRunner({ orgId: ORG, label: 'old-active', functionUrl: URL_A, status: 'active', createdAt: new Date(T.getTime() - 86_400_001) });
    expect(await store.deletePendingRunnersBefore(new Date(T.getTime() - 86_400_000))).toBe(1);
    expect((await store.listRunners([ORG])).map((r) => r.label)).toEqual(['old-active']);
  });

  it('registry link: read (org-scoped), set, conditional clear, clear all, labels for the Deployment card', async () => {
    const r = await store.insertRunner({ orgId: ORG, label: 'prod', functionUrl: URL_A, status: 'active' });
    await registry();
    expect(await store.getRegistryLink(PIPE, ORG)).toEqual({
      pipelineName: 'acme-pipe', region: 'eu-west-1', runnerId: null, linkStatus: 'unlinked', linkCheckedAt: null, linkDetail: null,
    });
    expect(await store.getRegistryLink(PIPE, OTHER)).toBeNull();
    expect(await store.setRegistryRunner(PIPE, ORG, r.id)).toBe(true);
    expect(await store.setRegistryRunner(PIPE, OTHER, r.id)).toBe(false);
    expect((await store.getRegistryLink(PIPE, ORG))!.linkStatus).toBe('linked');
    expect((await store.runnerLinks([PIPE], ORG)).get(PIPE)).toEqual({ id: r.id, label: 'prod' });
    expect((await store.runnerLinks([PIPE], OTHER)).size).toBe(0);
    expect((await store.runnerLinks([], ORG)).size).toBe(0);
    expect(await store.setRegistryRunner(PIPE, ORG, null, '00000000-0000-4000-8000-000000000000')).toBe(false);
    expect((await store.getRegistryLink(PIPE, ORG))!.runnerId).toBe(r.id);
    expect(await store.clearRunnerLinks(r.id)).toBe(1);
    expect(await store.getRegistryLink(PIPE, ORG)).toMatchObject({ runnerId: null, linkStatus: 'unlinked' });
  });

  it('runner link columns: a probe\'s write (kept runner_id unless a single match), counts, the runner\'s pipelines and the teams using it', async () => {
    const r = await store.insertRunner({ orgId: OTHER, label: 'parent', functionUrl: URL_A, status: 'active' });
    await registry(ORG, r.id);
    const detail = { runnersChecked: ['parent'], matched: [], errorCode: 'PIPELINE_NOT_FOUND_IN_RUNNERS' as const };
    expect(await store.writeRunnerLink(PIPE, ORG, { status: 'not_found', checkedAt: T, detail })).toBe(true);
    expect(await store.getRegistryLink(PIPE, ORG)).toMatchObject({ runnerId: r.id, linkStatus: 'not_found', linkCheckedAt: T, linkDetail: detail });
    expect(await store.writeRunnerLink(PIPE, OTHER, { status: 'checking', checkedAt: T, detail: null })).toBe(false);
    expect((await store.pipelineCounts([r.id, '00000000-0000-4000-8000-000000000000'])).get(r.id)).toBe(1);
    expect((await store.pipelineCounts([])).size).toBe(0);
    expect(await store.listRunnerPipelines(r.id, 10, 0)).toEqual({ rows: [{ id: PIPE, name: 'acme-pipe' }], total: 1 });
    expect(await store.listRunnerPipelines(r.id, 10, 1)).toEqual({ rows: [], total: 1 });
    expect(await store.linkedOrgIds(r.id, OTHER)).toEqual([ORG]);
    expect(await store.linkedOrgIds(r.id, ORG)).toEqual([]);
  });

  it('resetStaleLinkChecks: a row `checking` since before the cutoff goes back to linked / unlinked by its runner_id; a fresh one stays', async () => {
    const r = await store.insertRunner({ orgId: ORG, label: 'own', functionUrl: URL_A, status: 'active' });
    await registry(ORG, r.id);
    await store.writeRunnerLink(PIPE, ORG, { status: 'checking', checkedAt: T, detail: null });
    expect(await store.resetStaleLinkChecks(new Date(T.getTime() - 1))).toBe(0);
    expect((await store.getRegistryLink(PIPE, ORG))!.linkStatus).toBe('checking');
    expect(await store.resetStaleLinkChecks(new Date(T.getTime() + 1))).toBe(1);
    expect((await store.getRegistryLink(PIPE, ORG))!.linkStatus).toBe('linked');
    await store.setRegistryRunner(PIPE, ORG, null);
    await store.writeRunnerLink(PIPE, ORG, { status: 'checking', checkedAt: T, detail: null });
    expect(await store.resetStaleLinkChecks(new Date(T.getTime() + 1))).toBe(1);
    expect((await store.getRegistryLink(PIPE, ORG))!.linkStatus).toBe('unlinked');
  });

  it('deploys: request + deploy half in one tx, one ACTIVE deploy per pipeline (23505), the grant claimed exactly once, the poll and overdue listings', async () => {
    const r = await store.insertRunner({ orgId: ORG, label: 'a', functionUrl: URL_A, status: 'active', capabilities: ['deploy:1'], pipelinePrefixes: ['*'] });
    expect((await store.getRunner(r.id))).toMatchObject({ capabilities: ['deploy:1'], pipelinePrefixes: ['*'], shareDeploysWithTeams: false });
    const half = { orgId: ORG, pipelineId: PIPE, region: 'us-east-1', pipelineName: 'p', stackName: 's', imageDigest: `sha256:${'a'.repeat(64)}`, toolchainRelease: '1.0.0', grantHash: 'h'.repeat(64), grantEnc: '{}', grantExpiresAt: new Date(T.getTime() + 2_700_000) };
    const mk = () => store.insertDeploy({ orgId: ORG, pipelineId: PIPE, action: 'deploy', requestedBy: 'u', requestedAt: T, expiresAt: new Date(T.getTime() + 600_000), runnerId: r.id }, half);
    const { request, deploy } = await mk();
    expect(deploy).toMatchObject({ requestId: request.id, stage: 'queued', finishedAt: null });
    const dup = await mk().then(() => null, (err: unknown) => err as { code?: string; cause?: { code?: string } });
    expect(dup?.code ?? dup?.cause?.code).toBe('23505');
    // The failed second insert left no orphan deploy half behind (one transaction).
    expect((await tdb.asOwner((q) => q.query('SELECT count(*)::int AS n FROM pipeline_runner_deploys'))).rows[0]).toEqual({ n: 1 });
    expect((await store.findActiveDeploy(ORG, PIPE))!.id).toBe(request.id);
    expect(await store.findActiveDeploy(OTHER, PIPE)).toBeNull();
    expect((await store.latestDeploy(ORG, PIPE))!.id).toBe(request.id);
    expect(await store.countActiveDeploys(r.id)).toBe(1);

    const [a, b] = await Promise.all([
      store.claimGrant(request.id, 'h'.repeat(64), { grantUsedAt: T, grantEnc: null }),
      store.claimGrant(request.id, 'h'.repeat(64), { grantUsedAt: T, grantEnc: null }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await store.claimGrant(request.id, 'x'.repeat(64), { grantUsedAt: T })).toBeNull();

    await store.updateRequest(request.id, { status: 'deploying' });
    await store.updateDeploy(request.id, { nextPollAt: new Date(T.getTime() + 30_000), deadlineAt: new Date(T.getTime() + 7_200_000) });
    expect(await store.listDeploysDue(T, 10)).toEqual([]);
    expect((await store.listDeploysDue(new Date(T.getTime() + 30_000), 10)).map((p) => p.request.id)).toEqual([request.id]);
    expect(await store.countOverdueDeploys(T)).toBe(0);
    expect(await store.countOverdueDeploys(new Date(T.getTime() + 7_200_001))).toBe(1);
    await store.updateDeploy(request.id, { finishedAt: T });
    expect(await store.updateDeploy(request.id, { stage: 'done' }, { onlyIfUnfinished: true })).toBeNull();
    await store.updateRequest(request.id, { status: 'deployed' });
    expect(await store.findActiveDeploy(ORG, PIPE)).toBeNull();
    await expect(mk()).resolves.toBeTruthy();
  });
});
