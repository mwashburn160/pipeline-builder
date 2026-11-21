// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A rollout start from the plugin service's internal call carries NO tenant
 * scope. The engine's own SQL runs as the system, but the step plan
 * (`planMove` → `resolveContractPlugin` → `withTenantTx`) ran unscoped — so in
 * production (strict tenant mode) every start threw "withTenantTx called
 * outside a tenant scope" and the internal route answered 500. Real Postgres,
 * strict mode, the REAL plan and contract resolver.
 */

import { randomUUID } from 'node:crypto';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.RLS_CONTEXT_MODE = 'strict';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: jest.fn() }));

const { createRolloutEngine, realRolloutDeps, loadRows } = await import('../src/helpers/remediation-rollout.js');
type RolloutDeps = import('../src/helpers/remediation-rollout.js').RolloutDeps;
const { readOrgRolloutSettings } = await import('../src/helpers/remediation-settings.js');
const { getTenantContext } = await import('@pipeline-builder/pipeline-data');

let tdb: TenantTestDb;
const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa9';

const deps: RolloutDeps = {
  ...realRolloutDeps(),
  now: () => new Date('2026-11-20T12:00:00Z'),
  settings: (orgId, rootOrgId) => readOrgRolloutSettings(orgId, rootOrgId),
  requestInstallChange: async () => {},
  report: async () => 'ok',
  ancestors: async () => [],
};

beforeAll(async () => { tdb = await bootTenantDb(); }, 120_000);
afterAll(async () => { delete process.env.RLS_CONTEXT_MODE; await tdb?.close(); });

describe('rollout start without a tenant scope (the internal start call)', () => {
  it('plans every candidate pipeline and writes its rows', async () => {
    const pipelineId = randomUUID();
    const props = { stages: [{ stageName: 'Build', steps: [{ name: 'trivy', plugin: { name: 'trivy', filter: { version: '1.4.2' } } }] }] };
    await tdb.asOwner(async (q) => {
      await q.query("INSERT INTO plugins (org_id, name, version, visibility) VALUES ($1, 'trivy', '1.4.2', 'private')", [ORG]);
      await q.query(
        `INSERT INTO pipelines (id, project, organization, org_id, pipeline_name, props, remediation_upgrades)
         VALUES ($1, 'proj', 'acme', $2, 'pipe', $3::jsonb, 'inherit')`, [pipelineId, ORG, JSON.stringify(props)]);
      await q.query(
        `INSERT INTO pipeline_plugin_resolution (org_id, pipeline_id, stage_name, step_name, plugin_name, declared_version, resolved_version)
         VALUES ($1, $2, 'Build', 'trivy', 'trivy', '1.4.2', '1.4.2')`, [ORG, pipelineId]);
    });
    const rem = randomUUID();
    expect(getTenantContext()).toBeUndefined();
    const out = await createRolloutEngine(deps).start(rem, { orgId: ORG, plugin: 'trivy', publisher: null, fromVersion: '1.4.2', toVersion: '1.4.3', toPluginId: randomUUID(), advisoryIds: ['CVE-2026-0001'], criticalCleared: 1, highCleared: 0, kev: false });
    expect(out.created).toBe(true);
    // The real plan resolved the exact pin on the flagged version: a proposal (the default rollout).
    expect((await loadRows(rem)).map((r) => ({ pipelineId: r.pipelineId, state: r.state }))).toEqual([{ pipelineId, state: 'proposed' }]);
  });
});
