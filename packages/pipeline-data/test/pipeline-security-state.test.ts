// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A pipeline's per-step security state and the removal rule:
 *
 *  - the declared resolution is assembled ONCE for both writers (a save, and the
 *    plugin service re-resolving after a publish / yank / delete);
 *  - a step's last lookup is recorded per (pipeline, step);
 *  - a version / image any pipeline references is found by every removal path —
 *    declared (live pipelines), deployed (soft-deleted pipelines too) and open
 *    deployed exposures;
 *  - a pipeline's ACTIVE acceptances merge per version, and lapsed ones reopen;
 *  - a removed step / pipeline closes its exposures `removed`, keeping the triage.
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
  declaredResolution, stageAndStep, stepLabelOf, recordStepLookup, pipelineStepLookups, declaredPipelinesForPlugin,
} = await import('../src/api/pipeline-step-resolution.js');
const { findVersionReferences, distinctPipelines, orgImageDigestsInUse, versionReferencedPredicate } = await import('../src/api/version-references.js');
const {
  pipelineExposures, exposureById, activeAcceptances, acceptanceKey, reopenLapsedAcceptances, closePipelineExposures,
} = await import('../src/api/reporting/plugin-exposure.js');
const { sql } = await import('drizzle-orm');

const ORG = 'acme';
const PIPE = 'pipe-1';
const NOW = new Date('2026-11-02T12:00:00.000Z');
const LATER = new Date('2026-12-01T00:00:00.000Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;

beforeEach(() => { tx = fakeTx(); });

describe('step labels', () => {
  it('round-trips a stage/step label and the synth step', () => {
    expect(stageAndStep('Build/scan')).toEqual(['Build', 'scan']);
    expect(stageAndStep('synth')).toEqual(['synth', 'synth']);
    expect(stepLabelOf('Build', 'scan')).toBe('Build/scan');
    expect(stepLabelOf('synth', 'synth')).toBe('synth');
  });
});

describe('declaredResolution', () => {
  it('resolves each distinct filter once, records refusals as out of policy, and stamps the root org', async () => {
    const resolve = jest.fn(async (filter: Record<string, unknown>) => {
      if (filter.name === 'gone') return { refusal: { code: 'NOT_FOUND' } };
      return {
        plugin: {
          id: 'p1',
          publisher: null,
          name: String(filter.name),
          version: filter.isActive && !filter.version ? '2.0.0' : '1.0.0',
          imageDigest: DIGEST,
          scan: { scanSummary: { criticalFixable: 1, highFixable: 0 } },
        },
      };
    });
    const { rows, exposureSteps } = await declaredResolution({
      pipelineId: PIPE,
      orgId: ORG,
      rootOrgId: 'root',
      steps: [
        { label: 'Build/scan', name: 'trivy', filter: { version: '1.0.0' }, lookupFilter: { name: 'trivy', version: '1.0.0' } },
        { label: 'Test/scan', name: 'trivy', filter: { version: '1.0.0' }, lookupFilter: { name: 'trivy', version: '1.0.0' } },
        { label: 'synth', name: 'gone', lookupFilter: { name: 'gone' } },
      ],
      resolve,
    });
    // trivy@1.0.0 once, trivy latest once, gone once, gone latest once.
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(rows).toEqual([
      expect.objectContaining({ stageName: 'Build', stepName: 'scan', resolvedVersion: '1.0.0', latestVersion: '2.0.0', resolvedDigest: DIGEST, withinPolicy: true, rootOrgId: 'root' }),
      expect.objectContaining({ stageName: 'Test', stepName: 'scan', resolvedVersion: '1.0.0' }),
      expect.objectContaining({ stageName: 'synth', stepName: 'synth', pluginName: 'gone', resolvedVersion: null, withinPolicy: false }),
    ]);
    expect(exposureSteps).toHaveLength(2);
  });
});

describe('step lookups', () => {
  it('upserts one row per (pipeline, step), capping warnings', async () => {
    tx.queue([]);
    await recordStepLookup({
      orgId: ORG,
      pipelineId: PIPE,
      stepKey: 'Build/scan',
      pluginName: 'trivy',
      resolvedVersion: '1.0.0',
      imageDigest: DIGEST,
      warnings: Array.from({ length: 60 }, (_, i) => ({ code: `W${i}`, message: 'm', severity: 'warning' })),
    });
    const insert = tx.of('insert')[0];
    expect(insert).toBeDefined();
    expect((insert.arg('values') as { warnings: unknown[] }).warnings).toHaveLength(50);
  });

  it('reads the org\'s lookups for a pipeline', async () => {
    tx.queue([{ stepKey: 'Build/scan' }]);
    expect(await pipelineStepLookups(ORG, PIPE)).toEqual([{ stepKey: 'Build/scan' }]);
  });
});

describe('declaredPipelinesForPlugin', () => {
  it('finds the live pipelines declaring a listing, oldest first, and says when it truncated', async () => {
    tx.queue(
      { rows: [{ pipeline_id: PIPE }, { pipeline_id: 'pipe-2' }] } as never,
      { rows: [{ id: PIPE, org_id: ORG, props: {} }] } as never,
      { rows: [{ pipeline_id: PIPE, stage_name: 'Build', step_name: 'scan', resolved_version: '1.0.0', resolved_digest: DIGEST, root_org_id: 'root' }] } as never,
    );
    const { pipelines, truncated } = await declaredPipelinesForPlugin({ pluginName: 'trivy', publisher: 'acme' }, 1);
    expect(truncated).toBe(true);
    expect(pipelines).toEqual([expect.objectContaining({ pipelineId: PIPE, rootOrgId: 'root' })]);
    expect(pipelines[0]!.current.get('Build\u0000scan')).toEqual({ resolvedVersion: '1.0.0', resolvedDigest: DIGEST });
    expect(renderSql(tx.of('execute')[0].arg('execute'))).toContain('p.deleted_at IS NULL');
  });

  it('matches an org plugin within the org and its teams', async () => {
    tx.queue({ rows: [] } as never);
    expect(await declaredPipelinesForPlugin({ pluginName: 'lint', orgId: ORG }, 10)).toEqual({ pipelines: [], truncated: false });
    expect(renderSql(tx.of('execute')[0].arg('execute'))).toContain('root_org_id');
  });
});

describe('findVersionReferences', () => {
  it('unions declared (live), deployed (deleted pipelines too) and open deployed exposures, by digest', async () => {
    tx.queue({
      rows: [
        { pipeline_id: PIPE, org_id: ORG, source: 'declared', pipeline_name: 'web', deleted: false, steps: ['Build/scan'] },
        { pipeline_id: PIPE, org_id: ORG, source: 'deployed', pipeline_name: 'web', deleted: false, steps: ['Build/scan'] },
        { pipeline_id: 'pipe-old', org_id: 'team', source: 'deployed', pipeline_name: null, deleted: true, steps: null },
      ],
    } as never);
    const refs = await findVersionReferences({ pluginName: 'trivy', pluginVersion: '1.0.0', imageDigest: DIGEST, ownerOrgId: ORG });
    const text = renderSql(tx.of('execute')[0].arg('execute'));
    expect(text).toContain('r.resolved_digest =');
    expect(text).toContain('m.image_digest =');
    expect(text).toContain("e.source = 'deployed'");
    expect(distinctPipelines(refs)).toEqual([
      expect.objectContaining({ pipelineId: PIPE, sources: ['declared', 'deployed'] }),
      expect.objectContaining({ pipelineId: 'pipe-old', pipelineDeleted: true, steps: [] }),
    ]);
  });

  it('matches an image-less version by name + version within the owner org, or a listing by publisher', async () => {
    tx.queue({ rows: [] } as never, { rows: [] } as never);
    await findVersionReferences({ pluginName: 'lint', pluginVersion: '1.0.0', ownerOrgId: ORG });
    await findVersionReferences({ pluginName: 'lint', pluginVersion: '1.0.0', publisher: 'acme' });
    expect(renderSql(tx.of('execute')[0].arg('execute'))).toContain('r.plugin_publisher IS NULL');
    expect(renderSql(tx.of('execute')[1].arg('execute'))).toContain('m.plugin_publisher =');
  });

  it('builds the purge predicate and the namespace in-use set', async () => {
    const pred = renderSql(versionReferencedPredicate({ digest: sql`d`, name: sql`n`, version: sql`v`, orgId: sql`o` }));
    expect(pred).toContain('pipeline_step_manifests');
    expect(pred).toContain('plugin_vuln_exposure');
    tx.queue({ rows: [{ d: DIGEST }] } as never);
    expect(await orgImageDigestsInUse('ACME')).toEqual([DIGEST]);
  });
});

describe('exposure reads and acceptances', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    orgId: ORG,
    pipelineId: PIPE,
    pluginPublisher: null,
    pluginName: 'trivy',
    pluginVersion: '1.0.0',
    imageDigest: DIGEST,
    source: 'declared',
    criticalCount: 1,
    highCount: 0,
    topFindings: [],
    findingKeys: ['k1'],
    triageState: 'accepted',
    acceptedUntil: LATER,
    acceptedFindingKeys: ['k1'],
    acceptedKev: false,
    triageReason: 'r',
    triagedBy: 'u1',
    triagedAt: NOW,
    flaggedAt: NOW,
    fixedAt: null,
    ...over,
  });

  it('reads an acceptance in force as active, and a lapsed one as open', async () => {
    tx.queue([row(), row({ id: 'e2', acceptedUntil: new Date('2026-10-01T00:00:00Z') })]);
    const rows = await pipelineExposures(ORG, PIPE, { now: NOW });
    expect(rows.map((r) => [r.id, r.triageState, r.acceptanceActive])).toEqual([['e1', 'accepted', true], ['e2', 'open', false]]);
    tx.queue([]);
    expect(await exposureById(ORG, 'nope', NOW)).toBeNull();
  });

  it('merges a pipeline\'s active acceptances per version + image (KEV only when every row accepted it)', async () => {
    tx.queue([
      { id: 'e1', pluginName: 'trivy', pluginVersion: '1.0.0', imageDigest: DIGEST, acceptedUntil: LATER, acceptedFindingKeys: ['k1'], acceptedKev: true },
      { id: 'e2', pluginName: 'trivy', pluginVersion: '1.0.0', imageDigest: DIGEST, acceptedUntil: LATER, acceptedFindingKeys: ['k2'], acceptedKev: false },
    ]);
    const a = await activeAcceptances(ORG, PIPE, NOW);
    expect(a.byKey.get(acceptanceKey('trivy', '1.0.0', DIGEST))).toMatchObject({ findingKeys: ['k1', 'k2'], kev: false, exposureIds: ['e1', 'e2'] });
    expect([...a.versionsByPlugin.get('trivy')!]).toEqual(['1.0.0']);
  });

  it('treats an unreadable acceptance set as none (the louder answer)', async () => {
    tx.queueError(new Error('db down'));
    expect((await activeAcceptances(ORG, PIPE, NOW)).byKey.size).toBe(0);
  });

  it('reopens lapsed acceptances and returns them for N33; never throws', async () => {
    tx.queue([{ id: 'e1', orgId: ORG, pipelineId: PIPE }]);
    expect(await reopenLapsedAcceptances(NOW)).toEqual([{ id: 'e1', orgId: ORG, pipelineId: PIPE }]);
    expect(tx.of('update')[0].arg('set')).toMatchObject({ triageState: 'open' });
    tx.queueError(new Error('db down'));
    expect(await reopenLapsedAcceptances(NOW)).toEqual([]);
  });

  it('closes a removed pipeline\'s exposures as removed (one source when asked), keeping the triage', async () => {
    tx.queue([{ id: 'e1' }, { id: 'e2' }]);
    expect(await closePipelineExposures(PIPE, 'removed', { source: 'deployed' }, NOW)).toBe(2);
    const set = tx.of('update')[0].arg('set') as Record<string, unknown>;
    expect(set).toMatchObject({ triageState: 'removed', fixedAt: NOW });
    expect(set).not.toHaveProperty('acceptedUntil');
  });
});
