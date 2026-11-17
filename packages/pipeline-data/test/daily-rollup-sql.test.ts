// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The daily rollup, run against a REAL Postgres.
 *
 * This suite exists because the rollup is one large SQL statement, and the shape
 * that reads most naturally does not run: `PERCENTILE_CONT` is an ordered-set
 * aggregate and cannot be used as a window function, so the first version of this
 * query typechecked, passed every mock-based test, and would have failed the first
 * time the scheduler ticked. A rollup is exactly the kind of code that must be
 * executed to be believed.
 *
 * It also pins the three properties the job's correctness rests on: two grains
 * from one scan, idempotency per day, and a rebuild that REPLACES a day rather
 * than adding to it.
 *
 * It calls the REAL `rebuildDay` — through the real `withTenantTx`, as the
 * application role, under the init script's RLS — via the package's testing
 * entry. (It used to execute a hand-copied string of the statement, which proved
 * that a string in a test file ran, not that the module's SQL did.)
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { rebuildDay } from '../src/api/reporting/daily-rollup.js';
import { asTenantContext, bootTenantDb, type TenantTestDb } from '../src/testing/index.js';

let tdb: TenantTestDb;
/** Raw SQL as the bootstrap superuser — fixtures and inspection across every org. */
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'org-rollup';
const OTHER_ORG = 'org-other';
const DAY = '2026-09-14';
const PIPE_A = randomUUID();
const PIPE_B = randomUUID();
const OTHER_PIPE = randomUUID();

/** The module's rebuild for one UTC day (the day it is given is truncated to its UTC start). */
const rebuild = (day = DAY) => rebuildDay(new Date(`${day}T15:30:00Z`));

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

interface EventSeed {
  pipelineId?: string;
  orgId?: string;
  eventType?: 'PIPELINE' | 'STAGE' | 'ACTION';
  stageName?: string | null;
  status?: string;
  durationMs?: number | null;
  failureCategory?: string | null;
  at?: string;
}

async function seedEvent(seed: EventSeed = {}): Promise<void> {
  await owner((db) => db.query(
    `INSERT INTO pipeline_events
       (pipeline_id, org_id, event_source, event_type, status, execution_id,
        stage_name, duration_ms, failure_category, created_at)
     VALUES ($1, $2, 'codepipeline', $3, $4, $5, $6, $7, $8, $9)`,
    [
      seed.pipelineId ?? PIPE_A,
      seed.orgId ?? ORG,
      seed.eventType ?? 'STAGE',
      seed.status ?? 'SUCCEEDED',
      randomUUID(),
      seed.stageName === undefined ? 'Build' : seed.stageName,
      seed.durationMs === undefined ? 1000 : seed.durationMs,
      seed.failureCategory ?? null,
      seed.at ?? `${DAY}T12:00:00Z`,
    ],
  ));
}

const rollups = async () => (await owner((db) => db.query<Record<string, unknown>>(
  `SELECT org_id, pipeline_id, stage_name, runs, succeeded, failed,
          failures_by_category, p50_ms, p90_ms, p95_ms, build_seconds
     FROM execution_daily_rollups ORDER BY org_id, pipeline_id, stage_name`,
))).rows;

beforeAll(async () => {
  tdb = await bootTenantDb();
  // The pipelines the events reference (pipeline_id has an FK). Distinct projects
  // because one pipeline per (project, organization) is a uniqueness rule.
  for (const [id, org, project] of [
    [PIPE_A, ORG, 'web'],
    [PIPE_B, ORG, 'api'],
    [OTHER_PIPE, OTHER_ORG, 'web'],
  ] as const) {
    await owner((db) => db.query(
      `INSERT INTO pipelines (id, org_id, project, organization, props, created_by, updated_by)
       VALUES ($1, $2, $3, 'acme', '{}'::jsonb, 'u1', 'u1')`,
      [id, org, project],
    ));
  }
}, 120_000);

afterAll(async () => { await tdb?.close(); });

beforeEach(async () => {
  await owner((db) => db.exec('DELETE FROM execution_daily_rollups; DELETE FROM pipeline_events;'));
});

describe('the daily rollup statement', () => {
  it('runs at all — the shape that reads naturally does not — and reports the rows it wrote', async () => {
    await seedEvent();
    await expect(rebuild()).resolves.toBe(1);
    expect(await rollups()).toHaveLength(1);
  });

  /**
   * A SYSTEM job over every org's events. Under FORCE RLS a rebuild that ran in
   * whatever scope its caller happened to hold would roll up only that org — or,
   * with no scope at all, nothing — so `rebuildDay` elevates itself.
   */
  it('rolls up EVERY org, whatever tenant scope it is called from', async () => {
    await seedEvent({ pipelineId: PIPE_A });
    await seedEvent({ pipelineId: OTHER_PIPE, orgId: OTHER_ORG });
    await expect(asTenantContext({ orgId: ORG }, () => rebuild())).resolves.toBe(2);
    expect(new Set((await rollups()).map((r) => r.org_id))).toEqual(new Set([ORG, OTHER_ORG]));
  });

  it('rolls up every org with no tenant scope at all (a scheduler tick)', async () => {
    await seedEvent({ pipelineId: PIPE_A });
    await seedEvent({ pipelineId: OTHER_PIPE, orgId: OTHER_ORG });
    await rebuild();
    expect(await rollups()).toHaveLength(2);
  });

  /**
   * A PIPELINE event carries no stage name, so it collapses to the `''`
   * pipeline-level row; a STAGE event lands on its own. That is the whole reason
   * the query needs no GROUPING SETS.
   */
  it('produces the pipeline-level and stage-level rows from one scan', async () => {
    await seedEvent({ eventType: 'PIPELINE', stageName: null, durationMs: 5000 });
    await seedEvent({ eventType: 'STAGE', stageName: 'Build', durationMs: 2000 });
    await seedEvent({ eventType: 'STAGE', stageName: 'Deploy', durationMs: 3000 });
    await rebuild();
    const rows = await rollups();
    expect(rows.map((r) => r.stage_name)).toEqual(['', 'Build', 'Deploy']);
    expect(rows.find((r) => r.stage_name === '')?.build_seconds).toBe(5);
  });

  it('counts successes and failures, and ignores ACTION events', async () => {
    await seedEvent({ status: 'SUCCEEDED' });
    await seedEvent({ status: 'SUCCEEDED' });
    await seedEvent({ status: 'FAILED', failureCategory: 'dependency' });
    // ACTION events are per-step detail, not runs; counting them would multiply
    // every pipeline's run count by its step count.
    await seedEvent({ eventType: 'ACTION', status: 'FAILED' });
    await rebuild();
    const [row] = await rollups();
    expect(row).toMatchObject({ runs: 3, succeeded: 2, failed: 1 });
  });

  it('rolls failure categories into a count map', async () => {
    await seedEvent({ status: 'FAILED', failureCategory: 'dependency' });
    await seedEvent({ status: 'FAILED', failureCategory: 'dependency' });
    await seedEvent({ status: 'FAILED', failureCategory: 'timeout' });
    await seedEvent({ status: 'SUCCEEDED' });
    await rebuild();
    const [row] = await rollups();
    expect(row.failures_by_category).toEqual({ dependency: 2, timeout: 1 });
  });

  it('leaves the category map empty rather than null when nothing failed', async () => {
    await seedEvent({ status: 'SUCCEEDED' });
    await rebuild();
    expect((await rollups())[0]?.failures_by_category).toEqual({});
  });

  it('computes percentiles, and ignores events with no duration', async () => {
    for (const ms of [100, 200, 300, 400, 1000]) await seedEvent({ durationMs: ms });
    // No duration contributes no timing. Treating it as zero would drag every
    // percentile down and make a pipeline look faster than it is.
    await seedEvent({ durationMs: null });
    await rebuild();
    const [row] = await rollups();
    expect(row.runs).toBe(6);
    expect(row.p50_ms).toBe(300);
    expect(Number(row.p95_ms)).toBeGreaterThanOrEqual(400);
    expect(row.build_seconds).toBe(2); // 2000ms / 1000
  });

  /**
   * THE IDEMPOTENCY PROPERTY. A day is recomputed WHOLESALE and upserted, never
   * incremented — incrementing is how a redelivered event, a retried tick or a
   * crashed half-run silently inflates a count, and an inflated success rate is
   * worse than a missing one because nobody can tell.
   */
  it('is idempotent: rebuilding the same day twice does not double the counts', async () => {
    await seedEvent();
    await seedEvent();
    await rebuild();
    await rebuild();
    await rebuild();
    const [row] = await rollups();
    expect(row).toMatchObject({ runs: 2, succeeded: 2 });
    expect(await rollups()).toHaveLength(1);
  });

  /** Late events legitimately change yesterday: the rebuild must REPLACE. */
  it('replaces a day when late events arrive', async () => {
    await seedEvent();
    await rebuild();
    expect((await rollups())[0]?.runs).toBe(1);

    await seedEvent({ status: 'FAILED', failureCategory: 'timeout' });
    await rebuild();
    const [row] = await rollups();
    expect(row).toMatchObject({ runs: 2, succeeded: 1, failed: 1 });
    expect(row.failures_by_category).toEqual({ timeout: 1 });
  });

  it('keeps orgs and pipelines apart', async () => {
    await seedEvent({ pipelineId: PIPE_A });
    await seedEvent({ pipelineId: PIPE_B });
    await seedEvent({ pipelineId: OTHER_PIPE, orgId: OTHER_ORG });
    await rebuild();
    const rows = await rollups();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.org_id))).toEqual(new Set([ORG, OTHER_ORG]));
  });

  it('only reads the day it was asked for', async () => {
    await seedEvent({ at: `${DAY}T23:59:59Z` });
    await seedEvent({ at: `${nextDay(DAY)}T00:00:01Z` });
    await rebuild();
    expect((await rollups())[0]?.runs).toBe(1);
  });

  it('writes no row for a day with no activity', async () => {
    await expect(rebuild()).resolves.toBe(0);
    expect(await rollups()).toEqual([]);
  });
});
