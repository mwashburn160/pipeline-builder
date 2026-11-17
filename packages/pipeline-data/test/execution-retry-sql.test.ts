// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A retried CodePipeline stage, through the REAL report queries on a REAL Postgres.
 *
 * Retrying a failed stage re-opens the SAME execution: AWS sends a terminal
 * FAILED, then RESUMED, then a second terminal status for the same execution,
 * stage and action. The reports used to read "any FAILED" as the outcome and
 * count every terminal row as a run, so one run that succeeded on retry showed as
 * failed, counted twice, and halved the success rate.
 *
 * The first fixture is the run that exposed it (system-spring_boot_java-pipeline,
 * 2026-11-17): synth failed at 19:54:45, the stage was retried, the run succeeded
 * at 20:02:40. Its RESUMED rows are missing (the ingest refused RESUMED then) and
 * its events landed out of order (a dead-letter redrive), which is exactly the
 * data the fix has to read correctly.
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { drizzle } from 'drizzle-orm/pglite';
import { bootInitDb } from '../src/testing/pglite-init.js';

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

// The reports run in the tenant transaction; here they run on PGlite as the
// superuser (RLS is exercised by rls-integration.test.ts). Caches pass through.
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) => fn(db),
  withTenantTxRead: (fn: (tx: unknown) => unknown) => fn(db),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
const passThrough = { getOrSet: <T>(_k: string, fn: () => Promise<T>) => fn(), invalidatePattern: async () => undefined };
jest.unstable_mockModule('../src/api/reporting/caches.js', () => ({
  inventoryCache: passThrough,
  timeseriesCache: passThrough,
  invalidateOrgReports: async () => undefined,
}));

const { reportingService } = await import('../src/api/reporting-service.js');
const { rebuildDay } = await import('../src/api/reporting/daily-rollup.js');
const { getDoraTrend, getBuildHealth } = await import('../src/api/reporting/dora.js');
const { upsertDeployments } = await import('../src/api/reporting/deploy-rollup.js');

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const PIPE = randomUUID();
const DAY = '2026-11-17';
const FROM = `${DAY}T00:00:00Z`;
const TO = `${DAY}T23:59:59Z`;
const t = (hms: string) => `${DAY}T${hms}Z`;

beforeAll(async () => {
  pg = await bootInitDb();
  db = drizzle(pg);
  await pg.query(
    `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, props, created_by, updated_by)
     VALUES ($1, $2, 'spring_boot_java', 'system', 'system-spring_boot_java-pipeline', '{}'::jsonb, 'u1', 'u1')`,
    [PIPE, ORG],
  );
}, 120_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.query('DELETE FROM execution_daily_rollups');
  await pg.query('DELETE FROM dora_deployments');
  await pg.query('DELETE FROM pipeline_events');
});

interface Ev {
  type: 'PIPELINE' | 'STAGE' | 'ACTION';
  status: string;
  stage?: string;
  action?: string;
  /** started_at — the execution's start, or (RESUMED) the moment it resumed. */
  start: string;
  /** completed_at — terminal rows only. */
  end?: string;
  durationMs?: number;
  environment?: string;
  failure?: Record<string, unknown>;
  /** When the platform stored it (a redrive stores old events late). */
  storedAt?: string;
}

async function seed(executionId: string, events: Ev[]): Promise<void> {
  for (const ev of events) {
    await pg.query(
      `INSERT INTO pipeline_events
         (pipeline_id, org_id, event_source, event_type, status, execution_id, stage_name, action_name,
          started_at, completed_at, duration_ms, environment, detail, source_event_id, created_at)
       VALUES ($1, $2, 'codepipeline', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        PIPE, ORG, ev.type, ev.status, executionId, ev.stage ?? null, ev.action ?? null,
        ev.start, ev.end ?? null, ev.durationMs ?? null, ev.environment ?? null,
        ev.failure ? JSON.stringify({ failure: ev.failure }) : null,
        randomUUID(), ev.storedAt ?? ev.end ?? ev.start,
      ],
    );
  }
}

const RUN_START = t('19:53:40');
const SYNTH = 'cdk_90548b0c_synth_1';
const SYNTH_FAILURE = { code: 'SYNTH_FAILED', message: 'synth failed' };

/** The 2026-11-17 run as stored: no RESUMED rows; the redriven half stored first. */
const retriedThenSucceeded: Ev[] = [
  // Redriven first (stored 21:13), though they happened last.
  { type: 'ACTION', status: 'SUCCEEDED', stage: 'Build', action: SYNTH, start: t('19:59:54'), end: t('20:00:41'), durationMs: 47_000, storedAt: t('21:13:00') },
  { type: 'STAGE', status: 'SUCCEEDED', stage: 'Build', start: t('19:53:46'), end: t('20:00:42'), durationMs: 416_000, storedAt: t('21:13:00') },
  { type: 'PIPELINE', status: 'SUCCEEDED', start: RUN_START, end: t('20:02:40'), durationMs: 539_606, storedAt: t('21:13:00') },
  // Then the first half, stored even later.
  { type: 'PIPELINE', status: 'STARTED', start: RUN_START, storedAt: t('21:13:30') },
  { type: 'STAGE', status: 'STARTED', stage: 'Build', start: t('19:53:46'), storedAt: t('21:13:30') },
  { type: 'ACTION', status: 'STARTED', stage: 'Build', action: SYNTH, start: t('19:53:47'), storedAt: t('21:13:30') },
  { type: 'ACTION', status: 'FAILED', stage: 'Build', action: SYNTH, start: t('19:53:47'), end: t('19:54:45'), durationMs: 58_000, failure: SYNTH_FAILURE, storedAt: t('21:13:30') },
  { type: 'STAGE', status: 'FAILED', stage: 'Build', start: t('19:53:46'), end: t('19:54:45'), durationMs: 59_000, storedAt: t('21:13:30') },
  { type: 'PIPELINE', status: 'FAILED', start: RUN_START, end: t('19:54:45'), durationMs: 65_000, storedAt: t('21:13:30') },
];

/** The rows CodePipeline sends on a retry, as the new Lambda stamps them. */
const resumed: Ev[] = [
  { type: 'PIPELINE', status: 'RESUMED', start: t('19:59:50') },
  { type: 'STAGE', status: 'RESUMED', stage: 'Build', start: t('19:59:50') },
];

const failedNoRetry: Ev[] = [
  { type: 'PIPELINE', status: 'STARTED', start: RUN_START },
  { type: 'STAGE', status: 'FAILED', stage: 'Build', start: t('19:53:46'), end: t('19:54:45'), durationMs: 59_000 },
  { type: 'ACTION', status: 'FAILED', stage: 'Build', action: SYNTH, start: t('19:53:47'), end: t('19:54:45'), durationMs: 58_000, failure: SYNTH_FAILURE },
  { type: 'PIPELINE', status: 'FAILED', start: RUN_START, end: t('19:54:45'), durationMs: 65_000 },
];

const list = () => reportingService.listPipelineExecutions(ORG, PIPE, undefined, { from: FROM, to: TO });
const count = async () => (await reportingService.getExecutionCount(ORG, undefined, { from: FROM, to: TO }))[0];

describe('a stage that failed and passed on retry (the 2026-11-17 run)', () => {
  beforeEach(async () => { await seed('exec-retried', retriedThenSucceeded); });

  it('lists ONE execution, succeeded and marked retried, with no failing stage', async () => {
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      execution_id: 'exec-retried',
      status: 'succeeded',
      retried: true,
      failing_stage: null,
      failing_action: null,
      failure: null,
      duration_ms: 539_606,
    });
  });

  it('counts it once, as a success', async () => {
    expect(await count()).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
  });

  it('reports a 100% success rate, not 50%', async () => {
    const [bucket] = await reportingService.getSuccessRate(ORG, 'day', FROM, TO);
    expect(bucket).toMatchObject({ succeeded: 1, failed: 0, success_pct: 100 });
  });

  it('measures one run, start to final outcome', async () => {
    const [stats] = await reportingService.getAverageDuration(ORG, FROM, TO);
    expect(stats).toMatchObject({ executions: 1, avg_ms: 539_606 });
  });

  it('keeps the stage-failure history: Build DID fail once', async () => {
    const stages = await reportingService.getStageFailures(ORG, FROM, TO);
    expect(stages.find((s) => s.stage_name === 'Build')).toMatchObject({ failures: 1 });
  });

  it('rolls the day up as one successful run at both grains', async () => {
    await rebuildDay(new Date(FROM));
    const { rows } = await pg.query<{ stage_name: string; runs: number; succeeded: number; failed: number }>(
      'SELECT stage_name, runs, succeeded, failed FROM execution_daily_rollups ORDER BY stage_name',
    );
    expect(rows).toEqual([
      { stage_name: '', runs: 1, succeeded: 1, failed: 0 },
      { stage_name: 'Build', runs: 1, succeeded: 1, failed: 0 },
    ]);
  });

  it('gives build health one successful Build run', async () => {
    const health = await getBuildHealth(ORG, PIPE, FROM, TO);
    expect(health.stages.find((s) => s.stage === 'Build')).toMatchObject({ runs: 1, successes: 1, failures: 0 });
  });
});

describe('RESUMED rows (accepted at ingest from now on)', () => {
  it('a retried run that finished: still one success, and RESUMED adds no attempt', async () => {
    await seed('exec-retried', [...retriedThenSucceeded, ...resumed]);
    expect((await list())[0]).toMatchObject({ status: 'succeeded', retried: true });
    expect(await count()).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    const stages = await reportingService.getStageFailures(ORG, FROM, TO);
    // STARTED + FAILED + SUCCEEDED; the RESUMED row is not an attempt.
    expect(stages.find((s) => s.stage_name === 'Build')).toMatchObject({ failures: 1, total: 3 });
  });

  it('a run resumed and still running is in progress, and counted nowhere yet', async () => {
    await seed('exec-running', [...failedNoRetry, ...resumed]);
    expect((await list())[0]).toMatchObject({ status: 'in-progress', retried: true, failing_stage: null });
    expect(await count()).toBeUndefined();
    expect(await reportingService.getSuccessRate(ORG, 'day', FROM, TO)).toEqual([]);
  });

  it('a RESUMED row from an older Lambda (execution start time) changes no outcome', async () => {
    await seed('exec-old', [...failedNoRetry, { type: 'PIPELINE', status: 'RESUMED', start: RUN_START }]);
    expect((await list())[0]).toMatchObject({ status: 'failed', failing_stage: 'Build' });
  });
});

describe('what must NOT change', () => {
  it('a failure nobody retried stays failed, with its failing stage and action', async () => {
    await seed('exec-failed', failedNoRetry);
    expect((await list())[0]).toMatchObject({
      status: 'failed', retried: false, failing_stage: 'Build', failing_action: SYNTH, failure: SYNTH_FAILURE,
    });
    expect(await count()).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
  });

  it('a retry that fails again is one failed run', async () => {
    await seed('exec-twice', [
      ...failedNoRetry,
      ...resumed,
      { type: 'STAGE', status: 'FAILED', stage: 'Build', start: t('19:59:50'), end: t('20:01:00'), durationMs: 70_000 },
      { type: 'PIPELINE', status: 'FAILED', start: RUN_START, end: t('20:01:00'), durationMs: 440_000 },
    ]);
    expect((await list())[0]).toMatchObject({ status: 'failed', retried: true, failing_stage: 'Build', duration_ms: 440_000 });
    expect(await count()).toMatchObject({ total: 1, failed: 1 });
  });

  it('a sibling stage never overtakes a failed stage', async () => {
    await seed('exec-sibling', [
      { type: 'STAGE', status: 'FAILED', stage: 'Deploy', start: RUN_START, end: t('19:55:00') },
      { type: 'STAGE', status: 'SUCCEEDED', stage: 'Build', start: RUN_START, end: t('19:58:00') },
      { type: 'PIPELINE', status: 'FAILED', start: RUN_START, end: t('19:55:00'), durationMs: 80_000 },
    ]);
    expect((await list())[0]).toMatchObject({ status: 'failed', retried: false, failing_stage: 'Deploy' });
  });

  it('two separate executions are still two runs', async () => {
    await seed('exec-1', failedNoRetry);
    await seed('exec-2', retriedThenSucceeded);
    expect(await count()).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(await list()).toHaveLength(2);
  });
});

describe('DORA: a deploy stage that passed on retry', () => {
  const deployRetried: Ev[] = [
    { type: 'STAGE', status: 'FAILED', stage: 'DeployProd', environment: 'production', start: t('19:55:00'), end: t('19:56:00') },
    { type: 'STAGE', status: 'SUCCEEDED', stage: 'DeployProd', environment: 'production', start: t('19:55:00'), end: t('20:05:00') },
  ];

  it('is one successful deployment, not a failed one', async () => {
    await seed('exec-deploy', deployRetried);
    const [point] = await getDoraTrend(ORG, 'day', FROM, TO);
    expect(point).toMatchObject({ deployments: 1, failed: 0, total: 1 });
  });

  it('a late-arriving FAILED does not overwrite the deployment row the later SUCCEEDED wrote', async () => {
    const base = { orgId: ORG, pipelineId: PIPE, executionId: 'exec-deploy', eventType: 'STAGE', stageName: 'DeployProd', environment: 'production' };
    await upsertDeployments([{ ...base, status: 'SUCCEEDED', completedAt: new Date(t('20:05:00')) }]);
    await upsertDeployments([{ ...base, status: 'FAILED', completedAt: new Date(t('19:56:00')) }]);
    const { rows } = await pg.query<{ succeeded: boolean; deployed_at: Date }>('SELECT succeeded, deployed_at FROM dora_deployments');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.succeeded).toBe(true);
    expect(new Date(rows[0]!.deployed_at).toISOString()).toBe(new Date(t('20:05:00')).toISOString());
  });

  it('in arrival order, the later event still wins (FAILED then SUCCEEDED)', async () => {
    const base = { orgId: ORG, pipelineId: PIPE, executionId: 'exec-deploy', eventType: 'STAGE', stageName: 'DeployProd', environment: 'production' };
    await upsertDeployments([{ ...base, status: 'FAILED', completedAt: new Date(t('19:56:00')) }]);
    await upsertDeployments([{ ...base, status: 'SUCCEEDED', completedAt: new Date(t('20:05:00')) }]);
    const { rows } = await pg.query<{ succeeded: boolean }>('SELECT succeeded FROM dora_deployments');
    expect(rows.map((r) => r.succeeded)).toEqual([true]);
  });
});
