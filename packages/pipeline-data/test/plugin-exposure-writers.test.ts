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
  exposureFromScan, reconcilePipelineExposures, syncVersionExposures, pipelinesOnVersion, closeVersionExposures,
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
    expect(await refreshLatestForPlugin('trivy', { publisher: 'acme' }, '2.0.0')).toBe(2);
    expect(tx.of('update')).toHaveLength(1);
    expect((tx.of('update')[0].arg('set') as Record<string, unknown>).latestVersion).toBe('2.0.0');
  });

  it('recomputes the gap in SQL so a publish costs one round trip', async () => {
    tx.queue([]);
    await refreshLatestForPlugin('trivy', { publisher: 'acme' }, '2.0.0');
    const gap = renderSql((tx.of('update')[0].arg('set') as Record<string, unknown>).versionGap);
    expect(gap).toContain('split_part');
    expect(gap).toContain('major');
  });

  it('matches an own-org plugin by a NULL publisher, not by an empty string — and only in ITS org', async () => {
    tx.queue([]);
    await refreshLatestForPlugin('local-tool', { orgId: ORG }, '1.1.0');
    const where = tx.of('update')[0].whereSql();
    expect(where).toContain('"plugin_publisher" is null');
    expect(where).toContain('"org_id" = ');
  });

  it('a listing refresh is not narrowed to an org: every installer\'s pipelines declare it', async () => {
    tx.queue([]);
    await refreshLatestForPlugin('trivy', { publisher: 'acme' }, '2.0.0');
    expect(tx.of('update')[0].whereSql()).not.toContain('"org_id"');
  });

  /** A non-semver resolved version has no gap to compute and would throw on the cast. */
  it('skips rows whose resolved version is not semver', async () => {
    tx.queue([]);
    await refreshLatestForPlugin('trivy', { publisher: 'acme' }, '2.0.0');
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
    expect(await closeFixedExposures(PIPE, 'deployed', [{ pluginName: 'trivy', pluginVersion: '1.1.0' }], NOW)).toBe(1);
    expect(tx.of('update')[0].arg('set')).toMatchObject({ fixedAt: NOW, triageState: 'fixed' });
  });

  it('does nothing when every open exposure is still live', async () => {
    tx.queue([{ id: 'e1', pluginName: 'trivy', pluginVersion: '1.0.0' }]);
    expect(await closeFixedExposures(PIPE, 'deployed', [{ pluginName: 'trivy', pluginVersion: '1.0.0' }], NOW)).toBe(0);
    expect(tx.of('update')).toHaveLength(0);
  });

  it('does nothing when the pipeline has no open exposures', async () => {
    tx.queue([]);
    expect(await closeFixedExposures(PIPE, 'deployed', [], NOW)).toBe(0);
  });

  it('only considers exposures that are still open', async () => {
    tx.queue([]);
    await closeFixedExposures(PIPE, 'deployed', [], NOW);
    expect(tx.of('select')[0].whereSql()).toContain('"fixed_at" is null');
  });

  /** A version rebuilt on a patched base keeps its string; the new digest is the fix. */
  it('treats a new digest of the same version as moved off', async () => {
    const OLD = `sha256:${'a'.repeat(64)}`;
    const NEW = `sha256:${'b'.repeat(64)}`;
    tx.queue([{ id: 'e1', pluginName: 'trivy', pluginVersion: '1.0.0', imageDigest: OLD }], [{ id: 'e1' }]);
    expect(await closeFixedExposures(PIPE, 'deployed', [{ pluginName: 'trivy', pluginVersion: '1.0.0', imageDigest: NEW }], NOW)).toBe(1);
  });

  /** The two sides move independently: a config fix must not close the deployed row. */
  it('only closes the given source', async () => {
    tx.queue([]);
    await closeFixedExposures(PIPE, 'declared', [], NOW);
    expect(tx.of('select')[0].whereSql()).toContain('"source"');
  });
});

describe('exposureFromScan', () => {
  const DIGEST = `sha256:${'c'.repeat(64)}`;
  const finding = (over: Record<string, unknown> = {}) => ({
    id: 'CVE-1', severity: 'critical', packageName: 'openssl', packageVersion: '3.0.1', fixedIn: ['3.0.2'], ...over,
  });

  it('reads fixable counts and only fixable findings from the summary', () => {
    const e = exposureFromScan({
      imageDigest: DIGEST,
      scanSummary: { criticalFixable: 1, highFixable: 2, imageDigest: DIGEST, findings: [finding(), finding({ id: 'CVE-2', fixedIn: [] })] },
    });
    expect(e).toMatchObject({ criticalCount: 1, highCount: 2 });
    expect(e?.topFindings.map((f) => f.id)).toEqual(['CVE-1']);
  });

  it('is null for a clean summary', () => {
    expect(exposureFromScan({ scanSummary: { criticalFixable: 0, highFixable: 0, findings: [] } })).toBeNull();
  });

  /** A summary of another image says nothing about the one the pipeline runs. */
  it('ignores a summary of a different digest and falls back to the flag', () => {
    expect(exposureFromScan({
      imageDigest: DIGEST,
      scanSummary: { criticalFixable: 3, highFixable: 0, imageDigest: `sha256:${'d'.repeat(64)}`, findings: [] },
    })).toBeNull();
    expect(exposureFromScan({
      imageDigest: DIGEST,
      scanSummary: { criticalFixable: 3, highFixable: 0, imageDigest: `sha256:${'d'.repeat(64)}`, findings: [] },
      scanFlaggedAt: NOW,
      scanFlag: { gated: 2, high: 1, maxFindings: 0, findings: [finding()] },
    })).toMatchObject({ criticalCount: 2, highCount: 1 });
  });
});

describe('reconcilePipelineExposures', () => {
  it('opens flagged steps and closes the rest of that source by absence', async () => {
    tx.queue([{ id: 'x1' }], [{ id: 'old', pluginName: 'grype', pluginVersion: '0.1.0', imageDigest: null }], [{ id: 'old' }]);
    const result = await reconcilePipelineExposures({
      orgId: ORG,
      pipelineId: PIPE,
      source: 'deployed',
      steps: [
        { pluginName: 'trivy', pluginVersion: '1.0.0', scan: { scanSummary: { criticalFixable: 1, highFixable: 0, findings: [] } } },
        { pluginName: 'semgrep', pluginVersion: '2.0.0', scan: {} },
      ],
    }, NOW);
    expect(result).toEqual({ opened: 1, closed: 1 });
    expect(tx.of('insert')[0].arg('values')).toEqual([expect.objectContaining({ pluginName: 'trivy', source: 'deployed', criticalCount: 1 })]);
  });

  it('never throws', async () => {
    tx.queueError(new Error('db down'));
    await expect(reconcilePipelineExposures({ orgId: ORG, pipelineId: PIPE, source: 'declared', steps: [] }, NOW))
      .resolves.toEqual({ opened: 0, closed: 0 });
  });
});

describe('syncVersionExposures', () => {
  const REF = { pluginName: 'trivy', pluginVersion: '1.0.0', pluginPublisher: null, imageDigest: `sha256:${'e'.repeat(64)}` };

  it('fans a flagged version out to every pipeline declaring or running it', async () => {
    tx.queue(
      [
        { org_id: ORG, pipeline_id: PIPE, source: 'deployed', plugin_publisher: null, image_digest: REF.imageDigest, pipeline_name: 'web' },
        { org_id: ORG, pipeline_id: PIPE, source: 'declared', plugin_publisher: null, image_digest: REF.imageDigest, pipeline_name: 'web' },
      ],
      [{ id: 'a' }, { id: 'b' }],
    );
    const result = await syncVersionExposures(REF, { scanSummary: { criticalFixable: 2, highFixable: 1, findings: [] } }, NOW);
    expect(result).toEqual({ opened: 2, closed: 0 });
    expect((tx.of('insert')[0].arg('values') as Array<{ source: string }>).map((v) => v.source)).toEqual(['deployed', 'declared']);
  });

  /** A rebuild-in-place or a withdrawn advisory shows as fixed the next night. */
  it('closes every open exposure on a version that came back clean', async () => {
    tx.queue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(await syncVersionExposures(REF, { scanSummary: { criticalFixable: 0, highFixable: 0, findings: [] } }, NOW))
      .toEqual({ opened: 0, closed: 3 });
    expect(tx.of('update')[0].arg('set')).toMatchObject({ fixedAt: NOW, triageState: 'fixed' });
  });
});

describe('pipelinesOnVersion', () => {
  it('unions the deployed (manifest) and declared (resolution) sides, narrowed as asked', async () => {
    tx.queue({ rows: [{ org_id: ORG, pipeline_id: PIPE, source: 'deployed', plugin_publisher: 'acme', image_digest: null, pipeline_name: null, steps: ['Build/scan'] }] } as never);
    const rows = await pipelinesOnVersion({ pluginName: 'trivy', pluginVersion: '1.0.0', pluginPublisher: 'acme', imageDigest: `sha256:${'1'.repeat(64)}`, orgIds: [ORG] });
    expect(rows).toEqual([{ orgId: ORG, pipelineId: PIPE, pipelineName: null, source: 'deployed', pluginPublisher: 'acme', imageDigest: null, steps: ['Build/scan'] }]);
    const text = renderSql(tx.of('execute')[0].arg('execute'));
    // A soft-deleted pipeline is not "affected": inner join on a live pipeline.
    expect(text).toContain('JOIN pipelines p ON');
    expect(text).not.toContain('LEFT JOIN pipelines');
    expect(text).toContain('p.deleted_at IS NULL');
    expect(text).toContain('pipeline_step_manifests');
    expect(text).toContain('pipeline_plugin_resolution');
    expect(text).toContain('m.image_digest =');
    expect(text).toContain('r.plugin_publisher =');
    expect(text).toContain('m.org_id = ANY');
  });

  it('matches an own-org row by a NULL publisher, and any image when no digest is given', async () => {
    tx.queue([]);
    await pipelinesOnVersion({ pluginName: 'trivy', pluginVersion: '1.0.0', pluginPublisher: null });
    const text = renderSql(tx.of('execute')[0].arg('execute'));
    expect(text).toContain('m.plugin_publisher IS NULL');
    expect(text).not.toContain('m.image_digest =');
    expect(text).not.toContain('ANY(');
  });

  it('places no publisher predicate when the publisher is omitted, and short-circuits an empty org list', async () => {
    tx.queue([]);
    await pipelinesOnVersion({ pluginName: 'trivy', pluginVersion: '1.0.0' });
    expect(renderSql(tx.of('execute')[0].arg('execute'))).not.toContain('plugin_publisher IS NULL');
    expect(await pipelinesOnVersion({ pluginName: 'trivy', pluginVersion: '1.0.0', orgIds: [] })).toEqual([]);
    expect(tx.of('execute')).toHaveLength(1);
  });
});

describe('closeVersionExposures', () => {
  it('narrows by digest, publisher and org when given', async () => {
    tx.queue([{ id: 'a' }]);
    expect(await closeVersionExposures({ pluginName: 'trivy', pluginVersion: '1.0.0', pluginPublisher: 'acme', imageDigest: `sha256:${'2'.repeat(64)}`, orgIds: [ORG] }, NOW)).toBe(1);
    const where = tx.of('update')[0].whereSql();
    expect(where).toContain('"image_digest"');
    expect(where).toContain('"plugin_publisher"');
    expect(where).toContain('"org_id"');
  });

  it('matches a NULL publisher for an own-org plugin', async () => {
    tx.queue([]);
    await closeVersionExposures({ pluginName: 'trivy', pluginVersion: '1.0.0', pluginPublisher: null }, NOW);
    expect(tx.of('update')[0].whereSql()).toContain('"plugin_publisher" is null');
  });
});

describe('syncVersionExposures — failure', () => {
  it('never throws — a rescan must not fail on a derived write', async () => {
    tx.queueError(new Error('db down'));
    await expect(syncVersionExposures({ pluginName: 'trivy', pluginVersion: '1.0.0' }, { scanSummary: { criticalFixable: 1, highFixable: 0, findings: [] } }, NOW))
      .resolves.toEqual({ opened: 0, closed: 0 });
  });
});

describe('exposureFromScan — edges', () => {
  it('is null with no scan state at all, or a flag with nothing fixable', () => {
    expect(exposureFromScan({})).toBeNull();
    expect(exposureFromScan({ scanSummary: [] })).toBeNull();
    expect(exposureFromScan({ scanFlaggedAt: NOW, scanFlag: { gated: 0, high: 0, maxFindings: 0, findings: [] } })).toBeNull();
    // A flag value with no flagged-at is a cleared flag.
    expect(exposureFromScan({ scanFlag: { gated: 3, high: 0, maxFindings: 0, findings: [] } })).toBeNull();
  });

  it('tolerates a summary with no finding list', () => {
    expect(exposureFromScan({ scanSummary: { criticalFixable: 0, highFixable: 2 } })).toEqual({ criticalCount: 0, highCount: 2, topFindings: [], findingKeys: [] });
  });

  it('dedupes two steps on one version into one exposure', async () => {
    tx.queue([{ id: 'x' }], []);
    const scan = { scanSummary: { criticalFixable: 1, highFixable: 0, findings: [] } };
    await reconcilePipelineExposures({
      orgId: ORG,
      pipelineId: PIPE,
      source: 'declared',
      steps: [{ pluginName: 'trivy', pluginVersion: '1.0.0', scan }, { pluginName: 'trivy', pluginVersion: '1.0.0', scan }],
    }, NOW);
    expect(tx.of('insert')[0].arg('values')).toHaveLength(1);
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
    expect(where).toContain('fixed_at IS NULL');
    // The shared live predicate: a false positive is not live either.
    expect(where).toContain("triage_state = 'open'");
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

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    orgId: ORG,
    pipelineId: PIPE,
    pluginPublisher: null,
    pluginName: 'trivy',
    pluginVersion: '1.0.0',
    imageDigest: null,
    source: 'declared',
    criticalCount: 1,
    highCount: 0,
    topFindings: [],
    findingKeys: ['CVE-1|openssl|3.0.1'],
    triageState: 'open',
    acceptedUntil: null,
    acceptedFindingKeys: [],
    acceptedKev: false,
    triageReason: null,
    triagedBy: null,
    triagedAt: null,
    flaggedAt: NOW,
    fixedAt: null,
    ...over,
  });

  it('records a bounded acceptance, freezing the finding keys, on the row and its sibling', async () => {
    const until = new Date(NOW.getTime() + 86_400_000);
    tx.queue([row()], [row({ triageState: 'accepted', acceptedUntil: until }), row({ id: 'e2', source: 'deployed', triageState: 'accepted', acceptedUntil: until })]);
    const rows = await triageExposure(ORG, 'e1', {
      state: 'accepted', reason: 'waiting on upstream fix', acceptedUntil: until, actor: 'u1',
    });
    expect(rows.map((r) => r.id)).toEqual(['e1', 'e2']);
    expect(tx.of('update')[0].arg('set')).toMatchObject({
      triageState: 'accepted', acceptedUntil: until, triageReason: 'waiting on upstream fix', triagedBy: 'u1', acceptedKev: false,
    });
    // The sibling match: same pipeline + plugin + version + image, unfixed.
    expect(tx.of('update')[0].whereSql()).toContain('"pipeline_id"');
  });

  it('clears the deadline and the frozen keys for any state that is not an acceptance', async () => {
    tx.queue([row()], [row({ triageState: 'false_positive' })]);
    await triageExposure(ORG, 'e1', { state: 'false_positive', reason: 'not reachable', actor: 'u1' });
    expect(tx.of('update')[0].arg('set')).toMatchObject({ triageState: 'false_positive', acceptedUntil: null, acceptedFindingKeys: [] });
  });

  it('is scoped to the org, and reports a miss (nothing updated)', async () => {
    tx.queue([]);
    expect(await triageExposure(ORG, 'nope', { state: 'open', actor: 'u1' })).toEqual([]);
    expect(tx.of('update')).toHaveLength(0);
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
