// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The bulk pipeline routes' AUTHORIZATION and QUOTA paths, which the sibling
 * suite (bulk-pipeline-update.test.ts) never runs because it stubs every caller
 * as a superadmin and every reservation as granted:
 *
 *  - per-row visibility on bulk delete/update with the REAL ladder (api-core
 *    rejectForbiddenBulkRows): a private row of another author, and a public row
 *    without `pipelines:publish`, refuse the WHOLE batch and name the ids;
 *  - bulk create's quota messages (a real limit vs an unconfirmable reserve);
 *  - the slot refunds: an upsert that UPDATED a row, and a compliance-blocked or
 *    compliance-unavailable item, give their `pipelines` slot back;
 *  - per-row audit on bulk delete, regrouped by one batchId.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, handlerGetter } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const ID1 = '20000000-0000-4000-8000-000000000001';
const ID2 = '20000000-0000-4000-8000-000000000002';
const ID3 = '20000000-0000-4000-8000-000000000003';

const mockUpdate = jest.fn<(...a: any[]) => Promise<any>>();
const mockFindByIds = jest.fn<(...a: any[]) => Promise<any>>();
const mockBulkDelete = jest.fn<(...a: any[]) => Promise<any>>();
const mockCreateAsDefault = jest.fn<(...a: any[]) => Promise<any>>();
const mockValidatePipeline = jest.fn<(...a: any[]) => Promise<any>>();
const mockRecordAudit = jest.fn();
const mockReserveQuota = jest.fn<(...a: any[]) => Promise<any>>();
const mockDecrementQuota = jest.fn();

jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({
  checkPluginContracts: async () => ({ violations: [], vulnerabilities: [], severity: null }),
  findPluginContractViolations: async () => [],
  formatContractViolations: () => '',
  recordPipelineResolution: async () => undefined,
}));

jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    update: mockUpdate,
    findByIds: mockFindByIds,
    bulkDelete: mockBulkDelete,
    createAsDefaultReportInserted: (...a: unknown[]) => mockCreateAsDefault(...a),
  },
}));

jest.unstable_mockModule('../src/helpers/pipeline-template-validator.js', () => ({
  validatePipelineTemplates: jest.fn(),
}));

const actual = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
const mockSendSuccess = jest.fn((res: any, statusCode: number, data?: any) => res.status(statusCode).json({ success: true, data }));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockRecordAudit,
  createComplianceClient: () => ({ validatePipeline: mockValidatePipeline }),
  validateBulkArray: (val: unknown) => ({ value: val }),
  PipelineCreateSchema: { safeParse: (d: any) => ({ success: true, data: d }) },
  PipelineUpdateSchema: { safeParse: (d: any) => ({ success: true, data: d }) },
  pickDefined: (obj: any) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)),
  resolveVisibility: (_req: any, v?: string) => v || 'org',
  // The REAL ladder and the REAL predicates it reads off req.user.
  isSystemAdmin: actual.isSystemAdmin,
  userHasPermission: actual.userHasPermission,
  checkVisibilityWriteAccess: actual.checkVisibilityWriteAccess,
  rejectForbiddenBulkRows: actual.rejectForbiddenBulkRows,
  reserveQuota: (...a: unknown[]) => mockReserveQuota(...a),
  decrementQuota: (...a: unknown[]) => mockDecrementQuota(...a),
  sendSuccess: mockSendSuccess,
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ success: false, message: msg })),
  sendError: jest.fn((res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg })),
}));

let realWithQuotaReservation: (...a: any[]) => unknown;
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withQuotaReservation: (...a: any[]) => realWithQuotaReservation(...a),
  incCounter: () => undefined,
  createAuthenticatedWithOrgRoute: () => [],
  withRoute: (handler: Function) => async (req: any, res: any) => {
    await handler({ req, res, ctx: { log: jest.fn(), requestId: 'r' }, orgId: 'test-org', userId: 'test-user' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  CoreConstants: { MAX_BULK_ITEMS: 100 },
  replaceNonAlphanumeric: (s: string, r: string) => s.replace(/[^a-zA-Z0-9]/g, r),
}));

({ withQuotaReservation: realWithQuotaReservation } = await import('@pipeline-builder/api-server/lib/api/quota-reservation.js'));
const { createBulkPipelineRoutes } = await import('../src/routes/bulk-pipeline.js');
const getHandler = handlerGetter(createBulkPipelineRoutes({ increment: jest.fn() } as any));

/** A plain member: pipelines:write, no publish, not a superadmin. */
const member = { sub: 'test-user', permissions: ['pipelines:write'] };
const publisher = { sub: 'test-user', permissions: ['pipelines:write', 'pipelines:publish'] };

const req = (body: Record<string, unknown>, user: unknown = member, query: Record<string, string> = {}): any =>
  ({ body, params: {}, query, user, headers: {} });
function mkRes(): any {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindByIds.mockResolvedValue([]);
  mockBulkDelete.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id })));
  mockUpdate.mockImplementation(async (id: string) => ({ id }));
  mockValidatePipeline.mockResolvedValue({ blocked: false, violations: [] });
  mockReserveQuota.mockResolvedValue({ exceeded: false, quota: { used: 1, limit: 10, resetAt: '2026-12-01T00:00:00Z' } });
  mockCreateAsDefault.mockImplementation(async (row: any) => ({ pipeline: { id: 'new', ...row }, inserted: true }));
});

describe('bulk delete/update — per-row visibility (real ladder)', () => {
  const rows = {
    privateOther: { id: ID1, visibility: 'private', createdBy: 'someone-else' },
    privateMine: { id: ID2, visibility: 'private', createdBy: 'test-user' },
    publicRow: { id: ID3, visibility: 'public', createdBy: 'someone-else' },
    orgRow: { id: ID3, visibility: 'org', createdBy: 'someone-else' },
  };

  it('refuses the WHOLE delete when one row is another author\'s private draft, naming it', async () => {
    mockFindByIds.mockResolvedValue([rows.privateOther, rows.privateMine]);
    const r = mkRes();
    await getHandler('post', '/bulk/delete')(req({ ids: [ID1, ID2] }), r);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json.mock.calls[0][0]).toEqual(expect.objectContaining({ details: { ids: [ID1] } }));
    expect(mockBulkDelete).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('refuses a public row without pipelines:publish, and admits it with publish', async () => {
    mockFindByIds.mockResolvedValue([rows.publicRow]);
    const denied = mkRes();
    await getHandler('put', '/bulk/update')(req({ ids: [ID3], data: { description: 'x' } }), denied);
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(mockUpdate).not.toHaveBeenCalled();

    const allowed = mkRes();
    await getHandler('put', '/bulk/update')(req({ ids: [ID3], data: { description: 'x' } }, publisher), allowed);
    expect(allowed.status).toHaveBeenCalledWith(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('lets a plain member delete org rows and their own drafts, auditing each row under one batchId', async () => {
    mockFindByIds.mockResolvedValue([rows.privateMine, rows.orgRow]);
    const r = mkRes();
    await getHandler('post', '/bulk/delete')(req({ ids: [ID2, ID3, ID2] }), r);
    expect(r.status).toHaveBeenCalledWith(200);
    // The repeated id is one pipeline: deleted and audited once.
    expect(mockBulkDelete).toHaveBeenCalledWith([ID2, ID3], 'test-org', 'test-user', { isSystemAdmin: false, canPublish: false });
    expect(mockRecordAudit.mock.calls.map((c: any[]) => c[0].targetId)).toEqual([ID2, ID3]);
    expect(new Set(mockRecordAudit.mock.calls.map((c: any[]) => c[0].details.batchId)).size).toBe(1);
  });

  it('a superadmin skips the per-row lookup', async () => {
    await getHandler('post', '/bulk/delete')(req({ ids: [ID1] }, { sub: 'test-user', isSuperAdmin: true }), mkRes());
    expect(mockFindByIds).not.toHaveBeenCalled();
    expect(mockBulkDelete).toHaveBeenCalledWith([ID1], 'test-org', 'test-user', { isSystemAdmin: true, canPublish: true });
  });
});

describe('bulk create — quota', () => {
  const item = (n: number) => ({ project: `p${n}`, organization: 'o', props: {} });
  const payload = (r: any) => r.json.mock.calls[0][0].data;

  it('reports a real limit as "Quota exceeded: used/limit" and creates nothing for that item', async () => {
    mockReserveQuota
      .mockResolvedValueOnce({ exceeded: false, quota: { used: 9, limit: 10 } })
      .mockResolvedValueOnce({ exceeded: true, quota: { used: 10, limit: 10 } });
    const r = mkRes();
    await getHandler('post', '/bulk/create')(req({ pipelines: [item(1), item(2)] }), r);
    expect(payload(r)).toEqual(expect.objectContaining({
      created: 1, failed: 1, errors: [{ index: 1, error: 'Quota exceeded: 10/10' }],
    }));
    expect(mockCreateAsDefault).toHaveBeenCalledTimes(1);
  });

  it('reports an unconfirmable reserve as retryable, not as a limit', async () => {
    mockReserveQuota.mockResolvedValue({ exceeded: true, unavailable: true, quota: { used: 0, limit: 0 } });
    const r = mkRes();
    await getHandler('post', '/bulk/create')(req({ pipelines: [item(1)] }), r);
    expect(payload(r).errors).toEqual([{ index: 0, error: expect.stringMatching(/^Quota service unavailable/) }]);
    expect(mockCreateAsDefault).not.toHaveBeenCalled();
  });

  it('refunds the slot of an upsert that UPDATED an existing default (not a net-new pipeline)', async () => {
    mockCreateAsDefault.mockResolvedValue({ pipeline: { id: 'existing' }, inserted: false });
    const r = mkRes();
    await getHandler('post', '/bulk/create')(req({ pipelines: [item(1)] }, member, { upsert: 'true' }), r);
    expect(payload(r)).toEqual(expect.objectContaining({ created: 0, updated: 1 }));
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockDecrementQuota.mock.calls[0]).toEqual(expect.arrayContaining(['test-org', 'pipelines']));
  });

  it('keeps the slot of a net-new pipeline', async () => {
    await getHandler('post', '/bulk/create')(req({ pipelines: [item(1)] }), mkRes());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('refunds the slot of a compliance-BLOCKED item and reports the violations', async () => {
    mockValidatePipeline.mockResolvedValue({ blocked: true, violations: [{ message: 'needs a reviewer', ruleId: 'r1' }] });
    const r = mkRes();
    await getHandler('post', '/bulk/create')(req({ pipelines: [item(1)] }), r);
    expect(payload(r).errors).toEqual([{ index: 0, error: 'Compliance blocked: needs a reviewer' }]);
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockCreateAsDefault).not.toHaveBeenCalled();
  });

  it('refunds the slot when compliance is unavailable (fail-closed, nothing written)', async () => {
    mockValidatePipeline.mockRejectedValue(new Error('compliance down'));
    const r = mkRes();
    await getHandler('post', '/bulk/create')(req({ pipelines: [item(1)] }), r);
    expect(payload(r).failed).toBe(1);
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockCreateAsDefault).not.toHaveBeenCalled();
  });
});
