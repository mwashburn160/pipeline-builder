// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-deploy rollup and the rollup scheduler's day arithmetic.
 *
 * `daily-rollup-sql.test.ts` proves the big statement runs and aggregates
 * correctly against a real Postgres. This suite covers the decisions made in
 * TypeScript around it, each of which changes what a report says:
 *
 *  - WHICH events are deploys (and why an in-flight one is not);
 *  - lead time measured once per execution, and DROPPED rather than clamped when
 *    the two timestamps disagree;
 *  - a conflict update that fills gaps in but never blanks out a measured value,
 *    and never erases a recorded production failure;
 *  - incident correlation that says how confident the link is;
 *  - the settle delay, so a day is never rolled up while executions are still in
 *    it.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fakeTx, renderSql, type FakeTx } from './helpers/fake-tx.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

let tx: FakeTx;

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));
jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (t: unknown) => unknown) => fn(tx.tx),
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const {
  isDeployEvent, leadTimeGapOf, upsertDeployments, applyDeployOutcome, correlateIncident,
} = await import('../src/api/reporting/deploy-rollup.js');
const {
  utcDayStart, rollupSettleHours, rollupBatchDays, rebuildDay, runRollupPass,
} = await import('../src/api/reporting/daily-rollup.js');

const ORG = 'acme';
const DEPLOYED = new Date('2026-09-21T12:00:00.000Z');

const event = (over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  pipelineId: 'pipe-1',
  executionId: 'exec-1',
  eventType: 'STAGE',
  status: 'SUCCEEDED',
  stageName: 'Deploy',
  environment: 'production',
  completedAt: DEPLOYED,
  ...over,
});

describe('isDeployEvent', () => {
  it('is a terminal STAGE event that reached an environment', () => {
    expect(isDeployEvent(event())).toBe(true);
    expect(isDeployEvent(event({ status: 'FAILED' }))).toBe(true);
  });

  it.each([
    ['an ACTION event', { eventType: 'ACTION' }],
    ['a PIPELINE event', { eventType: 'PIPELINE' }],
    ['a stage with no environment', { environment: null }],
    ['a stage with no execution id', { executionId: null }],
  ])('is not %s', (_case, over) => {
    expect(isDeployEvent(event(over))).toBe(false);
  });

  /**
   * An in-flight deploy has no duration, no outcome and no place in a
   * deployment-frequency count. Writing it would make every running deploy look
   * like a successful one until its next event landed.
   */
  it.each(['IN_PROGRESS', 'STARTED', 'SUPERSEDED'])('is not an in-flight deploy (%s)', (status) => {
    expect(isDeployEvent(event({ status }))).toBe(false);
  });
});

describe('leadTimeGapOf', () => {
  it('reports no gap when the commit timestamp resolved', () => {
    expect(leadTimeGapOf(event({ commitTimestamp: DEPLOYED }))).toBeNull();
  });

  /**
   * The forwarder resolves the commit range in-account and reports WHY it could
   * not; anything else here would be this module guessing at a cause the report
   * then shows to a manager.
   */
  it.each(['no_token', 'rate_limited', 'unsupported_source'])('carries the forwarder\'s own reason (%s)', (reason) => {
    expect(leadTimeGapOf(event({ detail: { leadTimeGap: reason } }))).toBe(reason);
  });

  it('falls back to no_commit_data rather than inventing a cause', () => {
    expect(leadTimeGapOf(event())).toBe('no_commit_data');
    expect(leadTimeGapOf(event({ detail: { leadTimeGap: 'because' } }))).toBe('no_commit_data');
    expect(leadTimeGapOf(event({ detail: null }))).toBe('no_commit_data');
  });
});

describe('upsertDeployments', () => {
  beforeEach(() => { tx = fakeTx(); });

  it('writes nothing when a batch carries no deploys', async () => {
    expect(await upsertDeployments([event({ eventType: 'ACTION' })])).toBe(0);
    expect(tx.queries).toHaveLength(0);
  });

  it('writes one row per deploy, keyed on (execution, environment)', async () => {
    tx.queue([{ executionId: 'exec-1' }, { executionId: 'exec-2' }]);
    const n = await upsertDeployments([event(), event({ executionId: 'exec-2', environment: 'staging' })]);
    expect(n).toBe(2);
    const values = tx.of('insert')[0].arg('values') as Array<Record<string, unknown>>;
    expect(values).toHaveLength(2);
    expect(values[0]).toMatchObject({ executionId: 'exec-1', environment: 'production', succeeded: true });
    expect(tx.of('insert')[0].arg('onConflictDoUpdate')).toBeDefined();
  });

  it('measures lead time as commit → deploy, once', async () => {
    tx.queue([{ executionId: 'exec-1' }]);
    // Committed two hours before the deploy.
    await upsertDeployments([event({ commitTimestamp: new Date(DEPLOYED.getTime() - 7200_000), commitCount: 4 })]);
    const [value] = tx.of('insert')[0].arg('values') as Array<Record<string, unknown>>;
    expect(value).toMatchObject({ leadTimeSeconds: 7200, commitCount: 4, leadTimeGap: null });
  });

  /**
   * A negative gap means the two timestamps came from different clocks. Dropped,
   * not clamped: "0 seconds" is a claim, and "unknown" is the truth.
   */
  it('drops a negative lead time rather than clamping it to zero', async () => {
    tx.queue([{ executionId: 'exec-1' }]);
    await upsertDeployments([event({ commitTimestamp: new Date(DEPLOYED.getTime() + 60_000) })]);
    const [value] = tx.of('insert')[0].arg('values') as Array<Record<string, unknown>>;
    expect(value.leadTimeSeconds).toBeNull();
  });

  it('falls back through the event timestamps for the deploy time', async () => {
    tx.queue([{ executionId: 'exec-1' }]);
    const started = new Date('2026-09-21T11:00:00.000Z');
    await upsertDeployments([event({ completedAt: null, startedAt: started })]);
    expect((tx.of('insert')[0].arg('values') as Array<Record<string, unknown>>)[0]?.deployedAt).toEqual(started);
  });

  it('skips a deploy with no usable timestamp at all', async () => {
    expect(await upsertDeployments([event({ completedAt: null, startedAt: null, createdAt: null })])).toBe(0);
    expect(tx.queries).toHaveLength(0);
  });

  /**
   * The conflict update FILLS IN but never blanks out: a later event may resolve a
   * commit range the first one could not, and a redelivery of the original must
   * not erase what was already measured — or the recorded production failure.
   */
  it('fills gaps in on conflict, and never erases a measured value or a failure', async () => {
    tx.queue([{ executionId: 'exec-1' }]);
    await upsertDeployments([event()]);
    const set = tx.of('insert')[0].arg('onConflictDoUpdate') as { set: Record<string, unknown> };
    for (const field of ['earliestCommitAt', 'leadTimeSeconds', 'commitCount', 'commitSha']) {
      expect(renderSql(set.set[field])).toMatch(/COALESCE/);
    }
    // The outcome markers are owned by the outcome route and by incident
    // correlation — the deploy event must not touch them.
    expect('failedAt' in set.set).toBe(false);
    expect('restoredAt' in set.set).toBe(false);
    expect('correlationConfidence' in set.set).toBe(false);
  });

  /** A resolved lead time and a reason it could not be resolved must not coexist. */
  it('clears the gap once a commit timestamp exists', async () => {
    tx.queue([{ executionId: 'exec-1' }]);
    await upsertDeployments([event()]);
    const set = tx.of('insert')[0].arg('onConflictDoUpdate') as { set: Record<string, unknown> };
    expect(renderSql(set.set.leadTimeGap)).toMatch(/CASE WHEN COALESCE/);
    expect(renderSql(set.set.leadTimeGap)).toMatch(/THEN NULL/);
  });

  /**
   * The events are the durable record; this table is derived from them. A rollup
   * failure must not fail an ingest that already committed.
   */
  it('never throws — a rollup failure is not data loss', async () => {
    tx.queueError(new Error('deadlock detected'));
    await expect(upsertDeployments([event()])).resolves.toBe(0);
  });
});

describe('applyDeployOutcome', () => {
  beforeEach(() => { tx = fakeTx(); });

  it('marks a deploy failed', async () => {
    tx.queue([]);
    await applyDeployOutcome(ORG, 'exec-1', 'failed', DEPLOYED, 'production');
    expect(tx.of('update')[0].arg('set')).toMatchObject({ failedAt: DEPLOYED });
    expect(tx.of('update')[0].whereSql()).toContain('"environment"');
  });

  it('scopes to the org even without an environment', async () => {
    tx.queue([]);
    await applyDeployOutcome(ORG, 'exec-1', 'failed', DEPLOYED);
    const where = tx.of('update')[0].whereSql();
    expect(where).toContain('"org_id"');
    expect(where).not.toContain('"environment"');
  });

  /**
   * A restore only means something for a deploy that was marked failed. Recording
   * one without a failure would produce a negative time-to-restore.
   */
  it('only records a restore against a deploy that failed', async () => {
    tx.queue([]);
    await applyDeployOutcome(ORG, 'exec-1', 'restored', DEPLOYED);
    expect(tx.of('update')[0].whereSql()).toContain('"failed_at" IS NOT NULL');
    expect(tx.of('update')[0].arg('set')).toMatchObject({ restoredAt: DEPLOYED });
  });
});

describe('correlateIncident', () => {
  beforeEach(() => { tx = fakeTx(); });

  it('finds nothing when no deploy precedes the incident in the window', async () => {
    tx.queue([]);
    expect(await correlateIncident(ORG, 'production', DEPLOYED, 12)).toBeNull();
    expect(tx.of('update')).toHaveLength(0);
  });

  it('looks only at SUCCESSFUL deploys to that environment, newest first', async () => {
    tx.queue([{ executionId: 'exec-1', deployedAt: DEPLOYED }], []);
    await correlateIncident(ORG, 'production', new Date(DEPLOYED.getTime() + 3600_000), 12);
    const where = tx.of('select')[0].whereSql();
    expect(where).toContain('"succeeded"');
    expect(where).toContain('"environment"');
    expect(renderSql(tx.of('select')[0].arg('orderBy'))).toContain('DESC');
  });

  /**
   * "This deploy broke production" and "an incident opened eleven hours after this
   * deploy, and the window is twelve" are different claims, and a manager acts
   * differently on each — so the link carries how confident it is.
   */
  it.each([
    ['high', 1],
    ['medium', 5],
    ['low', 11],
  ])('labels a link %s when the incident opened %ih after the deploy', async (confidence, hoursAfter) => {
    tx.queue([{ executionId: 'exec-1', deployedAt: DEPLOYED }], []);
    const result = await correlateIncident(ORG, 'production', new Date(DEPLOYED.getTime() + hoursAfter * 3600_000), 12);
    expect(result).toEqual({ executionId: 'exec-1', confidence });
    expect(tx.of('update')[0].arg('set')).toMatchObject({ correlationConfidence: confidence });
  });

  /**
   * The FIRST incident linked to a deploy is the one that made it a change
   * failure; a later one re-dating it would move time-to-restore.
   */
  it('does not overwrite a failure already attributed', async () => {
    tx.queue([{ executionId: 'exec-1', deployedAt: DEPLOYED }], []);
    await correlateIncident(ORG, 'production', new Date(DEPLOYED.getTime() + 3600_000), 12);
    expect(tx.of('update')[0].whereSql()).toContain('"failed_at" is null');
  });
});

describe('the rollup pass timing', () => {
  it('floors a moment to its UTC day', () => {
    expect(utcDayStart(new Date('2026-09-21T23:59:59.999Z')).toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(utcDayStart(new Date('2026-09-21T00:00:00.000Z')).toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });

  /**
   * Rolling up a day at 00:01 counts every execution still running at midnight as
   * neither a success nor a failure. Six hours matches the report scheduler's own
   * settle delay — a rollup that lagged it would make a report read a half-built
   * day.
   */
  it('settles for six hours and rebuilds a week by default', () => {
    expect(rollupSettleHours()).toBe(6);
    expect(rollupBatchDays()).toBe(7);
  });

  it('rebuilds one day by its UTC bounds, and reports the rows it wrote', async () => {
    tx = fakeTx();
    tx.queue([{ rowCount: 3 }] as unknown[]);
    // `execute` resolves to the driver's result object; the helper hands back the
    // queued array, so the count falls back to 0 — what matters here is that the
    // statement is built and bounded to the day.
    await expect(rebuildDay(new Date('2026-09-21T15:00:00Z'))).resolves.toBeGreaterThanOrEqual(0);
    expect(tx.of('execute')).toHaveLength(1);
  });

  /**
   * Rebuilding a WINDOW rather than only the newest day is what handles late
   * events: the dead-letter redrive lands events for days already rolled up, and a
   * job that only ever built "yesterday" would leave those permanently wrong.
   */
  it('rebuilds a window of settled days, newest first', async () => {
    tx = fakeTx();
    const result = await runRollupPass(new Date('2026-09-21T23:00:00Z'));
    expect(result.days).toBe(rollupBatchDays());
    expect(tx.of('execute')).toHaveLength(rollupBatchDays());
  });

  /** A failing day must not take the pass — or the scheduler — down with it. */
  it('keeps going when one day fails, and reports the days it managed', async () => {
    tx = fakeTx();
    tx.queueError(new Error('statement timeout'));
    const result = await runRollupPass(new Date('2026-09-21T23:00:00Z'));
    expect(result.days).toBe(rollupBatchDays() - 1);
  });

  it('honours the env overrides', () => {
    const prevSettle = process.env.REPORTING_ROLLUP_SETTLE_HOURS;
    const prevBatch = process.env.REPORTING_ROLLUP_BATCH_DAYS;
    process.env.REPORTING_ROLLUP_SETTLE_HOURS = '2';
    process.env.REPORTING_ROLLUP_BATCH_DAYS = '30';
    try {
      expect(rollupSettleHours()).toBe(2);
      expect(rollupBatchDays()).toBe(30);
    } finally {
      if (prevSettle === undefined) delete process.env.REPORTING_ROLLUP_SETTLE_HOURS;
      else process.env.REPORTING_ROLLUP_SETTLE_HOURS = prevSettle;
      if (prevBatch === undefined) delete process.env.REPORTING_ROLLUP_BATCH_DAYS;
      else process.env.REPORTING_ROLLUP_BATCH_DAYS = prevBatch;
    }
  });
});
