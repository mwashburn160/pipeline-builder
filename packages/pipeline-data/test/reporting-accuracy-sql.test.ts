// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reporting accuracy, through the REAL report queries on a REAL Postgres.
 *
 * The acceptance rule is the one in stakeholder/sections.ts: the numbers in a
 * stakeholder report MUST match the dashboard. Each block below seeds one fixture
 * and reads it through BOTH paths (or through the two halves of one figure, for
 * the DORA trend), so a query that drifts from its sibling fails here rather than
 * in front of a manager comparing the two.
 *
 *  1. Stage/action failure rates count OUTCOMES, not lifecycle rows. A stage that
 *     STARTED, went IN_PROGRESS and then FAILED is one attempt, not three.
 *  2. Time buckets follow the report's timezone and week start.
 *  3. Manual MTTR runs from the failure, not from the deploy.
 *  5. The DORA trend's change-failure buckets add up to the headline CFR.
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
const { getReportSection } = await import('../src/api/reporting/stakeholder/sections.js');
type Source = Parameters<NonNullable<ReturnType<typeof getReportSection>>['run']>[0];
const source = reportingService as unknown as Source;

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const PIPE = randomUUID();

beforeAll(async () => {
  pg = await bootInitDb();
  db = drizzle(pg);
  await pg.query(
    `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, props, created_by, updated_by)
     VALUES ($1, $2, 'acc', 'acc', 'acc-pipeline', '{}'::jsonb, 'u1', 'u1')`,
    [PIPE, ORG],
  );
}, 120_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.query('DELETE FROM execution_daily_rollups');
  await pg.query('DELETE FROM pipeline_events');
  await pg.query('DELETE FROM deployment_outcomes');
  await pg.query('DELETE FROM incidents');
});

interface Ev {
  type: 'PIPELINE' | 'STAGE' | 'ACTION';
  status: string;
  stage?: string;
  action?: string;
  start: string;
  end?: string;
  durationMs?: number;
  environment?: string;
}

async function seed(executionId: string, events: Ev[]): Promise<void> {
  for (const ev of events) {
    await pg.query(
      `INSERT INTO pipeline_events
         (pipeline_id, org_id, event_source, event_type, status, execution_id, stage_name, action_name,
          started_at, completed_at, duration_ms, environment, source_event_id, created_at)
       VALUES ($1, $2, 'codepipeline', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        PIPE, ORG, ev.type, ev.status, executionId, ev.stage ?? null, ev.action ?? null,
        ev.start, ev.end ?? null, ev.durationMs ?? null, ev.environment ?? null,
        randomUUID(), ev.end ?? ev.start,
      ],
    );
  }
}

async function outcome(executionId: string, kind: 'failed' | 'restored', at: string, environment = 'production'): Promise<void> {
  await pg.query(
    'INSERT INTO deployment_outcomes (execution_id, org_id, environment, outcome, at) VALUES ($1, $2, $3, $4, $5)',
    [executionId, ORG, environment, kind, at],
  );
}

async function incident(openedAt: string, resolvedAt: string | null, environment = 'production'): Promise<void> {
  await pg.query(
    `INSERT INTO incidents (incident_id, org_id, environment, opened_at, resolved_at, severity)
     VALUES ($1, $2, $3, $4, $5, 'sev2')`,
    [randomUUID(), ORG, environment, openedAt, resolvedAt],
  );
}

// ── 1. Stage and action failure rates ──────────────────────────────────────

describe('stage and action failure rates count outcomes, not lifecycle rows', () => {
  const DAY = '2026-11-17';
  const FROM = `${DAY}T00:00:00Z`;
  const TO = `${DAY}T23:59:59Z`;
  const t = (hms: string) => `${DAY}T${hms}Z`;

  /** One run of Build/compile: the full lifecycle CodePipeline sends, ending in `status`. */
  const run = (status: 'SUCCEEDED' | 'FAILED', start: string, end: string, durationMs: number): Ev[] => [
    { type: 'PIPELINE', status: 'STARTED', start },
    { type: 'STAGE', status: 'STARTED', stage: 'Build', start },
    { type: 'STAGE', status: 'IN_PROGRESS', stage: 'Build', start },
    { type: 'ACTION', status: 'STARTED', stage: 'Build', action: 'compile', start },
    { type: 'ACTION', status: 'IN_PROGRESS', stage: 'Build', action: 'compile', start },
    ...(status === 'FAILED' ? [{ type: 'STAGE' as const, status: 'STOPPING', stage: 'Build', start }] : []),
    { type: 'ACTION', status, stage: 'Build', action: 'compile', start, end, durationMs },
    { type: 'STAGE', status, stage: 'Build', start, end, durationMs },
    { type: 'PIPELINE', status, start, end, durationMs },
  ];

  beforeEach(async () => {
    await seed('exec-1', run('SUCCEEDED', t('08:00:00'), t('08:10:00'), 600_000));
    await seed('exec-2', run('SUCCEEDED', t('09:00:00'), t('09:10:00'), 600_000));
    await seed('exec-3', run('FAILED', t('10:00:00'), t('10:05:00'), 300_000));
  });

  it('the dashboard stage failure % equals the daily rollup and the stakeholder section', async () => {
    const dashboard = (await reportingService.getStageFailures(ORG, FROM, TO)).find((s) => s.stage_name === 'Build');
    // Three attempts, one failure — not 1 of 9 lifecycle rows.
    expect(dashboard).toMatchObject({ failures: 1, total: 3, failure_pct: 33.3 });

    await rebuildDay(new Date(FROM));
    const { rows } = await pg.query<{ runs: number; failed: number }>(
      "SELECT runs, failed FROM execution_daily_rollups WHERE stage_name = 'Build'",
    );
    const rollupPct = Math.round((rows[0]!.failed / rows[0]!.runs) * 1000) / 10;
    expect(rollupPct).toBe(dashboard!.failure_pct);
    expect(rows[0]!.runs).toBe(dashboard!.total);

    const section = await getReportSection('stage_failures')!.run(source, {
      orgId: ORG, from: FROM, to: TO, tz: 'UTC', weekStart: 'monday',
    }) as Array<{ stage_name: string; failure_pct: number }>;
    expect(section.find((s) => s.stage_name === 'Build')?.failure_pct).toBe(dashboard!.failure_pct);
  });

  it('the action failure rate counts one attempt per run', async () => {
    const [compile] = await reportingService.getActionFailures(ORG, FROM, TO);
    expect(compile).toMatchObject({ action_name: 'compile', failures: 1, total: 3, failure_pct: 33.3 });
  });

  it('a retried stage keeps its earlier failure (the documented heatmap semantics)', async () => {
    await seed('exec-4', [
      { type: 'STAGE', status: 'STARTED', stage: 'Build', start: t('11:00:00') },
      { type: 'STAGE', status: 'FAILED', stage: 'Build', start: t('11:00:00'), end: t('11:01:00') },
      { type: 'STAGE', status: 'RESUMED', stage: 'Build', start: t('11:02:00') },
      { type: 'STAGE', status: 'SUCCEEDED', stage: 'Build', start: t('11:00:00'), end: t('11:05:00') },
    ]);
    const build = (await reportingService.getStageFailures(ORG, FROM, TO)).find((s) => s.stage_name === 'Build');
    // exec-4 adds two terminal attempts (FAILED, then SUCCEEDED); STARTED and RESUMED add none.
    expect(build).toMatchObject({ failures: 2, total: 5 });
  });

  it('averages ignore a lifecycle row that carries a duration', async () => {
    // A STARTED row is not a finished run; its duration (an API caller may send
    // one) must not drag the run average or the stage bottleneck down.
    await seed('exec-5', [
      { type: 'PIPELINE', status: 'STARTED', start: t('12:00:00'), durationMs: 1_000 },
      { type: 'STAGE', status: 'IN_PROGRESS', stage: 'Build', start: t('12:00:00'), durationMs: 1_000 },
    ]);
    const [duration] = await reportingService.getAverageDuration(ORG, FROM, TO);
    expect(duration).toMatchObject({ executions: 3, avg_ms: 500_000 });
    const [bottleneck] = await reportingService.getStageBottlenecks(ORG, FROM, TO);
    expect(bottleneck).toMatchObject({ stage_name: 'Build', avg_ms: 500_000 });
  });
});

// ── 2. Timezone bucketing ───────────────────────────────────────────────────

describe('bucketing in the report timezone matches the stakeholder report', () => {
  const FROM = '2026-11-01T00:00:00Z';
  const TO = '2026-11-30T23:59:59Z';
  const TZ = 'America/Chicago';

  beforeEach(async () => {
    // Sunday 2026-11-15 03:00Z is SATURDAY 21:00 in Chicago, so with Sunday weeks
    // it belongs to the week of Sunday the 8th, while the 18:00Z run (noon Sunday
    // local) opens the week of the 15th. In UTC Monday weeks both are in the week
    // of Monday the 9th.
    await seed('tz-1', [{ type: 'PIPELINE', status: 'SUCCEEDED', start: '2026-11-15T03:00:00Z', end: '2026-11-15T03:05:00Z' }]);
    await seed('tz-2', [{ type: 'PIPELINE', status: 'FAILED', start: '2026-11-15T18:00:00Z', end: '2026-11-15T18:05:00Z' }]);
  });

  it('dashboard success rate with tz + weekStart equals the success_rate section', async () => {
    const dashboard = await reportingService.getSuccessRate(ORG, 'week', FROM, TO, undefined, { tz: TZ, weekStart: 'sunday' });
    const section = await getReportSection('success_rate')!.run(source, {
      orgId: ORG, from: FROM, to: TO, tz: TZ, weekStart: 'sunday',
    });
    expect(dashboard).toEqual(section);
    expect(dashboard.map((b) => [b.succeeded, b.failed])).toEqual([[1, 0], [0, 1]]);
    // ...and UTC Monday weeks put both runs in ONE bucket: the difference is real.
    const utc = await reportingService.getSuccessRate(ORG, 'week', FROM, TO);
    expect(utc.map((b) => [b.succeeded, b.failed])).toEqual([[1, 1]]);
  });

  it('the DORA trend with tz + weekStart equals the dora_trend section', async () => {
    await seed('tz-d1', [{ type: 'STAGE', status: 'SUCCEEDED', stage: 'Deploy', environment: 'production', start: '2026-11-15T02:00:00Z', end: '2026-11-15T03:00:00Z' }]);
    await seed('tz-d2', [{ type: 'STAGE', status: 'SUCCEEDED', stage: 'Deploy', environment: 'production', start: '2026-11-15T17:00:00Z', end: '2026-11-15T18:00:00Z' }]);
    const dashboard = await reportingService.getDoraTrend(ORG, 'week', FROM, TO, undefined, { tz: TZ, weekStart: 'sunday' });
    const section = await getReportSection('dora_trend')!.run(source, {
      orgId: ORG, from: FROM, to: TO, tz: TZ, weekStart: 'sunday',
    });
    expect(dashboard).toEqual(section);
    expect(dashboard.map((p) => p.deployments)).toEqual([1, 1]);
  });
});

// ── 3. Manual MTTR ─────────────────────────────────────────────────────────

describe('manual MTTR is measured from the failure', () => {
  const FROM = '2026-11-01T00:00:00Z';
  const TO = '2026-11-30T23:59:59Z';

  const deploy = (exec: string, status: 'SUCCEEDED' | 'FAILED', end: string) => seed(exec, [
    { type: 'STAGE', status, stage: 'Deploy', environment: 'production', start: '2026-11-10T09:00:00Z', end },
  ]);

  it('restored − failed, not restored − deployed', async () => {
    await deploy('m-1', 'SUCCEEDED', '2026-11-10T10:00:00Z');
    await outcome('m-1', 'failed', '2026-11-10T11:00:00Z'); // broke an hour after the deploy
    await outcome('m-1', 'restored', '2026-11-10T13:00:00Z'); // fixed two hours later
    const dora = await reportingService.getDoraMetrics(ORG, FROM, TO);
    expect(dora.meanTimeToRestore).toMatchObject({ incidents: 1, restored: 1, medianSeconds: 7200, n: 1 });
  });

  it('a restored marker with no failure or incident is not a recovery', async () => {
    await deploy('m-2', 'SUCCEEDED', '2026-11-10T10:00:00Z');
    await outcome('m-2', 'restored', '2026-11-10T13:00:00Z');
    const dora = await reportingService.getDoraMetrics(ORG, FROM, TO);
    expect(dora.meanTimeToRestore).toMatchObject({ incidents: 0, restored: 0, medianSeconds: null, n: 0 });
  });

  it('falls back to the deploy completion only when the deploy itself failed (no failed marker)', async () => {
    await deploy('m-3', 'FAILED', '2026-11-10T10:00:00Z');
    await outcome('m-3', 'restored', '2026-11-10T10:30:00Z');
    const dora = await reportingService.getDoraMetrics(ORG, FROM, TO);
    expect(dora.meanTimeToRestore).toMatchObject({ incidents: 1, restored: 1, medianSeconds: 1800, n: 1 });
  });
});

// ── 5. DORA trend vs headline CFR ───────────────────────────────────────────

describe('the DORA trend adds up to the headline change failure rate', () => {
  const FROM = '2026-11-01T00:00:00Z';
  const TO = '2026-11-14T23:59:59Z';

  beforeEach(async () => {
    const d = (exec: string, status: 'SUCCEEDED' | 'FAILED', end: string) => seed(exec, [
      { type: 'STAGE', status, stage: 'Deploy', environment: 'production', start: end, end },
    ]);
    await d('t-1', 'SUCCEEDED', '2026-11-02T10:00:00Z');
    await d('t-2', 'SUCCEEDED', '2026-11-03T10:00:00Z');
    await d('t-3', 'FAILED', '2026-11-05T10:00:00Z');
    await d('t-4', 'SUCCEEDED', '2026-11-09T10:00:00Z');
    await d('t-5', 'SUCCEEDED', '2026-11-10T10:00:00Z');
    await d('t-6', 'SUCCEEDED', '2026-11-14T20:00:00Z'); // the window's last deploy
    // A deploy from BEFORE the window, marked failed inside it: not this window's change.
    await d('t-0', 'SUCCEEDED', '2026-10-20T10:00:00Z');
    await outcome('t-0', 'failed', '2026-11-02T00:00:00Z');
    // Post-deploy failures of in-window deploys: a manual marker and an incident.
    await outcome('t-2', 'failed', '2026-11-03T12:00:00Z');
    await incident('2026-11-10T12:00:00Z', '2026-11-10T13:00:00Z'); // follows t-5
    // The last deploy broke AFTER the window closed: anchored to its deploy, it
    // still belongs to this window.
    await outcome('t-6', 'failed', '2026-11-15T02:00:00Z');
  });

  it('summed trend buckets equal the headline CFR inputs', async () => {
    const dora = await reportingService.getDoraMetrics(ORG, FROM, TO);
    const prod = dora.environments.find((e) => e.environment === 'production')!;
    expect(prod.changeFailureRate).toMatchObject({ deployTimeFailures: 1, postDeployFailures: 3, attempts: 6 });

    const trend = await reportingService.getDoraTrend(ORG, 'week', FROM, TO);
    const sum = (k: 'failed' | 'postDeployFailures' | 'total' | 'deployments') => trend.reduce((a, p) => a + p[k], 0);
    expect(sum('failed')).toBe(prod.changeFailureRate.deployTimeFailures);
    expect(sum('postDeployFailures')).toBe(prod.changeFailureRate.postDeployFailures);
    expect(sum('total')).toBe(prod.changeFailureRate.attempts);
    expect(sum('deployments')).toBe(prod.deploymentFrequency.deployments);
    // Every bucket's rate is the two-class rate of that bucket.
    for (const p of trend) {
      const expected = p.total > 0 ? Math.round(((p.failed + p.postDeployFailures) / p.total) * 1000) / 10 : 0;
      expect(p.changeFailurePct).toBe(expected);
    }
  });
});
