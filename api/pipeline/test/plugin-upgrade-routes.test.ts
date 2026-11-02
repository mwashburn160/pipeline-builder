// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/plugin-upgrade-routes — the preview (writes nothing, reports
 * which versions the apply would release) and the apply (each pipeline through
 * the normal write path: contracts, compliance, resolution, audit, optional
 * redeploy).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockFindById = jest.fn<AnyFn>();
const mockUpdate = jest.fn<AnyFn>();
const mockPreview = jest.fn<AnyFn>();
const mockApply = jest.fn<AnyFn>();
const mockValidate = jest.fn<AnyFn>();
const mockCompliance = jest.fn<AnyFn>();
const mockRecordResolution = jest.fn<AnyFn>();
const mockTrigger = jest.fn<AnyFn>();
const mockPipelinesOnVersion = jest.fn<AnyFn>();
const mockRecordAudit = jest.fn<AnyFn>();
const mockVisibility = jest.fn<AnyFn>(() => 'ok');

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: any) => async (req: any, res: any) => {
    const ctx = { log: jest.fn<AnyFn>(), identity: { orgId: 'acme' }, requestId: 'req-1' };
    await handler({ req, res, ctx, orgId: 'acme', userId: 'user-1' });
  },
  createAuthenticatedWithOrgRoute: () => [],
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  getParam: (params: Record<string, string>, key: string) => params[key],
  checkVisibilityWriteAccess: (...a: unknown[]) => mockVisibility(...a),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  pipelinesOnVersion: (...a: unknown[]) => mockPipelinesOnVersion(...a),
}));
jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: { findById: (...a: unknown[]) => mockFindById(...a), update: (...a: unknown[]) => mockUpdate(...a) },
}));
jest.unstable_mockModule('../src/services/pipeline-execution-service.js', () => ({
  pipelineExecutionService: { triggerExecution: (...a: unknown[]) => mockTrigger(...a) },
}));
jest.unstable_mockModule('../src/helpers/plugin-upgrades.js', () => ({
  previewPluginUpgrades: (...a: unknown[]) => mockPreview(...a),
  applyPluginUpgrades: (...a: unknown[]) => mockApply(...a),
}));
jest.unstable_mockModule('../src/helpers/pipeline-write.js', () => ({
  validatePipelineWrite: (...a: unknown[]) => mockValidate(...a),
  complianceBlockedDetails: (v: Array<{ ruleId: string }>) => ({ blockedBy: 'compliance', ruleIds: v.map((x) => x.ruleId) }),
}));
jest.unstable_mockModule('../src/helpers/pipeline-update-compliance.js', () => ({ checkPipelineUpdateCompliance: (...a: unknown[]) => mockCompliance(...a) }));
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({ recordPipelineResolution: (...a: unknown[]) => mockRecordResolution(...a) }));

const { createPluginUpgradeRoutes } = await import('../src/routes/plugin-upgrade-routes.js');

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';

const router = createPluginUpgradeRoutes() as any;
const handler = (path: string) => {
  const stack = router.stack.find((l: any) => l.route?.path === path).route.stack;
  return stack[stack.length - 1].handle;
};
const res = () => {
  const r: any = { status: jest.fn<AnyFn>(), json: jest.fn<AnyFn>() };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
};
const dataOf = (r: any) => r.json.mock.calls[0][0].data;

const upgrade = {
  stepKey: 'Build/trivy',
  plugin: 'trivy',
  publisher: null,
  currentVersion: '1.2.0',
  apply: { version: '1.4.0', widenVersion: '2.1.0' },
};
const applied = [{ stepKey: 'Build/trivy', plugin: 'trivy', publisher: null, fromVersion: '1.2.0', toVersion: '1.4.0' }];

beforeEach(() => {
  jest.clearAllMocks();
  mockVisibility.mockReturnValue('ok');
  mockFindById.mockImplementation(async (id: string) => ({ id, orgId: 'acme', pipelineName: `pipe-${id.slice(0, 1)}`, props: { stages: [] } }));
  mockPreview.mockResolvedValue([upgrade]);
  mockApply.mockReturnValue({ props: { stages: ['new'] }, applied });
  mockValidate.mockResolvedValue({ rejection: null, pluginWarnings: [] });
  mockCompliance.mockResolvedValue({ status: 'ok' });
  mockUpdate.mockImplementation(async (id: string, data: any) => ({ id, pipelineName: 'p', props: data.props }));
  mockPipelinesOnVersion.mockResolvedValue([]);
});

describe('POST /:id/plugin-upgrades/preview', () => {
  const preview = handler('/:id/plugin-upgrades/preview');

  it('lists the upgrades and which versions the apply releases (this pipeline\'s own declaration excluded)', async () => {
    mockPipelinesOnVersion.mockResolvedValueOnce([
      { pipelineId: P1, source: 'declared' },
      { pipelineId: P2, source: 'declared' },
      { pipelineId: P3, source: 'deployed' },
    ]);
    const r = res();
    await preview({ params: { id: P1 }, query: {}, user: {} }, r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(dataOf(r)).toEqual({
      pipelineId: P1,
      upgrades: [upgrade],
      releases: [{ plugin: 'trivy', publisher: null, version: '1.2.0', references: { declared: 1, deployed: 1 }, removable: false }],
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('honours ?widen and 404s an unknown pipeline', async () => {
    mockPreview.mockResolvedValueOnce([{ ...upgrade, apply: { version: null, widenVersion: '2.1.0' } }]);
    const narrow = res();
    await preview({ params: { id: P1 }, query: {}, user: {} }, narrow);
    expect(dataOf(narrow).releases).toEqual([]);

    mockPreview.mockResolvedValueOnce([{ ...upgrade, apply: { version: null, widenVersion: '2.1.0' } }]);
    const wide = res();
    await preview({ params: { id: P1 }, query: { widen: 'true' }, user: {} }, wide);
    expect(dataOf(wide).releases).toEqual([expect.objectContaining({ version: '1.2.0', removable: true })]);

    mockFindById.mockResolvedValueOnce(null);
    const missing = res();
    await preview({ params: { id: P9() }, query: {}, user: {} }, missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });
});

function P9() { return '99999999-9999-4999-8999-999999999999'; }

describe('POST /plugin-upgrades/apply', () => {
  const apply = handler('/plugin-upgrades/apply');

  it('upgrades each pipeline through the write path, records its resolution, audits it and reports redeployRequired', async () => {
    mockValidate.mockResolvedValueOnce({ rejection: null, pluginWarnings: [{ stepKey: 'Build/trivy', code: 'UNSCANNED', severity: 'warning' }] });
    const r = res();
    await apply({ body: { pipelineIds: [P1, P1] }, user: { parentOrganizationId: 'root' } }, r);
    const data = dataOf(r);
    expect(data.upgraded).toBe(1);
    expect(data.redeployRequired).toBe(true);
    expect(data.results).toEqual([expect.objectContaining({ pipelineId: P1, status: 'upgraded', applied, pluginWarnings: [expect.objectContaining({ code: 'UNSCANNED' })] })]);
    // The pipeline's id reaches the save check, so its risk acceptances apply.
    expect(mockValidate).toHaveBeenCalledWith({ props: { stages: ['new'] } }, 'acme', 'root', P1);
    expect(mockRecordResolution).toHaveBeenCalledWith(P1, 'acme', 'root', { stages: ['new'] });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline.plugin.upgraded', targetId: P1, details: expect.objectContaining({ batchId: expect.any(String) }) }));
    expect(data.releases).toEqual([expect.objectContaining({ version: '1.2.0', removable: true })]);
  });

  it('reports each refusal per pipeline and leaves the others to land', async () => {
    mockFindById.mockImplementation(async (id: string) => (id === P3 ? null : { id, orgId: 'acme', props: {} }));
    mockValidate.mockImplementation(async (_b: unknown, _o: unknown, _p: unknown, id: string) => (id === P1
      ? { rejection: { message: 'contract violated' } } : { rejection: null, pluginWarnings: [] }));
    mockCompliance.mockResolvedValueOnce({ status: 'blocked', violations: [{ ruleId: 'r-latest', message: 'no latest' }] });
    const r = res();
    await apply({ body: { pipelineIds: [P1, P2, P3] }, user: {} }, r);
    expect(dataOf(r).results).toEqual([
      { pipelineId: P1, status: 'failed', error: 'contract violated' },
      { pipelineId: P2, status: 'failed', error: 'Compliance blocked: no latest' },
      { pipelineId: P3, status: 'failed', error: 'Pipeline not found' },
    ]);
    expect(dataOf(r).upgraded).toBe(0);
    expect(dataOf(r).redeployRequired).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
    // The compliance refusal is audited as a failure naming the rule.
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pipeline.plugin.upgraded',
      targetId: P2,
      outcome: 'failure',
      details: expect.objectContaining({ blockedBy: 'compliance', ruleIds: ['r-latest'] }),
    }));
  });

  it('fails closed on a compliance outage, refuses a pipeline the caller cannot modify, and skips an unchanged one', async () => {
    mockCompliance.mockResolvedValueOnce({ status: 'unavailable' });
    mockVisibility.mockImplementation((_r: unknown, existing: any) => (existing.id === P2 ? 'forbidden' : 'ok'));
    mockApply.mockImplementation((props: any) => (props.unchanged ? { props, applied: [] } : { props: { stages: ['new'] }, applied }));
    mockFindById.mockImplementation(async (id: string) => ({ id, orgId: 'acme', props: id === P3 ? { unchanged: true } : {} }));
    const r = res();
    await apply({ body: { pipelineIds: [P1, P2, P3] }, user: {} }, r);
    expect(dataOf(r).results).toEqual([
      { pipelineId: P1, status: 'failed', error: 'Compliance service unavailable — pipeline update rejected' },
      { pipelineId: P2, status: 'failed', error: 'You cannot modify this pipeline' },
      { pipelineId: P3, status: 'unchanged' },
    ]);
  });

  it('redeploys each upgraded pipeline when asked, reporting a trigger failure per pipeline', async () => {
    mockTrigger.mockResolvedValueOnce({ executionId: 'ex-1' }).mockRejectedValueOnce(new Error('not registered'));
    const r = res();
    await apply({ body: { pipelineIds: [P1, P2], redeploy: true }, user: {} }, r);
    const data = dataOf(r);
    expect(data.redeployRequired).toBe(false);
    expect(data.results.map((x: any) => x.redeploy)).toEqual([{ executionId: 'ex-1' }, { error: 'not registered' }]);
    const events = mockRecordAudit.mock.calls.map((c) => c[0] as { action: string; targetType?: string; targetId?: string; outcome?: string; details: { batchId?: string } });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'pipeline.execution.start', targetType: 'pipeline_execution', targetId: 'ex-1', details: expect.objectContaining({ pipelineId: P1, reason: 'plugin-upgrade' }) }),
      expect.objectContaining({ action: 'pipeline.execution.start', outcome: 'failure', details: expect.objectContaining({ pipelineId: P2, reason: 'plugin-upgrade' }) }),
    ]));
    // Every event of one apply shares a single batchId.
    expect(new Set(events.map((e) => e.details.batchId)).size).toBe(1);
  });

  it('400s an invalid body and reports an unexpected error per pipeline', async () => {
    const bad = res();
    await apply({ body: { pipelineIds: ['not-a-uuid'] }, user: {} }, bad);
    expect(bad.status).toHaveBeenCalledWith(400);

    mockUpdate.mockRejectedValueOnce(new Error('db down'));
    const r = res();
    await apply({ body: { pipelineIds: [P1] }, user: {} }, r);
    expect(dataOf(r).results).toEqual([{ pipelineId: P1, status: 'failed', error: 'db down' }]);
  });
});
