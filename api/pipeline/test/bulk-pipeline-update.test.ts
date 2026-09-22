// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// PUT /pipelines/bulk/update must isolate per-item failures. A single
// rejected update() (Promise.allSettled, not Promise.all) must NOT discard the
// rows that already committed nor surface a blanket 500; failures land in a
// per-index errors[] like bulk/create.

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const ID1 = '10000000-0000-4000-8000-000000000001';
const ID2 = '10000000-0000-4000-8000-000000000002';
const ID3 = '10000000-0000-4000-8000-000000000003';
const ID4 = '10000000-0000-4000-8000-000000000004';

const mockUpdate = jest.fn<(...a: any[]) => Promise<any>>();
const mockFindByIds = jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue([]);
const mockEmitAudit = jest.fn();
const mockValidatePipeline = jest.fn<(...a: any[]) => Promise<any>>();
const mockCreateAsDefault = jest.fn<(...a: any[]) => Promise<any>>();

// Plugin-contract check — resolves plugins through the DB; stubbed here
// and driven per test. The real formatter is exercised in plugin-contract-check.test.ts.
const mockFindContractViolations = jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([]);
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({
  findPluginContractViolations: (...args: unknown[]) => mockFindContractViolations(...args),
  formatContractViolations: (v: unknown[]) => `Pipeline does not meet the contract of ${v.length} plugin step(s)`,
}));

jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    update: mockUpdate,
    findByIds: mockFindByIds,
    createAsDefaultReportInserted: (...a: unknown[]) => mockCreateAsDefault(...a),
    bulkDelete: jest.fn(),
  },
}));


jest.unstable_mockModule('../src/helpers/pipeline-template-validator.js', () => ({
  validatePipelineTemplates: jest.fn(),
}));

const mockSendSuccess = jest.fn((res: any, statusCode: number, data?: any) => {
  res.status(statusCode).json({ success: true, statusCode, data });
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockEmitAudit,
  // Bulk update now shares single update's compliance re-check
  // (helpers/pipeline-update-compliance.ts, which builds its client from this).
  createComplianceClient: () => ({ validatePipeline: mockValidatePipeline }),
  validateBulkArray: (val: unknown) => ({ value: val }),
  PipelineCreateSchema: { safeParse: (d: any) => ({ success: true, data: d }) },
  PipelineUpdateSchema: { safeParse: (d: any) => ({ success: true, data: d }) },
  pickDefined: (obj: any) => {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
    return out;
  },
  resolveVisibility: (_req: any, am?: string) => am || 'private',
  isSystemAdmin: () => true,
  // Bulk routes now apply the full visibility ladder per row rather than a
  // `private`-only check, so they need the write predicate + publish perm.
  checkVisibilityWriteAccess: () => 'ok',
  userHasPermission: () => true,
  reserveQuota: jest.fn(),
  decrementQuota: jest.fn(),
  sendSuccess: mockSendSuccess,
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ success: false, message: msg })),
  sendError: jest.fn((res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg })),
}));

// The REAL reservation helper (its api-core calls hit this file's api-core mock).
let realWithQuotaReservation: (...a: any[]) => unknown;
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withQuotaReservation: (...a: any[]) => realWithQuotaReservation(...a),
  incCounter: () => undefined,
  checkQuota: () => (_req: any, _res: any, next: () => void) => next(),
  createAuthenticatedWithOrgRoute: () => [],
  withRoute: (handler: Function) => async (req: any, res: any) => {
    const ctx = { log: jest.fn(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx, orgId: 'test-org', userId: 'test-user' });
    } catch {
      // surface via res in real code; swallow here so the test sees the handler's own response
    }
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: { MAX_BULK_ITEMS: 100 },
  replaceNonAlphanumeric: (s: string, r: string) => s.replace(/[^a-zA-Z0-9]/g, r),
}));

({ withQuotaReservation: realWithQuotaReservation } = await import('@pipeline-builder/api-server/lib/api/quota-reservation.js'));
const { createBulkPipelineRoutes } = await import('../src/routes/bulk-pipeline.js');

const router = createBulkPipelineRoutes({ increment: jest.fn() } as any);

function getHandler(method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockReq(body: Record<string, unknown>): any {
  return { body, params: {}, query: {}, user: { sub: 'actor-1' }, headers: {} };
}

function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('PUT /pipelines/bulk/update — per-item isolation', () => {
  const handler = getHandler('put', '/bulk/update');

  beforeEach(() => {
    mockUpdate.mockReset();
    mockEmitAudit.mockReset();
    mockSendSuccess.mockClear();
  });

  it('commits the successful rows and reports the rejected one in errors[] (no 500)', async () => {
    // id-2 rejects; id-1 and id-3 succeed; id-4 returns null (no match).
    mockUpdate.mockImplementation(async (id: string) => {
      if (id === ID2) throw new Error('db conflict on row 2');
      if (id === ID4) return null;
      return { id };
    });

    const req = mockReq({ ids: [ID1, ID2, ID3, ID4], data: { description: 'x' } });
    const res = mockRes();
    await handler(req, res);

    // Every id was attempted — the rejection did not short-circuit the batch.
    expect(mockUpdate).toHaveBeenCalledTimes(4);

    // Response: 2 updated, 1 failed, error carries the offending index.
    expect(mockSendSuccess).toHaveBeenCalledTimes(1);
    const [, status, payload] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(200);
    expect(payload.updated).toBe(2);
    expect(payload.failed).toBe(1);
    expect(payload.errors).toEqual([{ index: 1, error: 'db conflict on row 2' }]);

    // Audit emitted only for the two rows that actually updated.
    expect(mockEmitAudit).toHaveBeenCalledTimes(2);
    const auditedIds = mockEmitAudit.mock.calls.map((c: any[]) => c[0].targetId).sort();
    expect(auditedIds).toEqual([ID1, ID3]);
  });

  it('reports all failures without throwing when every update rejects', async () => {
    mockUpdate.mockRejectedValue(new Error('boom'));

    const req = mockReq({ ids: [ID1, ID2], data: { description: 'x' } });
    const res = mockRes();
    await handler(req, res);

    expect(mockSendSuccess).toHaveBeenCalledTimes(1);
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.updated).toBe(0);
    expect(payload.failed).toBe(2);
    expect(payload.errors.map((e: any) => e.index)).toEqual([0, 1]);
    expect(mockEmitAudit).not.toHaveBeenCalled();
  });
});

// Free-form ids reach pipelineService.update(id), whose CRUD id filter PREFIX-
// matches a partial id (`LIKE 'x%'`) — so `ids: ['']` would update every pipeline
// in the org while the exact-id visibility check matched (and forbade) nothing.
describe('bulk pipeline ids must be full UUIDs', () => {
  beforeEach(() => { mockUpdate.mockReset(); mockFindByIds.mockClear(); });

  it.each([[['']], [['1000']], [[ID1, 'x']]])('PUT /bulk/update 400s ids=%j before any lookup or write', async (ids) => {
    const res = mockRes();
    await getHandler('put', '/bulk/update')(mockReq({ ids, data: { description: 'x' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockFindByIds).not.toHaveBeenCalled();
  });

  it('POST /bulk/delete 400s a non-UUID id', async () => {
    const res = mockRes();
    await getHandler('post', '/bulk/delete')(mockReq({ ids: [''] }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// Single PUT re-checks compliance (fail-closed) when props/visibility change;
// bulk update used to skip it, so a bulk edit could turn compliant pipelines
// non-compliant. The route + shared helper run for real; only the compliance
// transport and the DB service are stubbed.
describe('PUT /pipelines/bulk/update — compliance re-check (shared with single update)', () => {
  const handler = getHandler('put', '/bulk/update');
  const row = (id: string) => ({ id, project: 'p', organization: 'o', pipelineName: `n-${id}`, props: { old: true }, visibility: 'org' });

  beforeEach(() => {
    mockUpdate.mockReset().mockImplementation(async (id: string) => ({ id }));
    mockFindByIds.mockReset().mockResolvedValue([row(ID1), row(ID2)]);
    mockValidatePipeline.mockReset();
    mockEmitAudit.mockReset();
    mockSendSuccess.mockClear();
  });

  it('does not update a row the new props would make non-compliant, and reports it', async () => {
    mockValidatePipeline.mockImplementation(async (_org: string, _attrs: any, _auth: string, entityId: string) => (
      entityId === ID2
        ? { blocked: true, violations: [{ message: 'no public buckets' }] }
        : { blocked: false, violations: [] }
    ));

    await handler(mockReq({ ids: [ID1, ID2], data: { props: { new: true } } }), mockRes());

    // Each row evaluated AS IT WILL BE (new props over its existing state), as an update.
    expect(mockValidatePipeline).toHaveBeenCalledTimes(2);
    expect(mockValidatePipeline).toHaveBeenCalledWith(
      'test-org',
      expect.objectContaining({ project: 'p', organization: 'o', props: { new: true }, visibility: 'org' }),
      expect.any(String), ID1, `n-${ID1}`, 'update',
    );
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0]).toBe(ID1);
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.updated).toBe(1);
    expect(payload.errors).toEqual([{ index: 1, error: 'Compliance blocked: no public buckets' }]);
  });

  it('fails closed: a compliance outage rejects the rows instead of writing them unchecked', async () => {
    mockValidatePipeline.mockRejectedValue(new Error('ECONNREFUSED'));

    await handler(mockReq({ ids: [ID1, ID2], data: { visibility: 'public' } }), mockRes());

    expect(mockUpdate).not.toHaveBeenCalled();
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.updated).toBe(0);
    expect(payload.failed).toBe(2);
    expect(payload.errors[0].error).toMatch(/Compliance service unavailable/);
  });

  it('skips the compliance round-trip for a metadata-only edit', async () => {
    await handler(mockReq({ ids: [ID1, ID2], data: { description: 'x' } }), mockRes());
    expect(mockValidatePipeline).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });
});

// Plugin contracts: the shared bulk-update props are checked once; bulk
// create checks each item and reports a violation in errors[] before reserving
// any quota for it.
describe('bulk routes — plugin contract enforcement', () => {
  const violation = { path: 'synth', step: 'synth', plugin: 'cdk-synth', version: '1.0.0', missing: ['vars.branch'], invalid: [] };

  beforeEach(() => {
    mockFindContractViolations.mockReset().mockResolvedValue([]);
    mockUpdate.mockReset().mockImplementation(async (id: string) => ({ id }));
    mockFindByIds.mockReset().mockResolvedValue([]);
    mockSendSuccess.mockClear();
  });

  it('bulk update refuses props that break a plugin contract, updating nothing', async () => {
    mockFindContractViolations.mockResolvedValue([violation]);
    const res = mockRes();
    await getHandler('put', '/bulk/update')(mockReq({ ids: [ID1, ID2], data: { props: { synth: {} } } }), res);

    expect(mockFindContractViolations).toHaveBeenCalledWith({ synth: {} }, 'test-org', undefined);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('bulk update skips the contract check when props are not changing', async () => {
    await getHandler('put', '/bulk/update')(mockReq({ ids: [ID1], data: { description: 'x' } }), mockRes());
    expect(mockFindContractViolations).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('bulk create reports a contract violation per item and reserves no quota for it', async () => {
    mockFindContractViolations.mockResolvedValue([violation]);
    const { reserveQuota } = await import('@pipeline-builder/api-core') as any;
    await getHandler('post', '/bulk/create')(mockReq({
      pipelines: [{ project: 'p', organization: 'o', props: { synth: {} } }],
    }), mockRes());

    expect(reserveQuota).not.toHaveBeenCalled();
    const [, , payload] = mockSendSuccess.mock.calls[0];
    expect(payload.failed).toBe(1);
    expect(payload.errors).toEqual([{ index: 0, error: 'Pipeline does not meet the contract of 1 plugin step(s)' }]);
  });
});

// Bulk create/update share the single routes' write helpers, so the catalog
// metadata (lifecycle, criticality, labels, links) and ownership rules that the
// single create/update apply are applied in bulk too — bulk used to drop them.
describe('bulk routes — catalog metadata parity with single create/update', () => {
  const catalog = {
    lifecycle: 'production',
    criticality: 'high',
    labels: { team: 'payments' },
    links: [{ title: 'runbook', url: 'https://example.com/rb' }],
  };

  beforeEach(async () => {
    mockFindContractViolations.mockReset().mockResolvedValue([]);
    mockValidatePipeline.mockReset().mockResolvedValue({ blocked: false, violations: [] });
    mockCreateAsDefault.mockReset().mockImplementation(async (row: any) => ({
      pipeline: { id: 'new-1', ...row }, inserted: true,
    }));
    mockUpdate.mockReset().mockImplementation(async (id: string) => ({ id }));
    mockFindByIds.mockReset().mockResolvedValue([]);
    mockSendSuccess.mockClear();
    const { reserveQuota } = await import('@pipeline-builder/api-core') as any;
    reserveQuota.mockResolvedValue({ exceeded: false, quota: { used: 1, limit: 10 } });
  });

  it('bulk create persists catalog metadata and makes the creator the owner', async () => {
    await getHandler('post', '/bulk/create')(mockReq({
      pipelines: [{ project: 'p', organization: 'o', props: {}, ...catalog, ownerId: 'someone-else', ownerType: 'team' }],
    }), mockRes());

    expect(mockCreateAsDefault).toHaveBeenCalledTimes(1);
    expect(mockCreateAsDefault.mock.calls[0][0]).toMatchObject({
      ...catalog,
      ownerId: 'test-user',
      ownerType: 'user',
      createdBy: 'test-user',
    });
    const [, status, payload] = mockSendSuccess.mock.calls[0];
    expect(status).toBe(201);
    expect(payload.created).toBe(1);
  });

  it('bulk update writes catalog metadata; ownership only for an admin', async () => {
    await getHandler('put', '/bulk/update')(mockReq({ ids: [ID1], data: { ...catalog, ownerId: 'u-2', ownerType: 'user' } }), mockRes());
    expect(mockUpdate.mock.calls[0][1]).toEqual(catalog);

    mockUpdate.mockClear();
    await getHandler('put', '/bulk/update')({
      ...mockReq({ ids: [ID1], data: { ...catalog, ownerId: 'u-2', ownerType: 'user' } }),
      user: { sub: 'actor-1', isAdmin: true },
    }, mockRes());
    expect(mockUpdate.mock.calls[0][1]).toEqual({ ...catalog, ownerId: 'u-2', ownerType: 'user' });
  });
});
