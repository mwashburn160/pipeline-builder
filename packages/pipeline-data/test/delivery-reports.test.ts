// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Delivery reports — run latency and runner reliability, and the deployment
 * calendar — against a REAL Postgres (the init script, the application role,
 * FORCE RLS), through the module functions the dashboard routes call.
 *
 * Pinned judgements:
 *  - outcomes: started/stopped = started, a runner 401/403 = refused, expired,
 *    other failures = failed, queued/delivering = pending; probes are not runs;
 *  - failure codes outside the RUNNER_ERRORS catalog collapse to OTHER;
 *  - latency is request → the started execution's start, median and p90;
 *  - a runner owned outside the scope shows its label and health only while it
 *    is still shared with teams; NO function URL, key or requester ever leaves;
 *  - buckets and calendar days honour the report timezone;
 *  - a team's rows stay out of a single-org read and come in on a rollup;
 *  - another org's rows never appear.
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  getDeploymentCalendar, getRunnerReliability, type DeliveryScope,
} from '../src/api/reporting/delivery.js';
import { asTenantContext, bootTenantDb, type TenantTestDb } from '../src/testing/index.js';

let tdb: TenantTestDb;
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'org-dlv';
const TEAM = 'org-dlv-team';
const PARENT = 'org-dlv-parent';
const OTHER = 'org-dlv-other';
const PIPE = randomUUID();
const PIPE_TEAM = randomUUID();
const PIPE_OTHER = randomUUID();
const R_OWN = randomUUID();
const R_SHARED = randomUUID();
const R_UNSHARED = randomUUID();
const R_OTHER = randomUUID();
const R_IDLE = randomUUID();
const R_TEAM = randomUUID();
const R_PARENT_IDLE = randomUUID();
const R_PARENT_IDLE_PRIVATE = randomUUID();
const R_PARENT_IDLE_REVOKED = randomUUID();
const R_GRANDPARENT_IDLE = randomUUID();
const GRANDPARENT = 'org-dlv-grandparent';
const FROM = '2026-09-01T00:00:00Z';
const TO = '2026-10-01T00:00:00Z';
const SCOPE: DeliveryScope = { orgId: ORG, from: FROM, to: TO };
const SECRET_URL = 'https://abc123secret.lambda-url.us-east-1.on.aws/';

const runners = (scope: DeliveryScope = SCOPE, bucket: Record<string, unknown> = {}) =>
  asTenantContext({ orgId: scope.orgId }, () => getRunnerReliability(scope, { interval: 'week', tz: 'UTC', ...bucket }));
const calendar = (scope: DeliveryScope = SCOPE, tz = 'UTC') =>
  asTenantContext({ orgId: scope.orgId }, () => getDeploymentCalendar(scope, { tz }));

interface ReqSeed {
  org?: string;
  pipelineId?: string;
  runnerId?: string | null;
  action?: 'start' | 'stop' | 'probe';
  status: string;
  errorCode?: string | null;
  requestedAt: string;
  resultExecutionId?: string | null;
  acceptedAt?: string | null;
}

async function seedRequest(s: ReqSeed): Promise<void> {
  await owner((db) => db.query(
    `INSERT INTO pipeline_run_requests
       (org_id, pipeline_id, action, requested_by, requested_at, expires_at, status, runner_id, attempts, error_code, result_execution_id, accepted_at)
     VALUES ($1, $2, $3, 'alice@example.com', $4, $4::timestamptz + INTERVAL '10 minutes', $5, $6, 1, $7, $8, $9)`,
    [s.org ?? ORG, s.pipelineId ?? PIPE, s.action ?? 'start', s.requestedAt, s.status, s.runnerId === undefined ? R_OWN : s.runnerId,
      s.errorCode ?? null, s.resultExecutionId ?? null, s.acceptedAt ?? null],
  ));
}

async function seedExecutionStart(pipelineId: string, org: string, executionId: string, startedAt: string): Promise<void> {
  await owner((db) => db.query(
    `INSERT INTO pipeline_events (pipeline_id, org_id, event_source, event_type, status, execution_id, started_at)
     VALUES ($1, $2, 'codepipeline', 'PIPELINE', 'STARTED', $3, $4)`,
    [pipelineId, org, executionId, startedAt],
  ));
}

async function seedDeploy(d: {
  org?: string;
  executionId: string;
  environment?: string;
  pipelineId?: string;
  deployedAt: string;
  succeeded?: boolean;
  commitCount?: number | null;
}): Promise<void> {
  await owner((db) => db.query(
    `INSERT INTO dora_deployments (org_id, execution_id, environment, pipeline_id, deployed_at, succeeded, commit_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [d.org ?? ORG, d.executionId, d.environment ?? 'production', d.pipelineId ?? PIPE, d.deployedAt, d.succeeded ?? true,
      d.commitCount === undefined ? 1 : d.commitCount],
  ));
}

beforeAll(async () => {
  tdb = await bootTenantDb();
  for (const [id, org, name] of [[PIPE, ORG, 'web-deploy'], [PIPE_TEAM, TEAM, 'mobile-deploy'], [PIPE_OTHER, OTHER, 'their-deploy']] as const) {
    await owner((db) => db.query(
      `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, props, created_by, updated_by)
       VALUES ($1, $2, $3, 'acme', $3, '{}'::jsonb, 'u1', 'u1')`,
      [id, org, name],
    ));
  }
  for (const [id, org, label, shared, health, status, fails] of [
    [R_OWN, ORG, 'own-runner', true, 'unreachable', 'active', 4],
    [R_SHARED, PARENT, 'parent-shared', true, 'healthy', 'active', 2],
    [R_UNSHARED, PARENT, 'parent-private', false, 'healthy', 'active', 0],
    [R_OTHER, OTHER, 'their-runner', true, 'healthy', 'active', 0],
    [R_IDLE, ORG, 'idle-runner', true, 'healthy', 'active', 0],
    [R_TEAM, TEAM, 'team-runner', true, 'healthy', 'active', 0],
    [R_PARENT_IDLE, PARENT, 'parent-idle-shared', true, 'healthy', 'active', 3],
    [R_PARENT_IDLE_PRIVATE, PARENT, 'parent-idle-private', false, 'healthy', 'active', 0],
    [R_PARENT_IDLE_REVOKED, PARENT, 'parent-idle-revoked', true, 'healthy', 'revoked', 0],
    [R_GRANDPARENT_IDLE, GRANDPARENT, 'grandparent-idle-shared', true, 'healthy', 'active', 0],
  ] as const) {
    await owner((db) => db.query(
      `INSERT INTO pipeline_runners (id, org_id, label, function_url, share_with_teams, health, status, consecutive_failures, last_delivery_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2026-09-20T00:00:00Z')`,
      [id, org, label, SECRET_URL, shared, health, status, fails],
    ));
  }

  // ORG, through its own runner. Latencies: 30s, 90s, 60s (stop: no execution start).
  await seedRequest({ status: 'started', requestedAt: '2026-09-02T10:00:00Z', resultExecutionId: 'ex-1' });
  await seedExecutionStart(PIPE, ORG, 'ex-1', '2026-09-02T10:00:30Z');
  await seedRequest({ status: 'started', requestedAt: '2026-09-03T10:00:00Z', resultExecutionId: 'ex-2' });
  await seedExecutionStart(PIPE, ORG, 'ex-2', '2026-09-03T10:01:30Z');
  await seedRequest({ status: 'started', requestedAt: '2026-09-04T10:00:00Z', resultExecutionId: 'ex-3' });
  await seedExecutionStart(PIPE, ORG, 'ex-3', '2026-09-04T10:01:00Z');
  await seedRequest({ action: 'stop', status: 'stopped', requestedAt: '2026-09-04T11:00:00Z' });
  await seedRequest({ status: 'failed', errorCode: 'RUNNER_PERMISSION_DENIED', requestedAt: '2026-09-05T10:00:00Z' });
  await seedRequest({ status: 'failed', errorCode: 'PIPELINE_NOT_FOUND', requestedAt: '2026-09-05T11:00:00Z' });
  await seedRequest({ status: 'failed', errorCode: 'SOMETHING_NOT_IN_THE_CATALOG', requestedAt: '2026-09-05T12:00:00Z' });
  await seedRequest({ status: 'expired', errorCode: 'RUN_REQUEST_EXPIRED', requestedAt: '2026-09-06T10:00:00Z' });
  // Sunday 2026-09-06 22:00 in Chicago, Monday 03:00 UTC.
  await seedRequest({ status: 'queued', requestedAt: '2026-09-07T03:00:00Z' });
  // Through the parent's runners.
  await seedRequest({ runnerId: R_SHARED, status: 'started', requestedAt: '2026-09-10T10:00:00Z' });
  await seedRequest({ runnerId: R_UNSHARED, status: 'failed', errorCode: 'SIGNATURE_INVALID', requestedAt: '2026-09-10T11:00:00Z' });
  // Not counted: a probe, a row outside the window, another org's request.
  await seedRequest({ action: 'probe', status: 'failed', errorCode: 'NO_MATCH', requestedAt: '2026-09-02T09:00:00Z' });
  await seedRequest({ status: 'failed', errorCode: 'RUNNER_ERROR', requestedAt: '2026-10-02T09:00:00Z' });
  await seedRequest({ org: OTHER, pipelineId: PIPE_OTHER, runnerId: R_OTHER, status: 'failed', errorCode: 'RUNNER_ERROR', requestedAt: '2026-09-02T09:00:00Z' });
  // The team's request through its own runner.
  await seedRequest({ org: TEAM, pipelineId: PIPE_TEAM, runnerId: R_TEAM, status: 'started', requestedAt: '2026-09-02T09:00:00Z' });

  // Deployments.
  await seedDeploy({ executionId: 'd-1', deployedAt: '2026-09-02T15:00:00Z', commitCount: 2 });
  await seedDeploy({ executionId: 'd-2', deployedAt: '2026-09-02T16:00:00Z', succeeded: false, commitCount: 4 });
  await seedDeploy({ executionId: 'd-1', environment: 'staging', deployedAt: '2026-09-02T14:00:00Z', commitCount: 2 });
  // 2026-09-03 03:00 UTC is 2026-09-02 22:00 in Chicago.
  await seedDeploy({ executionId: 'd-3', deployedAt: '2026-09-03T03:00:00Z', commitCount: 10 });
  await seedDeploy({ executionId: 'd-4', deployedAt: '2026-09-10T12:00:00Z', commitCount: null });
  await seedDeploy({ executionId: 'd-out', deployedAt: '2026-10-05T12:00:00Z' });
  await seedDeploy({ org: TEAM, executionId: 't-1', pipelineId: PIPE_TEAM, deployedAt: '2026-09-04T12:00:00Z' });
  await seedDeploy({ org: OTHER, executionId: 'o-1', pipelineId: PIPE_OTHER, deployedAt: '2026-09-04T12:00:00Z' });
  await owner((db) => db.query(
    `INSERT INTO deployment_outcomes (execution_id, org_id, environment, outcome, at)
     VALUES ('d-3', $1, 'production', 'failed', '2026-09-03T05:00:00Z')`, [ORG],
  ));
}, 120_000);

afterAll(async () => { await tdb?.close(); });

describe('runner reliability', () => {
  it('classifies every run request by outcome, and leaves probes and other orgs out', async () => {
    const r = await runners();
    expect(r.totals).toEqual({
      requests: 11, started: 5, failed: 2, expired: 1, refused: 2, pending: 1, failureRatePct: 50,
    });
  });

  it('measures request → execution start as median and p90', async () => {
    const r = await runners();
    expect(r.latency).toEqual({ n: 3, nExact: 0, nEstimated: 3, medianSeconds: 60, p90Seconds: 84 });
  });

  it('ranks failure codes, collapsing anything outside the catalog to OTHER', async () => {
    const r = await runners();
    const codes = Object.fromEntries(r.topFailureCodes.map((c) => [c.code, c.count]));
    expect(codes).toEqual({
      RUNNER_PERMISSION_DENIED: 1, PIPELINE_NOT_FOUND: 1, OTHER: 1, RUN_REQUEST_EXPIRED: 1, SIGNATURE_INVALID: 1,
    });
    expect(r.topFailureCodes.find((c) => c.code === 'SIGNATURE_INVALID')?.category).toBe('runner');
    expect(r.topFailureCodes.find((c) => c.code === 'OTHER')?.category).toBe('other');
  });

  it('reports each runner, showing another org\'s runner only while it is shared', async () => {
    const r = await runners();
    const byId = Object.fromEntries(r.runners.map((x) => [x.runnerId, x]));
    expect(byId[R_OWN]).toMatchObject({
      label: 'own-runner',
      ownership: 'own',
      health: 'unreachable',
      status: 'active',
      consecutiveFailures: 4,
      requests: 9,
      started: 4,
      failed: 2,
      expired: 1,
      refused: 1,
      pending: 1,
      failureRatePct: 50,
      lastDeliveryAt: '2026-09-20T00:00:00.000Z',
    });
    expect(byId[R_SHARED]).toMatchObject({ label: 'parent-shared', ownership: 'shared', health: 'healthy', consecutiveFailures: null, requests: 1, started: 1 });
    expect(byId[R_UNSHARED]).toMatchObject({ label: null, ownership: 'shared', health: null, status: null, lastDeliveryAt: null, requests: 1, refused: 1 });
    // The org's own idle runner shows with zeros; nobody else's runner shows at all.
    expect(byId[R_IDLE]).toMatchObject({ label: 'idle-runner', requests: 0, failureRatePct: null });
    expect(byId[R_OTHER]).toBeUndefined();
    expect(byId[R_TEAM]).toBeUndefined();
  });

  it('never returns a function URL, key material or the requester', async () => {
    const json = JSON.stringify(await runners());
    expect(json).not.toContain('lambda-url');
    expect(json).not.toContain('secret');
    expect(json).not.toMatch(/function_?url/i);
    expect(json).not.toContain('alice');
  });

  it('buckets in the report timezone, zero-filled', async () => {
    const utc = await runners(SCOPE, { tz: 'UTC' });
    const chi = await runners(SCOPE, { tz: 'America/Chicago' });
    const pendingWeek = (t: typeof utc.trend) => t.find((p) => p.pending > 0)?.period;
    expect(pendingWeek(utc.trend)).toBe('2026-09-07 00:00:00');
    expect(pendingWeek(chi.trend)).toBe('2026-08-31 00:00:00');
    expect(utc.trend.reduce((a, p) => a + p.requests, 0)).toBe(11);
    expect(utc.trend.every((p) => typeof p.period === 'string')).toBe(true);
    expect(utc.trend.some((p) => p.requests === 0)).toBe(true);
  });

  it('rolls a team in only on a rollup, with the team\'s runner as its own', async () => {
    const r = await runners({ ...SCOPE, orgIds: [ORG, TEAM] });
    expect(r.totals.requests).toBe(12);
    expect(r.runners.find((x) => x.runnerId === R_TEAM)).toMatchObject({ label: 'team-runner', ownership: 'own', requests: 1 });
  });

  it('without the ancestor chain, a parent\'s idle shared runner is not listed', async () => {
    const r = await runners();
    expect(r.runners.find((x) => x.runnerId === R_PARENT_IDLE)).toBeUndefined();
  });

  it('lists runners an ancestor shares with teams even with no requests in the range', async () => {
    const r = await asTenantContext({ orgId: ORG }, () => getRunnerReliability(SCOPE, { interval: 'week', tz: 'UTC' },
      { sharedByOrgIds: [PARENT, GRANDPARENT] }));
    const byId = Object.fromEntries(r.runners.map((x) => [x.runnerId, x]));
    expect(byId[R_PARENT_IDLE]).toMatchObject({
      label: 'parent-idle-shared',
      ownership: 'shared',
      health: 'healthy',
      status: 'active',
      consecutiveFailures: null,
      requests: 0,
      failureRatePct: null,
    });
    expect(byId[R_GRANDPARENT_IDLE]).toMatchObject({ label: 'grandparent-idle-shared', ownership: 'shared', requests: 0 });
    // Not shared with teams, or revoked: never listed when idle.
    expect(byId[R_PARENT_IDLE_PRIVATE]).toBeUndefined();
    expect(byId[R_PARENT_IDLE_REVOKED]).toBeUndefined();
    // Runners that carried requests are unchanged.
    expect(byId[R_SHARED]).toMatchObject({ label: 'parent-shared', requests: 1 });
    expect(byId[R_UNSHARED]).toMatchObject({ label: null, requests: 1 });
    // Another org's runner never appears; totals are untouched.
    expect(byId[R_OTHER]).toBeUndefined();
    expect(r.totals.requests).toBe(11);
    expect(JSON.stringify(r)).not.toContain('lambda-url');
  });

  it('is empty for an org with no runners', async () => {
    const r = await runners({ orgId: 'org-nobody', from: FROM, to: TO });
    expect(r.totals.requests).toBe(0);
    expect(r.runners).toEqual([]);
    expect(r.latency).toEqual({ n: 0, nExact: 0, nEstimated: 0, medianSeconds: null, p90Seconds: null });
  });
});

describe('runner latency: exact accepted_at, estimated fallback', () => {
  const ACC = 'org-dlv-accepted';
  const PIPE_ACC = randomUUID();
  const R_ACC = randomUUID();
  const scope: DeliveryScope = { orgId: ACC, from: FROM, to: TO };

  beforeAll(async () => {
    await owner((db) => db.query(
      `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, props, created_by, updated_by)
       VALUES ($1, $2, 'acc-deploy', 'acme', 'acc-deploy', '{}'::jsonb, 'u1', 'u1')`, [PIPE_ACC, ACC],
    ));
    await owner((db) => db.query(
      `INSERT INTO pipeline_runners (id, org_id, label, function_url, share_with_teams, health, status)
       VALUES ($1, $2, 'acc-runner', $3, true, 'healthy', 'active')`, [R_ACC, ACC, SECRET_URL],
    ));
    const base = { org: ACC, pipelineId: PIPE_ACC, runnerId: R_ACC };
    // accepted_at wins over the execution-start estimate (2 s exact, not 40 s).
    await seedRequest({ ...base, status: 'started', requestedAt: '2026-09-02T10:00:00Z', acceptedAt: '2026-09-02T10:00:02Z', resultExecutionId: 'acc-1' });
    await seedExecutionStart(PIPE_ACC, ACC, 'acc-1', '2026-09-02T10:00:40Z');
    // accepted_at with no ingested execution: still measured, exactly.
    await seedRequest({ ...base, status: 'started', requestedAt: '2026-09-03T10:00:00Z', acceptedAt: '2026-09-03T10:00:04Z', resultExecutionId: 'acc-2' });
    // A row from before accepted_at existed: estimated from the execution start (20 s).
    await seedRequest({ ...base, status: 'started', requestedAt: '2026-09-04T10:00:00Z', resultExecutionId: 'acc-3' });
    await seedExecutionStart(PIPE_ACC, ACC, 'acc-3', '2026-09-04T10:00:20Z');
    // Neither: not in the sample. A stop: not a start, never in the sample.
    await seedRequest({ ...base, status: 'started', requestedAt: '2026-09-05T10:00:00Z', resultExecutionId: 'acc-none' });
    await seedRequest({ ...base, action: 'stop', status: 'stopped', requestedAt: '2026-09-05T11:00:00Z', acceptedAt: '2026-09-05T11:00:09Z' });
  });

  it('measures request → accepted_at where present and falls back to the estimate, saying how many of each', async () => {
    const r = await runners(scope);
    // Samples 2 (exact), 4 (exact), 20 (estimated): median 4, p90 4 + 0.8 × 16 = 16.8.
    expect(r.latency).toEqual({ n: 3, nExact: 2, nEstimated: 1, medianSeconds: 4, p90Seconds: 17 });
  });
});

describe('deployment calendar', () => {
  it('counts deployments per day per environment in the report timezone', async () => {
    const utc = await calendar(SCOPE, 'UTC');
    expect(utc.days).toEqual([
      { day: '2026-09-02', environment: 'production', deployments: 2, failed: 1 },
      { day: '2026-09-02', environment: 'staging', deployments: 1, failed: 0 },
      { day: '2026-09-03', environment: 'production', deployments: 1, failed: 0 },
      { day: '2026-09-10', environment: 'production', deployments: 1, failed: 0 },
    ]);
    const chi = await calendar(SCOPE, 'America/Chicago');
    expect(chi.days.find((d) => d.day === '2026-09-02' && d.environment === 'production')?.deployments).toBe(3);
    expect(chi.environments).toEqual(['production', 'staging']);
  });

  it('reports commits per deploy over deploys with a known count', async () => {
    const c = await calendar();
    expect(c.commitsPerDeploy).toEqual({ n: 4, median: 3, p90: 8.2 });
    expect(c.totals).toEqual({ deployments: 5, failed: 1, commits: 18 });
  });

  it('lists the range\'s production deploys with their outcome, newest first', async () => {
    const c = await calendar();
    expect(c.productionDeploys.count).toBe(4);
    expect(c.productionDeploys.items.map((d) => [d.executionId, d.outcome, d.pipelineName, d.commitCount])).toEqual([
      ['d-4', 'succeeded', 'web-deploy', null],
      ['d-3', 'post_deploy_failure', 'web-deploy', 10],
      ['d-2', 'failed', 'web-deploy', 4],
      ['d-1', 'succeeded', 'web-deploy', 2],
    ]);
    expect(c.productionDeploys.items[0]).toMatchObject({ environment: 'production', deployedAt: '2026-09-10T12:00:00.000Z' });
  });

  it('rolls a team in only on a rollup, and never shows another org', async () => {
    const single = await calendar();
    const rollup = await calendar({ ...SCOPE, orgIds: [ORG, TEAM] });
    expect(rollup.totals.deployments).toBe(single.totals.deployments + 1);
    expect(JSON.stringify(rollup)).not.toContain('their-deploy');
    expect(rollup.productionDeploys.items.some((d) => d.pipelineName === 'mobile-deploy')).toBe(true);
  });
});
