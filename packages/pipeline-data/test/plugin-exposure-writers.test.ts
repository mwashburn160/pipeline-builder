// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The exposure and resolution WRITERS.
 *
 * `plugin-exposure.test.ts` proves the SQL behaves against a real Postgres; this
 * covers the decisions the TypeScript makes around it, which is where the
 * judgement calls live:
 *
 *  - a pipeline's resolution is REPLACED, not upserted, so a step deleted from a
 *    config stops being reported;
 *  - a rescan refresh must not undo a triage decision, but must expire a
 *    time-boxed acceptance;
 *  - exposures close by ABSENCE on a deploy, not on the next rescan;
 *  - an expired acceptance READS as open, because the report is read far more
 *    often than the rescan runs;
 *  - accepting a finding without a reason and a deadline is refused outright.
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
  replacePipelineResolution, refreshLatestForPlugin, upsertExposures,
  closeFixedExposures, openExposures, triageExposure, lapsedAcceptances,
} = await import('../src/api/reporting/plugin-exposure.js');

const ORG = 'acme';
const PIPE = 'pipe-1';
const NOW = new Date('2026-09-21T12:00:00.000Z');

const step = (over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  pipelineId: PIPE,
  stageName: 'Build',
  stepName: 'scan',
  pluginPublisher: 'acme',
  pluginName: 'trivy',
  declaredVersion: '^1.0.0',
  resolvedVersion: '1.0.0',
  latestVersion: '2.0.0',
  ...over,
});

beforeEach(() => { tx = fakeTx(); });

describe('replacePipelineResolution', () => {
  /**
   * DELETE-then-INSERT, because a step can be REMOVED from a config: an
   * upsert-only writer would leave the deleted step behind forever and the
   * outdated-plugin section would keep reporting a step the pipeline no longer has.
   */
  it('deletes the pipeline\'s rows before inserting the new ones', async () => {
    tx.queue([], [{ pipelineId: PIPE }]);
    await replacePipelineResolution(PIPE, [step()]);
    expect(tx.queries.map((q) => q.kind)).toEqual(['delete', 'insert']);
    expect(tx.of('delete')[0].whereSql()).toContain('"pipeline_id"');
  });

  it('computes the version gap as it writes', async () => {
    tx.queue([], [{ pipelineId: PIPE }]);
    await replacePipelineResolution(PIPE, [step({ resolvedVersion: '1.0.0', latestVersion: '2.0.0' })]);
    const [value] = tx.of('insert')[0].arg('values') as Array<Record<string, unknown>>;
    expect(value.versionGap).toBe('major');
  });

  it('stores a null gap when a version cannot be parsed', async () => {
    tx.queue([], [{ pipelineId: PIPE }]);
    await replacePipelineResolution(PIPE, [step({ resolvedVersion: 'latest' })]);
    expect((tx.of('insert')[0].arg('values') as Array<Record<string, unknown>>)[0]?.versionGap).toBeNull();
  });

  /** A pipeline with no plugin steps still has to clear its old rows. */
  it('clears the rows and inserts nothing for a pipeline with no steps', async () => {
    tx.queue([]);
    expect(await replacePipelineResolution(PIPE, [])).toBe(0);
    expect(tx.queries.map((q) => q.kind)).toEqual(['delete']);
  });

  it('defaults withinPolicy to true rather than leaving it unset', async () => {
    tx.queue([], [{ pipelineId: PIPE }]);
    await replacePipelineResolution(PIPE, [step()]);
    expect((tx.of('insert')[0].arg('values') as Array<Record<string, unknown>>)[0]?.withinPolicy).toBe(true);
  });
});

describe('refreshLatestForPlugin', () => {
  it('updates every pipeline that declares the plugin, in one statement', async () => {
    tx.queue([{ pipelineId: 'a' }, { pipelineId: 'b' }]);
    expect(await refreshLatestForPlugin('trivy', 'acme', '2.0.0')).toBe(2);
    expect(tx.of('update')).toHaveLength(1);
    expect((tx.of('update')[0].arg('set') as Record<string, unknown>).latestVersion).toBe('2.0.0');
  });

  it('recomputes the gap in SQL so a publish costs one round trip', async () => {
    tx.queue([]);
    await refreshLatestForPlugin('trivy', 'acme', '2.0.0');
    const gap = renderSql((tx.of('update')[0].arg('set') as Record<string, unknown>).versionGap);
    expect(gap).toContain('split_part');
    expect(gap).toContain('major');
  });

  it('matches an own-org plugin by a NULL publisher, not by an empty string', async () => {
    tx.queue([]);
    await refreshLatestForPlugin('local-tool', null, '1.1.0');
    expect(tx.of('update')[0].whereSql()).toContain('"plugin_publisher" is null');
  });

  /** A non-semver resolved version has no gap to compute and would throw on the cast. */
  it('skips rows whose resolved version is not semver', async () => {
    tx.queue([]);
    await refreshLatestForPlugin('trivy', 'acme', '2.0.0');
    expect(tx.of('update')[0].whereSql()).toMatch(/resolved_version.*~/);
  });
});

const exposure = (over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  pipelineId: PIPE,
  pluginName: 'trivy',
  pluginVersion: '1.0.0',
  source: 'deployed' as const,
  criticalCount: 2,
  highCount: 5,
  ...over,
});

describe('upsertExposures', () => {
  it('writes nothing for an empty batch', async () => {
    expect(await upsertExposures([])).toBe(0);
    expect(tx.queries).toHaveLength(0);
  });

  it('opens an exposure with its findings', async () => {
    tx.queue([{ id: 'e1' }]);
    expect(await upsertExposures([exposure({ topFindings: [{ id: 'CVE-1' }] })], NOW)).toBe(1);
    const [value] = tx.of('insert')[0].arg('values') as Array<Record<string, unknown>>;
    expect(value).toMatchObject({ criticalCount: 2, highCount: 5, source: 'deployed' });
    expect(value.topFindings).toEqual([{ id: 'CVE-1' }]);
  });

  /**
   * An org that accepted a finding with a reason and a deadline has made a
   * decision. Re-raising it every night is how a team learns to ignore the report.
   */
  it('a refresh does NOT reset a triage decision', async () => {
    tx.queue([{ id: 'e1' }]);
    await upsertExposures([exposure()], NOW);
    const set = (tx.of('insert')[0].arg('onConflictDoUpdate') as { set: Record<string, unknown> }).set;
    const state = renderSql(set.triageState);
    // The state is preserved by an explicit ELSE, not overwritten.
    expect(state).toContain('ELSE');
    expect(state).toContain('triage_state');
  });

  /** …but an acceptance past its deadline stops being one. That is the point of it. */
  it('expires an acceptance whose deadline has passed', async () => {
    tx.queue([{ id: 'e1' }]);
    await upsertExposures([exposure()], NOW);
    const set = (tx.of('insert')[0].arg('onConflictDoUpdate') as { set: Record<string, unknown> }).set;
    const state = renderSql(set.triageState);
    expect(state).toContain('accepted_until');
    expect(state).toMatch(/THEN 'open'/);
  });

  /** A closed exposure flagged again is a REGRESSION; leaving it fixed hides it. */
  it('clears the fix marker on a refresh', async () => {
    tx.queue([{ id: 'e1' }]);
    await upsertExposures([exposure()], NOW);
    const set = (tx.of('insert')[0].arg('onConflictDoUpdate') as { set: Record<string, unknown> }).set;
    expect(set.fixedAt).toBeNull();
    expect(renderSql(set.triageState)).toMatch(/'fixed' THEN 'open'/);
  });

  it('never throws — a rescan must not fail on a derived write', async () => {
    tx.queueError(new Error('deadlock'));
    await expect(upsertExposures([exposure()], NOW)).resolves.toBe(0);
  });
});

describe('closeFixedExposures', () => {
  it('closes only the versions the pipeline no longer runs', async () => {
    tx.queue(
      [
        { id: 'e1', pluginName: 'trivy', pluginVersion: '1.0.0' },
        { id: 'e2', pluginName: 'trivy', pluginVersion: '1.1.0' },
      ],
      [{ id: 'e1' }],
    );
    expect(await closeFixedExposures(PIPE, [{ pluginName: 'trivy', pluginVersion: '1.1.0' }], NOW)).toBe(1);
    expect(tx.of('update')[0].arg('set')).toMatchObject({ fixedAt: NOW, triageState: 'fixed' });
  });

  it('does nothing when every open exposure is still live', async () => {
    tx.queue([{ id: 'e1', pluginName: 'trivy', pluginVersion: '1.0.0' }]);
    expect(await closeFixedExposures(PIPE, [{ pluginName: 'trivy', pluginVersion: '1.0.0' }], NOW)).toBe(0);
    expect(tx.of('update')).toHaveLength(0);
  });

  it('does nothing when the pipeline has no open exposures', async () => {
    tx.queue([]);
    expect(await closeFixedExposures(PIPE, [], NOW)).toBe(0);
  });

  it('only considers exposures that are still open', async () => {
    tx.queue([]);
    await closeFixedExposures(PIPE, [], NOW);
    expect(tx.of('select')[0].whereSql()).toContain('"fixed_at" is null');
  });
});

describe('openExposures', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    pipelineId: PIPE,
    pluginName: 'trivy',
    pluginVersion: '1.0.0',
    pluginPublisher: 'acme',
    source: 'deployed',
    criticalCount: 2,
    highCount: 5,
    topFindings: [{ id: 'CVE-1' }],
    triageState: 'open',
    acceptedUntil: null,
    flaggedAt: NOW,
    ...over,
  });

  it('returns the org\'s live exposures, worst first', async () => {
    tx.queue([row()]);
    const rows = await openExposures(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ criticalCount: 2, triageState: 'open' });
    expect(renderSql(tx.of('select')[0].arg('orderBy'))).toContain('DESC');
  });

  /**
   * A read must not present an expired acceptance as a current one — and the report
   * is read far more often than the rescan that would refresh it runs.
   */
  it('reports an expired acceptance as open', async () => {
    tx.queue([row({ triageState: 'accepted', acceptedUntil: new Date(NOW.getTime() - 1000) })]);
    expect((await openExposures(ORG))[0]?.triageState).toBe('open');
  });

  it('excludes a live acceptance in the query itself', async () => {
    tx.queue([]);
    await openExposures(ORG);
    const where = tx.of('select')[0].whereSql();
    expect(where).toContain('accepted_until');
    expect(where).toContain('"fixed_at" is null');
  });

  it('tolerates a row with no findings recorded', async () => {
    tx.queue([row({ topFindings: null, pluginPublisher: null })]);
    const [r] = await openExposures(ORG);
    expect(r?.topFindings).toEqual([]);
    expect(r?.pluginPublisher).toBeNull();
  });
});

describe('triageExposure', () => {
  /**
   * A permanent, unexplained mute is how a finding stops being anybody's problem.
   * There is no good reason to support it, so the caller gets an error rather than
   * a silently unbounded acceptance.
   */
  it.each([
    ['no deadline', { state: 'accepted' as const, reason: 'waiting on upstream', actor: 'u1' }],
    ['no reason', { state: 'accepted' as const, acceptedUntil: NOW, actor: 'u1' }],
    ['a blank reason', { state: 'accepted' as const, reason: '   ', acceptedUntil: NOW, actor: 'u1' }],
  ])('refuses an acceptance with %s', async (_case, decision) => {
    await expect(triageExposure(ORG, 'e1', decision)).rejects.toThrow(/reason and an expiry/);
    expect(tx.queries).toHaveLength(0);
  });

  it('records a bounded acceptance', async () => {
    tx.queue([{ id: 'e1' }]);
    const ok = await triageExposure(ORG, 'e1', {
      state: 'accepted', reason: 'waiting on upstream fix', acceptedUntil: NOW, actor: 'u1',
    });
    expect(ok).toBe(true);
    expect(tx.of('update')[0].arg('set')).toMatchObject({
      triageState: 'accepted', acceptedUntil: NOW, triageReason: 'waiting on upstream fix', triagedBy: 'u1',
    });
  });

  it('clears the deadline for any state that is not an acceptance', async () => {
    tx.queue([{ id: 'e1' }]);
    await triageExposure(ORG, 'e1', { state: 'false_positive', reason: 'not reachable', actor: 'u1' });
    expect(tx.of('update')[0].arg('set')).toMatchObject({ triageState: 'false_positive', acceptedUntil: null });
  });

  it('is scoped to the org, and reports a miss', async () => {
    tx.queue([]);
    expect(await triageExposure(ORG, 'nope', { state: 'open', actor: 'u1' })).toBe(false);
    expect(tx.of('update')[0].whereSql()).toContain('"org_id"');
  });
});

describe('lapsedAcceptances', () => {
  /**
   * Surfaced rather than silently reopened: somebody decided to accept this until a
   * date, that date has passed, and the person who decided is who should hear.
   */
  it('finds accepted, unfixed exposures past their deadline', async () => {
    tx.queue([{ id: 'e1', pluginName: 'trivy', pluginVersion: '1.0.0', triagedBy: 'u1', acceptedUntil: NOW }]);
    const rows = await lapsedAcceptances(ORG, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ triagedBy: 'u1' });
    const where = tx.of('select')[0].whereSql();
    expect(where).toContain('"triage_state"');
    expect(where).toContain('"fixed_at" is null');
    expect(where).toContain('"accepted_until" <=');
  });
});
