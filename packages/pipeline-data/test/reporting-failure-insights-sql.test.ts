// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The failure-insight reports, through the REAL queries on a REAL Postgres:
 *
 *  1. Stage and action failures are grouped per PIPELINE, so two pipelines that
 *     both call a stage "Build" no longer merge into one row — and the
 *     stakeholder `stage_failures` / `action_failures` sections read the same rows.
 *  2. Org error patterns: failures grouped by their ingest-time failure category,
 *     org-scoped and rollup-aware, never another org's rows.
 *  3. Flaky stages: a stage that failed and then passed on retry in the SAME
 *     execution, per (pipeline, stage), with its flake rate and a bucketed trend.
 *  4. Unknown lead time explained: the stored `lead_time_gap` reasons are counted
 *     per environment on the DORA response.
 *  5. The stakeholder DORA sections use the org's incident window, exactly as the
 *     dashboard route does, and the snapshot records the window it used.
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

const { reportingService } = await import('../src/api/reporting-service.js');
const { getReportSection } = await import('../src/api/reporting/stakeholder/sections.js');
const { composeSnapshot } = await import('../src/api/reporting/stakeholder/compose.js');
type Source = Parameters<NonNullable<ReturnType<typeof getReportSection>>['run']>[0];
const source = reportingService as unknown as Source;

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa3';
const TEAM = 'aaaaaaaaaaaaaaaaaaaaaaa4';
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaa5';
const API = randomUUID();
const WEB = randomUUID();
const TEAM_PIPE = randomUUID();
const OTHER_PIPE = randomUUID();

const DAY = '2026-11-17';
const FROM = `${DAY}T00:00:00Z`;
const TO = `${DAY}T23:59:59Z`;
const t = (hms: string, day = DAY) => `${day}T${hms}Z`;

beforeAll(async () => {
  pg = await bootInitDb();
  db = drizzle(pg);
  for (const [id, org, name] of [[API, ORG, 'api'], [WEB, ORG, 'web'], [TEAM_PIPE, TEAM, 'team-svc'], [OTHER_PIPE, OTHER, 'other-svc']]) {
    await pg.query(
      `INSERT INTO pipelines (id, org_id, project, organization, pipeline_name, props, created_by, updated_by)
       VALUES ($1, $2, $3, 'acc', $3, '{}'::jsonb, 'u1', 'u1')`,
      [id, org, name],
    );
  }
}, 120_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.query('DELETE FROM pipeline_events');
  await pg.query('DELETE FROM dora_deployments');
  await pg.query('DELETE FROM deployment_outcomes');
  await pg.query('DELETE FROM incidents');
  await pg.query('DELETE FROM dora_settings');
});

interface Ev {
  pipeline?: string;
  org?: string;
  type: 'PIPELINE' | 'STAGE' | 'ACTION';
  status: string;
  stage?: string;
  action?: string;
  start: string;
  end?: string;
  environment?: string;
  error?: string;
  category?: string;
}

async function seed(executionId: string, events: Ev[]): Promise<void> {
  for (const ev of events) {
    await pg.query(
      `INSERT INTO pipeline_events
         (pipeline_id, org_id, event_source, event_type, status, execution_id, stage_name, action_name,
          started_at, completed_at, environment, error_message, failure_category, source_event_id, created_at)
       VALUES ($1, $2, 'codepipeline', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        ev.pipeline ?? API, ev.org ?? ORG, ev.type, ev.status, executionId, ev.stage ?? null, ev.action ?? null,
        ev.start, ev.end ?? null, ev.environment ?? null, ev.error ?? null, ev.category ?? null,
        randomUUID(), ev.end ?? ev.start,
      ],
    );
  }
}

/** One stage outcome (STAGE + its single ACTION), the shape a run's terminal rows take. */
const stageRun = (pipeline: string, stage: string, status: 'SUCCEEDED' | 'FAILED', start: string, end: string): Ev[] => [
  { pipeline, type: 'ACTION', status, stage, action: 'step', start, end },
  { pipeline, type: 'STAGE', status, stage, start, end },
];

// ── 1. Stage / action failures per pipeline ────────────────────────────────

describe('stage and action failures are grouped per pipeline', () => {
  beforeEach(async () => {
    // api/Build fails 1 of 2; web/Build never fails. Same stage NAME, two pipelines.
    await seed('api-1', stageRun(API, 'Build', 'SUCCEEDED', t('08:00:00'), t('08:05:00')));
    await seed('api-2', stageRun(API, 'Build', 'FAILED', t('09:00:00'), t('09:05:00')));
    await seed('web-1', stageRun(WEB, 'Build', 'SUCCEEDED', t('10:00:00'), t('10:05:00')));
  });

  it('two pipelines with a "Build" stage produce two rows, each with its own rate', async () => {
    const rows = await reportingService.getStageFailures(ORG, FROM, TO);
    const byPipeline = Object.fromEntries(rows.map((r) => [r.pipeline_id, r]));
    expect(rows).toHaveLength(2);
    expect(byPipeline[API]).toMatchObject({ pipeline_name: 'api', stage_name: 'Build', failures: 1, total: 2, failure_pct: 50 });
    expect(byPipeline[WEB]).toMatchObject({ pipeline_name: 'web', stage_name: 'Build', failures: 0, total: 1, failure_pct: 0 });
    // Worst first.
    expect(rows[0]!.pipeline_id).toBe(API);
  });

  it('action failures are grouped per (pipeline, stage, action)', async () => {
    const rows = await reportingService.getActionFailures(ORG, FROM, TO);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.pipeline_id === API)).toMatchObject({ stage_name: 'Build', action_name: 'step', failures: 1, total: 2 });
    expect(rows.find((r) => r.pipeline_id === WEB)).toMatchObject({ failures: 0, total: 1 });
  });

  it('the stakeholder sections read exactly the dashboard rows', async () => {
    const ctx = { orgId: ORG, from: FROM, to: TO, tz: 'UTC', weekStart: 'monday' as const };
    expect(await getReportSection('stage_failures')!.run(source, ctx)).toEqual(await reportingService.getStageFailures(ORG, FROM, TO));
    expect(await getReportSection('action_failures')!.run(source, ctx)).toEqual(await reportingService.getActionFailures(ORG, FROM, TO));
  });
});

// ── 2. Org error patterns by failure category ──────────────────────────────

describe('org error patterns, grouped by failure category', () => {
  beforeEach(async () => {
    await seed('e-1', [
      { type: 'ACTION', status: 'FAILED', stage: 'Test', action: 'unit', start: t('08:00:00'), end: t('08:01:00'), error: 'expected 1 to equal 2', category: 'unit_test' },
    ]);
    await seed('e-2', [
      { pipeline: WEB, type: 'ACTION', status: 'FAILED', stage: 'Test', action: 'unit', start: t('09:00:00'), end: t('09:01:00'), error: 'expected 1 to equal 2', category: 'unit_test' },
    ]);
    await seed('e-3', [
      { type: 'ACTION', status: 'FAILED', stage: 'Build', action: 'npm', start: t('10:00:00'), end: t('10:01:00'), error: 'npm ERR! 404 left-pad', category: 'dependency' },
    ]);
    // A team's failure (rollup only) and another org's (never).
    await seed('e-4', [
      { pipeline: TEAM_PIPE, org: TEAM, type: 'ACTION', status: 'FAILED', stage: 'Build', action: 'npm', start: t('11:00:00'), end: t('11:01:00'), error: 'npm ERR! 404 left-pad', category: 'dependency' },
    ]);
    await seed('e-5', [
      { pipeline: OTHER_PIPE, org: OTHER, type: 'ACTION', status: 'FAILED', stage: 'Build', action: 'npm', start: t('12:00:00'), end: t('12:01:00'), error: 'secret other-org text', category: 'unit_test' },
    ]);
  });

  it('groups the org\'s failures by category, with the top patterns inside each', async () => {
    const rows = await reportingService.getErrorCategories(ORG, FROM, TO);
    expect(rows.map((r) => r.category)).toEqual(['unit_test', 'dependency']);
    expect(rows[0]).toMatchObject({ occurrences: 2, affected_pipelines: 2, last_seen: expect.stringContaining('2026-11-17') });
    expect(rows[0]!.patterns).toEqual([{ error_pattern: 'expected 1 to equal 2', occurrences: 2 }]);
    expect(rows[1]).toMatchObject({ occurrences: 1, affected_pipelines: 1 });
    // Another org's text never appears.
    expect(JSON.stringify(rows)).not.toContain('other-org');
  });

  it('a rollup adds the team\'s rows, and only those', async () => {
    const rows = await reportingService.getErrorCategories(ORG, FROM, TO, 20, [ORG, TEAM]);
    expect(rows.find((r) => r.category === 'dependency')).toMatchObject({ occurrences: 2, affected_pipelines: 2 });
    expect(JSON.stringify(rows)).not.toContain('other-org');
  });

  it('counts the same failures the error-pattern report does (one category per failure)', async () => {
    const patterns = await reportingService.getErrors(ORG, FROM, TO);
    const categories = await reportingService.getErrorCategories(ORG, FROM, TO);
    const total = (xs: Array<{ occurrences: number }>) => xs.reduce((s, x) => s + x.occurrences, 0);
    expect(total(categories)).toBe(total(patterns));
  });
});

// ── 3. Flaky stages ────────────────────────────────────────────────────────

describe('flaky stages: failed, then passed on retry, in the same execution', () => {
  beforeEach(async () => {
    // f-1: Build FAILED, RESUMED, then SUCCEEDED — a flake.
    await seed('f-1', [
      ...stageRun(API, 'Build', 'FAILED', t('08:00:00'), t('08:05:00')),
      { type: 'STAGE', status: 'RESUMED', stage: 'Build', start: t('08:10:00') },
      ...stageRun(API, 'Build', 'SUCCEEDED', t('08:10:00'), t('08:15:00')),
    ]);
    // f-2: clean pass. f-3: a real failure (nothing overtook it) — not a flake.
    await seed('f-2', stageRun(API, 'Build', 'SUCCEEDED', t('09:00:00'), t('09:05:00')));
    await seed('f-3', stageRun(API, 'Build', 'FAILED', t('10:00:00'), t('10:05:00')));
    // f-4: next day, another flake — the RESUMED row is missing (an older ingest
    // refused it), so the overtaken FAILED alone has to identify the retry.
    await seed('f-4', [
      ...stageRun(API, 'Build', 'FAILED', t('08:00:00', '2026-11-18'), t('08:05:00', '2026-11-18')),
      ...stageRun(API, 'Build', 'SUCCEEDED', t('08:10:00', '2026-11-18'), t('08:15:00', '2026-11-18')),
    ]);
    // web/Build is stable — it must not appear.
    await seed('w-1', stageRun(WEB, 'Build', 'SUCCEEDED', t('09:00:00'), t('09:05:00')));
  });

  it('ranks (pipeline, stage) by flaky executions with the flake rate', async () => {
    const rows = await reportingService.getFlakyStages(ORG, FROM, '2026-11-18T23:59:59Z');
    expect(rows).toEqual([
      expect.objectContaining({
        pipeline_id: API,
        pipeline_name: 'api',
        stage_name: 'Build',
        flaky_runs: 2,
        runs: 4,
        flake_pct: 50,
        flaky_actions: ['step'],
      }),
    ]);
  });

  it('the trend buckets flakes by day in the report timezone, summing to the list', async () => {
    const trend = await reportingService.getFlakyStageTrend(ORG, 'day', FROM, '2026-11-18T23:59:59Z', undefined, { tz: 'UTC', weekStart: 'monday' });
    expect(trend).toEqual([
      // Every stage of the scope counts in the denominator: api/Build x3 + web/Build.
      { period: expect.stringContaining('2026-11-17'), flaky_runs: 1, runs: 4, flake_pct: 25 },
      { period: expect.stringContaining('2026-11-18'), flaky_runs: 1, runs: 1, flake_pct: 100 },
    ]);
  });

  it('is org-scoped: another org\'s flake is invisible', async () => {
    await seed('o-1', [
      ...stageRun(OTHER_PIPE, 'Build', 'FAILED', t('08:00:00'), t('08:05:00')).map((e) => ({ ...e, org: OTHER })),
      ...stageRun(OTHER_PIPE, 'Build', 'SUCCEEDED', t('08:10:00'), t('08:15:00')).map((e) => ({ ...e, org: OTHER })),
    ]);
    const rows = await reportingService.getFlakyStages(ORG, FROM, TO);
    expect(rows.map((r) => r.pipeline_id)).toEqual([API]);
  });
});

// ── 4. Unknown lead time, explained ────────────────────────────────────────

describe('unknown lead time carries the stored reasons', () => {
  it('counts each lead_time_gap reason per environment', async () => {
    for (const [i, gap] of (['no_token', 'no_token', 'rate_limited'] as const).entries()) {
      const exec = `d-${i}`;
      await seed(exec, [{ type: 'STAGE', status: 'SUCCEEDED', stage: 'Deploy', start: t(`0${i + 1}:00:00`), end: t(`0${i + 1}:05:00`), environment: 'production' }]);
      await pg.query(
        `INSERT INTO dora_deployments (org_id, execution_id, environment, pipeline_id, deployed_at, succeeded, lead_time_gap)
         VALUES ($1, $2, 'production', $3, $4, true, $5)`,
        [ORG, exec, API, t(`0${i + 1}:05:00`), gap],
      );
    }
    // Another org's gaps never count.
    await pg.query(
      `INSERT INTO dora_deployments (org_id, execution_id, environment, pipeline_id, deployed_at, succeeded, lead_time_gap)
       VALUES ($1, 'x-1', 'production', $2, $3, true, 'unsupported_source')`,
      [OTHER, OTHER_PIPE, t('04:05:00')],
    );

    const dora = await reportingService.getDoraMetrics(ORG, FROM, TO);
    const prod = dora.environments.find((e) => e.environment === 'production')!;
    expect(prod.leadTime.medianSeconds).toBeNull();
    expect(prod.leadTime.unknownReasons).toEqual({ no_token: 2, rate_limited: 1 });
  });
});

// ── 5. Stakeholder DORA uses the org's incident window ─────────────────────

describe('stakeholder DORA sections use the org incident window', () => {
  const period = {
    start: new Date(FROM),
    end: new Date(TO),
    prevStart: new Date('2026-11-16T00:00:00Z'),
    prevEnd: new Date(FROM),
    label: DAY,
  };
  const compose = () => composeSnapshot(['dora', 'dora_trend'], {
    source, period, timezone: 'UTC', weekStart: 'monday', orgId: ORG, features: ['advanced_reporting'],
  });

  beforeEach(async () => {
    // A production deploy at 08:05 and an incident opened 3h later: inside the
    // default 24h window, outside a 1h one.
    await seed('dep-1', [{ type: 'STAGE', status: 'SUCCEEDED', stage: 'Deploy', start: t('08:00:00'), end: t('08:05:00'), environment: 'production' }]);
    await pg.query(
      `INSERT INTO incidents (incident_id, org_id, environment, opened_at, resolved_at, severity)
       VALUES ($1, $2, 'production', $3, $4, 'sev2')`,
      [randomUUID(), ORG, t('11:05:00'), t('11:35:00')],
    );
    await pg.query('INSERT INTO dora_settings (org_id, incident_window_hours) VALUES ($1, 1)', [ORG]);
  });

  it('report CFR / MTTR equal the dashboard\'s for an org with a custom window', async () => {
    // What the /dora and /dora/trend routes do: read the org's window, pass it in.
    const { incidentWindowHours } = await reportingService.getReportingSettings(ORG);
    const dashboard = await reportingService.getDoraMetrics(ORG, FROM, TO, undefined, { incidentWindowHours: incidentWindowHours ?? undefined });
    const dashboardTrend = await reportingService.getDoraTrend(ORG, 'week', FROM, TO, undefined, { incidentWindowHours: incidentWindowHours ?? undefined, tz: 'UTC', weekStart: 'monday' });
    // The custom window really changes the answer (otherwise the test proves nothing).
    const defaultWindow = await reportingService.getDoraMetrics(ORG, FROM, TO);
    expect(defaultWindow.environments[0]!.changeFailureRate.postDeployFailures).toBe(1);
    expect(dashboard.environments[0]!.changeFailureRate.postDeployFailures).toBe(0);

    const snap = await compose();
    const section = (id: string) => snap.sections.find((s) => s.id === id)!;
    expect(section('dora').state).toBe('ok');
    const report = section('dora').current as typeof dashboard;
    expect(report.environments[0]!.changeFailureRate).toEqual(dashboard.environments[0]!.changeFailureRate);
    expect(report.meanTimeToRestore).toEqual(dashboard.meanTimeToRestore);
    expect(section('dora_trend').current).toEqual(dashboardTrend);
  });

  it('the snapshot records the window it used and keeps it after the setting changes', async () => {
    const stored = JSON.parse(JSON.stringify(await compose()));
    expect(stored.incidentWindowHours).toBe(1);
    expect(stored.methodology).toContain('1 hour');

    await pg.query('UPDATE dora_settings SET incident_window_hours = 24 WHERE org_id = $1', [ORG]);
    const recomposed = await compose();
    expect(recomposed.incidentWindowHours).toBe(24);
    // The new window changes a freshly composed report...
    const cfr = (s: { sections: Array<{ id: string; current?: unknown }> }) =>
      (s.sections.find((x) => x.id === 'dora')!.current as { environments: Array<{ changeFailureRate: { postDeployFailures: number } }> })
        .environments[0]!.changeFailureRate.postDeployFailures;
    expect(cfr(recomposed)).toBe(1);
    // ...and not the frozen one, which still states the window its numbers came from.
    expect(stored.incidentWindowHours).toBe(1);
    expect(cfr(stored)).toBe(0);
  });
});
