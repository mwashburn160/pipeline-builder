// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin security fixes election (`remediationUpgrades`) on the CREATE path
 * — `pipeline create` / `create --upsert` from a definition — against a REAL
 * Postgres (PGlite + the shipped init script, as the app role under RLS):
 *
 * - a create that carries it stores it; one that omits it gets `inherit`;
 * - an upsert that carries it updates the stored value;
 * - an upsert that OMITS it keeps the stored value (e.g. set in the dashboard),
 *   never resetting it to inherit;
 * - `apply` is refused when the root org forbids pipelines choosing it, unless
 *   the stored value already is `apply` (not a change);
 * - pipeline.remediation-upgrades.update is audited with before / after only
 *   when the value actually changed.
 *
 * Compliance and the plugin-resolution record are stubbed (their own suites);
 * the slot read, the settings read and the upsert are real SQL.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({
  recordPipelineResolution: jest.fn(), resolveContractPlugin: jest.fn(), checkPluginContracts: jest.fn(), formatContractViolations: jest.fn(),
}));

const { createOnePipeline, createElectionRefusal, preparePipelineCreate } = await import('../src/helpers/pipeline-write.js');
const { runWithTenantContext } = await import('@pipeline-builder/pipeline-data');

process.env.JWT_SECRET ||= 'create-remediation-election-test-secret';

let tdb: TenantTestDb;
type PGlite = TenantTestDb['pglite'];
const owner = <T>(fn: (q: PGlite) => Promise<T>) => tdb.asOwner(fn);

const ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER = 'user-1';
const props = { project: 'shop', organization: 'acme', synth: { plugin: { name: 'cdk-synth' } } };

/** A request as the create route sees it: an org member with pipelines:write. */
const req = () => ({
  headers: {},
  query: {},
  user: { sub: USER, organizationId: ROOT, permissions: ['pipelines:write'], role: 'admin' },
  context: { identity: { orgId: ROOT, userId: USER } },
}) as never;

/** The create path's election check then the write, as POST /pipelines runs them (under the caller's tenant). */
async function create(body: Record<string, unknown>, upsert = false) {
  const full = { project: 'shop', organization: 'acme', props, ...body } as never;
  return runWithTenantContext({ orgId: ROOT, isSuperAdmin: false }, async () => {
    const prepared = preparePipelineCreate(req(), full);
    if ('error' in prepared) throw new Error(prepared.error);
    const refusal = await createElectionRefusal(full, prepared, ROOT, null);
    if (refusal) return { refusal };
    return { outcome: await createOnePipeline(req(), full, prepared, { orgId: ROOT, userId: USER, serviceAuth: 'Bearer s', upsert }) };
  });
}

const stored = async () => (await owner((q) => q.query<{ remediation_upgrades: string }>(
  'SELECT remediation_upgrades FROM pipelines WHERE project = \'shop\' AND organization = \'acme\'',
))).rows[0]?.remediation_upgrades;

const electionAudits = () => mockAudit.mock.calls.map((c) => c[0] as { action: string; details: Record<string, unknown> })
  .filter((e) => e.action === 'pipeline.remediation-upgrades.update');

async function forbidApply() {
  await owner((q) => q.query(
    'INSERT INTO plugin_remediation_settings (org_id, rollout, allow_pipeline_apply) VALUES ($1, \'propose\', false)',
    [ROOT],
  ));
}

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await owner((q) => q.exec('DELETE FROM plugin_remediation_settings; DELETE FROM pipelines;'));
  jest.clearAllMocks();
});

describe('create', () => {
  it('stores the election a definition carries, and audits inherit → it', async () => {
    const { outcome } = await create({ remediationUpgrades: 'off' });
    expect(outcome).toMatchObject({ status: 'saved', inserted: true, pipeline: { remediationUpgrades: 'off' } });
    expect(await stored()).toBe('off');
    expect(electionAudits()).toEqual([expect.objectContaining({
      details: expect.objectContaining({ before: 'inherit', after: 'off' }),
    })]);
  });

  it('a definition without it gets inherit, and no election audit', async () => {
    await create({});
    expect(await stored()).toBe('inherit');
    expect(electionAudits()).toEqual([]);
  });
});

describe('create --upsert (each deploy of a definition)', () => {
  it('updates the stored election when the definition carries a different one', async () => {
    await create({ remediationUpgrades: 'propose' });
    mockAudit.mockClear();
    const { outcome } = await create({ remediationUpgrades: 'off' }, true);
    expect(outcome).toMatchObject({ status: 'saved', inserted: false });
    expect(await stored()).toBe('off');
    expect(electionAudits()).toEqual([expect.objectContaining({
      targetType: 'pipeline',
      details: expect.objectContaining({ before: 'propose', after: 'off' }),
    })]);
  });

  it('keeps a dashboard-set election when the definition omits it — never resets it to inherit', async () => {
    await create({});
    await owner((q) => q.query('UPDATE pipelines SET remediation_upgrades = \'off\''));
    mockAudit.mockClear();
    const { outcome } = await create({ description: 'redeploy' }, true);
    expect(outcome).toMatchObject({ status: 'saved', inserted: false, pipeline: { remediationUpgrades: 'off' } });
    expect(await stored()).toBe('off');
    expect(electionAudits()).toEqual([]);
  });

  it('does not audit when the definition re-sends the stored value', async () => {
    await create({ remediationUpgrades: 'off' });
    mockAudit.mockClear();
    await create({ remediationUpgrades: 'off' }, true);
    expect(electionAudits()).toEqual([]);
  });
});

describe('apply when the org forbids pipelines choosing it', () => {
  it('refuses a create electing apply, and writes nothing', async () => {
    await forbidApply();
    const { refusal, outcome } = await create({ remediationUpgrades: 'apply' });
    expect(outcome).toBeUndefined();
    expect(refusal).toMatchObject({ status: 403, code: 'PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED', message: expect.stringMatching(/does not allow pipelines to choose Apply/) });
    expect(await stored()).toBeUndefined();
  });

  it('refuses an upsert moving a pipeline to apply, keeping the stored value', async () => {
    await create({ remediationUpgrades: 'propose' });
    await forbidApply();
    const { refusal } = await create({ remediationUpgrades: 'apply' }, true);
    expect(refusal).toMatchObject({ code: 'PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED' });
    expect(await stored()).toBe('propose');
  });

  it('lets an upsert re-send apply when the pipeline already is on apply (not a change)', async () => {
    await create({ remediationUpgrades: 'apply' });
    await forbidApply();
    const { refusal, outcome } = await create({ remediationUpgrades: 'apply' }, true);
    expect(refusal).toBeUndefined();
    expect(outcome).toMatchObject({ status: 'saved' });
  });

  it('never refuses opting out', async () => {
    await forbidApply();
    const { refusal } = await create({ remediationUpgrades: 'off' });
    expect(refusal).toBeUndefined();
    expect(await stored()).toBe('off');
  });
});
