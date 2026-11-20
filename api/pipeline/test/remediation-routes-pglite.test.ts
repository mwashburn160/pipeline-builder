// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The routes of nightly CVE remediation Stage 3, over a REAL Postgres (PGlite +
 * the shipped init script, as the app role under RLS):
 *
 *  - the internal start / cancel (plugin → pipeline): contract validation and
 *    hand-off to the rollout engine;
 *  - the pipeline page's GET (election, effective mode, rows with the CVEs the
 *    fix clears), apply (a `proposed` row through the engine, as the user) and
 *    dismiss (`proposed` → `dismissed`, once);
 *  - the opted-out list filter (`remediationUpgrades` column condition).
 */

import { randomUUID } from 'node:crypto';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { routeHandler, stubModule } from '@pipeline-builder/api-core/testing';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindById = jest.fn<AnyFn>();
const mockVisibility = jest.fn<AnyFn>(() => true);
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: req.orgId }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: req.orgId, userId: 'user-1' });
  },
  createAuthenticatedWithOrgRoute: () => [],
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, string>, key: string) => params[key],
  requireVisibilityWriteAccess: (...a: unknown[]) => mockVisibility(...a),
}));
jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: { findById: (...a: unknown[]) => mockFindById(...a) },
}));
jest.unstable_mockModule('../src/helpers/plugin-upgrade-apply.js', () => ({ applyUpgradeToPipeline: jest.fn(), redeployPipeline: jest.fn() }));
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({ recordPipelineResolution: jest.fn(), resolveContractPlugin: jest.fn() }));

const { createInternalRemediationRoutes } = await import('../src/routes/internal-remediation-routes.js');
const { createRemediationUpgradeRoutes } = await import('../src/routes/remediation-upgrade-routes.js');
const { loadRows } = await import('../src/helpers/remediation-rollout.js');

process.env.JWT_SECRET ||= 'remediation-routes-test-secret';

let tdb: TenantTestDb;
type PGlite = TenantTestDb['pglite'];
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'cccccccccccccccccccccccc';

const engine = {
  start: jest.fn<AnyFn>(),
  cancel: jest.fn<AnyFn>(),
  applyProposal: jest.fn<AnyFn>(),
};
const internal = createInternalRemediationRoutes(() => engine as never);
const page = createRemediationUpgradeRoutes(() => engine as never);

function makeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(n: number) { res.statusCode = n; return res; },
    json(b: unknown) { res.body = b; return res; },
    setHeader() { /* irrelevant */ },
  };
  return res;
}
const call = async (router: unknown, method: string, path: string, req: Record<string, unknown>) => {
  const res = makeRes();
  await routeHandler(router, method, path)({ headers: {}, query: {}, body: {}, user: {}, ...req }, res);
  return res;
};

async function seedPipeline(orgId: string, election = 'inherit'): Promise<{ id: string; orgId: string; pipelineName: string; props: object; remediationUpgrades: string }> {
  const id = randomUUID();
  await owner((q) => q.query(
    `INSERT INTO pipelines (id, project, organization, org_id, pipeline_name, props, remediation_upgrades, visibility)
     VALUES ($1, $2, 'acme', $3, 'pipe', '{}'::jsonb, $4, 'org')`,
    [id, `proj-${id.slice(0, 8)}`, orgId, election],
  ));
  return { id, orgId, pipelineName: 'pipe', props: {}, remediationUpgrades: election };
}

async function seedRemediation(orgId: string): Promise<string> {
  return owner(async (q) => {
    const plugin = await q.query<{ id: string }>('INSERT INTO plugins (org_id, name, version) VALUES ($1, \'trivy\', \'1.4.2\') RETURNING id', [orgId]);
    const rem = await q.query<{ id: string }>(
      `INSERT INTO plugin_remediations (org_id, plugin_id, plugin_name, from_version, findings_hash, stage, created_by, targeted, cleared)
       VALUES ($1, $2, 'trivy', '1.4.2', $3, 'rolling_out', 'system:plugin-remediation', $4::jsonb, $5::jsonb) RETURNING id`,
      [orgId, plugin.rows[0]!.id, 'a'.repeat(64),
        JSON.stringify([{ id: 'CVE-1', severity: 'critical', kev: true }, { id: 'CVE-2', severity: 'high' }, { id: 'CVE-3', severity: 'high' }]),
        JSON.stringify([{ id: 'CVE-1' }, { id: 'CVE-2' }])],
    );
    return rem.rows[0]!.id;
  });
}

async function seedUpgrade(pipeline: { id: string; orgId: string }, remediationId: string, state = 'proposed'): Promise<string> {
  const res = await owner((q) => q.query<{ id: string }>(
    `INSERT INTO pipeline_remediation_upgrades (org_id, remediation_id, pipeline_id, plugin_name, from_version, to_version, mode, state)
     VALUES ($1, $2, $3, 'trivy', '1.4.2', '1.4.3', 'propose', $4) RETURNING id`,
    [pipeline.orgId, remediationId, pipeline.id, state],
  ));
  return res.rows[0]!.id;
}

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await owner((q) => q.exec(`DELETE FROM pipeline_remediation_upgrades; DELETE FROM plugin_remediations; DELETE FROM plugins WHERE name = 'trivy';
    DELETE FROM plugin_remediation_settings; DELETE FROM pipelines;`));
  jest.clearAllMocks();
  mockVisibility.mockReturnValue(true);
});

describe('internal start / cancel', () => {
  const REM = '00000000-0000-4000-8000-0000000000A1';
  const body = {
    orgId: ORG.toUpperCase(),
    plugin: 'trivy',
    publisher: null,
    fromVersion: '1.4.2',
    toVersion: '1.4.3',
    toPluginId: randomUUID(),
    advisoryIds: ['CVE-1'],
    criticalCleared: 1,
    highCleared: 0,
    kev: false,
  };

  it('validates the body against the contract and hands a lower-cased id to the engine', async () => {
    engine.start.mockResolvedValueOnce({ remediationId: REM.toLowerCase(), created: true, orgDefault: 'propose', counts: {} });
    const ok = await call(internal, 'post', '/plugin-remediations/:remediationId/rollout', { params: { remediationId: REM }, body });
    expect(ok.statusCode).toBe(200);
    expect(engine.start).toHaveBeenCalledWith(REM.toLowerCase(), expect.objectContaining({ orgId: ORG, toVersion: '1.4.3' }));

    const bad = await call(internal, 'post', '/plugin-remediations/:remediationId/rollout', { params: { remediationId: REM }, body: { ...body, extra: 1 } });
    expect(bad.statusCode).toBe(400);
    const badId = await call(internal, 'post', '/plugin-remediations/:remediationId/rollout', { params: { remediationId: 'nope' }, body });
    expect(badId.statusCode).toBe(400);
    expect(engine.start).toHaveBeenCalledTimes(1);
  });

  it('answers 500 (the caller retries) when the engine fails, without its error text', async () => {
    engine.start.mockRejectedValueOnce(new Error('connection refused at 10.0.0.1'));
    const res = await call(internal, 'post', '/plugin-remediations/:remediationId/rollout', { params: { remediationId: REM }, body });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.1');
  });

  it('cancels idempotently', async () => {
    engine.cancel.mockResolvedValueOnce(false);
    const res = await call(internal, 'post', '/plugin-remediations/:remediationId/cancel', { params: { remediationId: REM }, body: { reason: 'name_deleted' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ remediationId: REM.toLowerCase(), cancelled: false });
    const bad = await call(internal, 'post', '/plugin-remediations/:remediationId/cancel', { params: { remediationId: REM }, body: { reason: 'because' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('the pipeline page', () => {
  it('GET answers the election, the effective mode and each row with the CVEs its fix clears', async () => {
    await owner((q) => q.query('INSERT INTO plugin_remediation_settings (org_id, rollout, allow_pipeline_apply) VALUES ($1, \'apply\', false)', [ORG]));
    const p = await seedPipeline(ORG, 'propose');
    mockFindById.mockResolvedValue(p);
    const rem = await seedRemediation(ORG);
    await seedUpgrade(p, rem);
    const res = await call(page, 'get', '/:id/remediation-upgrades', { params: { id: p.id }, orgId: ORG });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      enabled: true,
      election: 'propose',
      effective: { mode: 'propose', source: 'pipeline', orgDefault: 'apply' },
      orgDefault: 'apply',
      allowPipelineApply: false,
      upgrades: [{ remediationId: rem, state: 'proposed', toVersion: '1.4.3', advisories: { advisoryIds: ['CVE-1', 'CVE-2'], criticalCleared: 1, highCleared: 1, kev: true } }],
    });
  });

  it('GET reports the operator knob (only the literal false turns it off)', async () => {
    const p = await seedPipeline(ORG);
    mockFindById.mockResolvedValue(p);
    process.env.PLUGIN_REMEDIATION_ENABLED = 'false';
    try {
      const res = await call(page, 'get', '/:id/remediation-upgrades', { params: { id: p.id }, orgId: ORG });
      expect(res.body.data.enabled).toBe(false);
      process.env.PLUGIN_REMEDIATION_ENABLED = 'no';
      expect((await call(page, 'get', '/:id/remediation-upgrades', { params: { id: p.id }, orgId: ORG })).body.data.enabled).toBe(true);
    } finally {
      delete process.env.PLUGIN_REMEDIATION_ENABLED;
    }
  });

  it('GET 404s a pipeline the caller\'s org does not own', async () => {
    const p = await seedPipeline(OTHER);
    mockFindById.mockResolvedValue(p);
    const res = await call(page, 'get', '/:id/remediation-upgrades', { params: { id: p.id }, orgId: ORG });
    expect(res.statusCode).toBe(404);
  });

  it('apply moves a proposed row through the engine as the user; any other state is a 409', async () => {
    const p = await seedPipeline(ORG);
    mockFindById.mockResolvedValue(p);
    const rem = randomUUID();
    const proposed = await seedUpgrade(p, rem);
    engine.applyProposal.mockResolvedValueOnce({ ok: true, runRequestId: null });
    const ok = await call(page, 'post', '/:id/remediation-upgrades/:upgradeId/apply', { params: { id: p.id, upgradeId: proposed }, orgId: ORG });
    expect(ok.statusCode).toBe(200);
    expect(engine.applyProposal).toHaveBeenCalledWith(
      expect.objectContaining({ id: proposed, state: 'proposed' }), expect.objectContaining({ id: p.id }), { userId: 'user-1', requestedBy: 'user-1' }, null,
    );

    const queued = await seedUpgrade(p, randomUUID(), 'queued');
    const conflict = await call(page, 'post', '/:id/remediation-upgrades/:upgradeId/apply', { params: { id: p.id, upgradeId: queued }, orgId: ORG });
    expect(conflict.statusCode).toBe(409);
    expect(engine.applyProposal).toHaveBeenCalledTimes(1);
  });

  it('apply answers 409 with the reason when the move is refused (validation, compliance)', async () => {
    const p = await seedPipeline(ORG);
    mockFindById.mockResolvedValue(p);
    const id = await seedUpgrade(p, randomUUID());
    engine.applyProposal.mockResolvedValueOnce({ ok: false, error: 'Compliance blocked: rule r1' });
    const res = await call(page, 'post', '/:id/remediation-upgrades/:upgradeId/apply', { params: { id: p.id, upgradeId: id }, orgId: ORG });
    expect(res.statusCode).toBe(409);
    expect(res.body.message).toContain('Compliance blocked');
  });

  it('apply and dismiss honour the visibility ladder', async () => {
    const p = await seedPipeline(ORG);
    mockFindById.mockResolvedValue(p);
    const id = await seedUpgrade(p, randomUUID());
    mockVisibility.mockImplementation((_req: unknown, res: any) => { res.status(403).json({ message: 'no' }); return false; });
    expect((await call(page, 'post', '/:id/remediation-upgrades/:upgradeId/apply', { params: { id: p.id, upgradeId: id }, orgId: ORG })).statusCode).toBe(403);
    expect((await call(page, 'post', '/:id/remediation-upgrades/:upgradeId/dismiss', { params: { id: p.id, upgradeId: id }, orgId: ORG })).statusCode).toBe(403);
    expect((await loadRows((await owner((q) => q.query<{ remediation_id: string }>('SELECT remediation_id FROM pipeline_remediation_upgrades'))).rows[0]!.remediation_id))[0]!.state).toBe('proposed');
  });

  it('dismiss moves proposed → dismissed once', async () => {
    const p = await seedPipeline(ORG);
    mockFindById.mockResolvedValue(p);
    const rem = randomUUID();
    const id = await seedUpgrade(p, rem);
    const res = await call(page, 'post', '/:id/remediation-upgrades/:upgradeId/dismiss', { params: { id: p.id, upgradeId: id }, orgId: ORG });
    expect(res.statusCode).toBe(200);
    expect((await loadRows(rem))[0]!.state).toBe('dismissed');
    const again = await call(page, 'post', '/:id/remediation-upgrades/:upgradeId/dismiss', { params: { id: p.id, upgradeId: id }, orgId: ORG });
    expect(again.statusCode).toBe(409);
  });
});
