// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Flow reports (approval wait, queue / provisioning time, pipeline start →
 * first stage) through the REAL queries on a REAL Postgres (the shipped init
 * script), with every row put there by the REAL ingest — so what is pinned is
 * that what the forwarder sends is stored where the report reads it:
 *
 *  - an approval action's `detail.type.category` survives ingest, and the wait is
 *    start → finish (duration when AWS declared a start, else from the STARTED row);
 *  - rejected and expired are one count (AWS reports both as FAILED); an
 *    undecided approval is counted with no wait;
 *  - `detail.buildPhases` survives ingest; a build missing a phase is not a zero;
 *  - compute sizes are reported in our vocabulary;
 *  - buckets honour tz / week start and are zero-filled;
 *  - org-scoped: another org's and a team's rows stay out of a single-org read,
 *    and a team's come in on a rollup.
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { drizzle } from 'drizzle-orm/pglite';
import { bootInitDb } from '../src/testing/pglite-init.js';

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

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

const { ingestEvents } = await import('../src/api/reporting/ingest.js');
const { getApprovalWaits, getQueueWaits, getQueueWaitTrend } = await import('../src/api/reporting/flow.js');
type IngestEvent = import('../src/api/reporting/types.js').IngestEvent;
type FlowScope = import('../src/api/reporting/flow.js').FlowScope;

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaf1';
const TEAM = 'aaaaaaaaaaaaaaaaaaaaaaf2';
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaf3';
const API = randomUUID();
const WEB = randomUUID();
const TEAM_PIPE = randomUUID();
const OTHER_PIPE = randomUUID();

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-09-15T00:00:00.000Z';
const SCOPE: FlowScope = { orgId: ORG, from: FROM, to: TO };

beforeAll(async () => {
  pg = await bootInitDb();
  db = drizzle(pg);
  for (const [id, org, name] of [[API, ORG, 'api'], [WEB, ORG, 'web'], [TEAM_PIPE, TEAM, 'team-svc'], [OTHER_PIPE, OTHER, 'other-svc']] as const) {
    await pg.query(
      `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, props, created_by, updated_by)
       VALUES ($1, $2, $3, 'acc', $3, '{}'::jsonb, 'u1', 'u1')`, [id, org, name]);
    await pg.query('INSERT INTO pipeline_registry (pipeline_id, org_id, pipeline_name) VALUES ($1, $2, $3)', [id, org, name]);
  }
}, 120_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.query('DELETE FROM pipeline_events');
  await pg.query('DELETE FROM dora_deployments');
});

const ms = (iso: string) => new Date(iso).getTime();

/** What the forwarder sends for an action, normalized the way parse.ts does it. */
function action(o: {
  pipelineId?: string;
  exec?: string;
  stage?: string;
  action?: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  category?: string;
  computeType?: string;
  buildPhases?: Record<string, number>;
}): IngestEvent {
  const detail: Record<string, unknown> = {
    stage: o.stage ?? 'Release',
    action: o.action ?? 'Approve',
    state: o.status,
    type: { owner: 'AWS', provider: o.category === 'Approval' ? 'Manual' : 'CodeBuild', category: o.category ?? 'Approval', version: '1' },
  };
  // The route folds these wire fields into detail (event-ingest.ts).
  if (o.computeType) detail.computeType = o.computeType;
  if (o.buildPhases) detail.buildPhases = o.buildPhases;
  return {
    pipelineId: o.pipelineId ?? API,
    eventSource: 'codepipeline',
    eventType: 'ACTION',
    status: o.status,
    executionId: o.exec ?? randomUUID(),
    stageName: o.stage ?? 'Release',
    actionName: o.action ?? 'Approve',
    ...(o.startedAt ? { startedAt: o.startedAt } : {}),
    ...(o.completedAt ? { completedAt: o.completedAt } : {}),
    ...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
    sourceEventId: randomUUID(),
    detail,
  };
}

/** An approval that waited `minutes`, finishing at `done`, with AWS's declared start. */
function approval(done: string, minutes: number, status = 'SUCCEEDED', over: Partial<Parameters<typeof action>[0]> = {}): IngestEvent {
  const start = new Date(ms(done) - minutes * 60_000).toISOString();
  return action({ status, startedAt: start, completedAt: done, durationMs: minutes * 60_000, ...over });
}

function build(done: string, queueS?: number, provS?: number, over: Partial<Parameters<typeof action>[0]> = {}): IngestEvent {
  const phases: Record<string, number> = {};
  if (queueS !== undefined) phases.queuedMs = queueS * 1000;
  if (provS !== undefined) phases.provisioningMs = provS * 1000;
  return action({
    status: 'SUCCEEDED',
    stage: 'Build',
    action: 'Compile',
    category: 'Build',
    startedAt: done,
    completedAt: done,
    computeType: 'BUILD_GENERAL1_MEDIUM',
    ...(queueS !== undefined || provS !== undefined ? { buildPhases: phases } : {}),
    ...over,
  });
}

describe('ingest keeps what the Flow report reads', () => {
  it('stores the approval category and the build phases in detail', async () => {
    const r = await ingestEvents([
      approval('2026-09-02T10:00:00Z', 30),
      build('2026-09-02T11:00:00Z', 42, 17),
    ]);
    expect(r.inserted).toBe(2);
    const rows = await pg.query<{ category: string; phases: unknown }>(
      'SELECT detail->\'type\'->>\'category\' AS category, detail->\'buildPhases\' AS phases FROM pipeline_events ORDER BY completed_at');
    expect(rows.rows).toEqual([
      { category: 'Approval', phases: null },
      { category: 'Build', phases: { queuedMs: 42_000, provisioningMs: 17_000 } },
    ]);
  });
});

describe('approval waits', () => {
  const waits = (scope: FlowScope = SCOPE, bucket: Record<string, unknown> = {}) =>
    getApprovalWaits(scope, { interval: 'week', tz: 'UTC', ...bucket });

  it('returns a zero-filled, empty report with no data', async () => {
    const r = await waits();
    expect(r.totals).toEqual({ approvals: 0, approved: 0, rejectedOrExpired: 0, undecided: 0, wait: { n: 0, medianSeconds: null, p90Seconds: null } });
    // Monday weeks over [Sep 1, Sep 15) 2026: Aug 31, Sep 7, Sep 14.
    expect(r.trend.map((t) => t.period)).toEqual(['2026-08-31 00:00:00', '2026-09-07 00:00:00', '2026-09-14 00:00:00']);
    expect(r.slowestStages).toEqual([]);
  });

  it('counts outcomes, and measures waits over decided approvals only', async () => {
    await ingestEvents([
      approval('2026-09-02T10:00:00Z', 10),
      approval('2026-09-02T11:00:00Z', 20),
      approval('2026-09-03T10:00:00Z', 30, 'FAILED'), // rejected — or expired: AWS says FAILED for both
      approval('2026-09-03T11:00:00Z', 999, 'SUPERSEDED'), // no decision, no wait
      // Not an approval: a build action in the same window.
      build('2026-09-02T12:00:00Z', 5, 5),
    ]);
    const r = await waits();
    expect(r.totals).toMatchObject({ approvals: 4, approved: 2, rejectedOrExpired: 1, undecided: 1 });
    expect(r.totals.wait).toEqual({ n: 3, medianSeconds: 20 * 60, p90Seconds: 28 * 60 });
  });

  it('measures from the STARTED row when AWS declared no start time', async () => {
    const exec = randomUUID();
    await ingestEvents([
      action({ exec, status: 'STARTED', startedAt: '2026-09-04T08:00:00Z' }),
      // started_at falls back to the event time on the forwarder; no duration.
      action({ exec, status: 'SUCCEEDED', startedAt: '2026-09-04T09:30:00Z', completedAt: '2026-09-04T09:30:00Z' }),
    ]);
    const r = await waits();
    expect(r.totals.approvals).toBe(1);
    expect(r.totals.wait).toEqual({ n: 1, medianSeconds: 90 * 60, p90Seconds: 90 * 60 });
  });

  it('buckets by finish time in the report timezone and week start', async () => {
    await ingestEvents([
      // Sunday 2026-09-06 23:30 in Chicago = Monday 04:30 UTC.
      approval('2026-09-07T04:30:00Z', 60),
      approval('2026-09-02T10:00:00Z', 10),
    ]);
    const utc = await waits();
    expect(utc.trend.map((t) => [t.period, t.approvals])).toEqual([['2026-08-31 00:00:00', 1], ['2026-09-07 00:00:00', 1], ['2026-09-14 00:00:00', 0]]);
    // In Chicago the 04:30 UTC finish is still Sunday, so a Monday week holds both…
    const chicago = await waits(SCOPE, { tz: 'America/Chicago' });
    expect(chicago.trend.filter((t) => t.approvals > 0))
      .toEqual([expect.objectContaining({ period: '2026-08-31 00:00:00', approvals: 2, medianSeconds: 35 * 60 })]);
    // …and a Sunday week starts on that Sunday.
    const chicagoSunday = await waits(SCOPE, { tz: 'America/Chicago', weekStart: 'sunday' });
    expect(chicagoSunday.trend.filter((t) => t.approvals > 0).map((t) => t.period)).toEqual(['2026-08-30 00:00:00', '2026-09-06 00:00:00']);
    expect(chicagoSunday.trend.reduce((a, t) => a + t.approvals, 0)).toBe(2);
  });

  it('ranks the slowest approval stages per (pipeline, stage)', async () => {
    await ingestEvents([
      approval('2026-09-02T10:00:00Z', 10, 'SUCCEEDED', { stage: 'Release' }),
      approval('2026-09-02T11:00:00Z', 300, 'FAILED', { pipelineId: WEB, stage: 'Release' }),
      approval('2026-09-02T12:00:00Z', 60, 'SUCCEEDED', { stage: 'Prod' }),
    ]);
    const r = await waits();
    expect(r.slowestStages.map((s) => [s.pipelineName, s.stageName, s.p90Seconds, s.rejectedOrExpired])).toEqual([
      ['web', 'Release', 300 * 60, 1],
      ['api', 'Prod', 60 * 60, 0],
      ['api', 'Release', 10 * 60, 0],
    ]);
    expect(r.slowestStages[0]).toMatchObject({ pipelineId: WEB, approvals: 1, maxSeconds: 300 * 60 });
  });

  it('is org-scoped and rollup-aware', async () => {
    await ingestEvents([
      approval('2026-09-02T10:00:00Z', 10),
      approval('2026-09-02T10:00:00Z', 20, 'SUCCEEDED', { pipelineId: TEAM_PIPE }),
      approval('2026-09-02T10:00:00Z', 30, 'SUCCEEDED', { pipelineId: OTHER_PIPE }),
    ]);
    expect((await waits()).totals.approvals).toBe(1);
    expect((await waits({ ...SCOPE, orgIds: [ORG, TEAM] })).totals.approvals).toBe(2);
    // A set that omits the caller's own org collapses to the single-org scope.
    expect((await waits({ ...SCOPE, orgIds: [OTHER, TEAM] })).totals.approvals).toBe(1);
  });

  it('leaves out approvals that finished outside the window', async () => {
    await ingestEvents([approval('2026-08-31T23:59:00Z', 10), approval('2026-09-15T00:00:00Z', 10)]);
    expect((await waits()).totals.approvals).toBe(0);
  });
});

describe('queue and provisioning time', () => {
  it('returns empty current figures with no data (and pre-release rows are not in the sample)', async () => {
    await ingestEvents([build('2026-09-02T10:00:00Z')]); // no buildPhases: ingested before collection began
    const r = await getQueueWaits(SCOPE);
    expect(r).toMatchObject({
      builds: 0,
      queue: { n: 0, medianSeconds: null, p90Seconds: null },
      provisioning: { n: 0, medianSeconds: null, p90Seconds: null },
      byComputeType: [],
      slowestActions: [],
      startToFirstStage: { n: 0, medianSeconds: null, p90Seconds: null },
    });
  });

  it('reports median / p90 queue and provisioning time, overall and by compute size', async () => {
    await ingestEvents([
      build('2026-09-02T10:00:00Z', 10, 20),
      build('2026-09-02T11:00:00Z', 20, 40),
      build('2026-09-02T12:00:00Z', 30), // provisioning not reported — not a zero
      build('2026-09-02T13:00:00Z', 100, 60, { computeType: 'BUILD_GENERAL1_2XLARGE', action: 'Synth' }),
      build('2026-09-02T14:00:00Z', 5, 5, { computeType: undefined, action: 'Lint' }),
    ]);
    const r = await getQueueWaits(SCOPE);
    expect(r.builds).toBe(5);
    expect(r.queue).toEqual({ n: 5, medianSeconds: 20, p90Seconds: 72 });
    expect(r.provisioning).toEqual({ n: 4, medianSeconds: 30, p90Seconds: 54 });
    expect(r.byComputeType).toEqual([
      { computeType: 'MEDIUM', builds: 3, queueMedianSeconds: 20, queueP90Seconds: 28, provisioningMedianSeconds: 30, provisioningP90Seconds: 38 },
      { computeType: 'X2_LARGE', builds: 1, queueMedianSeconds: 100, queueP90Seconds: 100, provisioningMedianSeconds: 60, provisioningP90Seconds: 60 },
      { computeType: 'unknown', builds: 1, queueMedianSeconds: 5, queueP90Seconds: 5, provisioningMedianSeconds: 5, provisioningP90Seconds: 5 },
    ]);
    expect(r.slowestActions.map((a) => [a.actionName, a.totalWaitP90Seconds])).toEqual([
      // Compile's per-build totals are 30, 60 and 30 (a missing phase adds nothing).
      ['Synth', 160], ['Compile', 54], ['Lint', 10],
    ]);
  });

  it('measures pipeline start → first stage start from the STARTED rows', async () => {
    const pipe = (exec: string, status: string, at: string): IngestEvent => ({
      pipelineId: API,
      eventSource: 'codepipeline',
      eventType: 'PIPELINE',
      status,
      executionId: exec,
      startedAt: at,
      sourceEventId: randomUUID(),
      detail: {},
    });
    const stage = (exec: string, name: string, status: string, at: string): IngestEvent => ({
      pipelineId: API,
      eventSource: 'codepipeline',
      eventType: 'STAGE',
      status,
      executionId: exec,
      stageName: name,
      startedAt: at,
      sourceEventId: randomUUID(),
      detail: {},
    });
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    await ingestEvents([
      pipe(a, 'STARTED', '2026-09-02T10:00:00Z'), stage(a, 'Source', 'STARTED', '2026-09-02T10:00:30Z'),
      stage(a, 'Build', 'STARTED', '2026-09-02T10:05:00Z'),
      // A RESUMED stage row is a retry, not the first start.
      pipe(b, 'STARTED', '2026-09-09T10:00:00Z'), stage(b, 'Source', 'RESUMED', '2026-09-09T09:59:00Z'),
      stage(b, 'Source', 'STARTED', '2026-09-09T10:01:30Z'),
      // No stage row: left out.
      pipe(c, 'STARTED', '2026-09-10T10:00:00Z'),
    ]);
    const r = await getQueueWaits(SCOPE);
    expect(r.startToFirstStage).toEqual({ n: 2, medianSeconds: 60, p90Seconds: 84 });
    const trend = await getQueueWaitTrend(SCOPE, { interval: 'week', tz: 'UTC' });
    expect(trend.map((t) => [t.period, t.executions, t.startToFirstStageMedianSeconds])).toEqual([
      ['2026-08-31 00:00:00', 1, 30], ['2026-09-07 00:00:00', 1, 90], ['2026-09-14 00:00:00', 0, null],
    ]);
  });

  it('trends queue and provisioning time per bucket, zero-filled', async () => {
    await ingestEvents([
      build('2026-09-02T10:00:00Z', 10, 20),
      build('2026-09-03T10:00:00Z', 30, 40),
    ]);
    const trend = await getQueueWaitTrend(SCOPE, { interval: 'week', tz: 'UTC' });
    expect(trend).toEqual([
      {
        period: '2026-08-31 00:00:00',
        builds: 2,
        queueMedianSeconds: 20,
        queueP90Seconds: 28,
        provisioningMedianSeconds: 30,
        provisioningP90Seconds: 38,
        executions: 0,
        startToFirstStageMedianSeconds: null,
        startToFirstStageP90Seconds: null,
      },
      {
        period: '2026-09-07 00:00:00',
        builds: 0,
        queueMedianSeconds: null,
        queueP90Seconds: null,
        provisioningMedianSeconds: null,
        provisioningP90Seconds: null,
        executions: 0,
        startToFirstStageMedianSeconds: null,
        startToFirstStageP90Seconds: null,
      },
      expect.objectContaining({ period: '2026-09-14 00:00:00', builds: 0, queueMedianSeconds: null }),
    ]);
    // The free figures and the trend count the same builds.
    expect((await getQueueWaits(SCOPE)).builds).toBe(trend.reduce((a, t) => a + t.builds, 0));
  });

  it('is org-scoped and rollup-aware', async () => {
    await ingestEvents([
      build('2026-09-02T10:00:00Z', 10, 10),
      build('2026-09-02T10:00:00Z', 10, 10, { pipelineId: TEAM_PIPE }),
      build('2026-09-02T10:00:00Z', 10, 10, { pipelineId: OTHER_PIPE }),
    ]);
    expect((await getQueueWaits(SCOPE)).builds).toBe(1);
    expect((await getQueueWaits({ ...SCOPE, orgIds: [ORG, TEAM] })).builds).toBe(2);
  });
});
