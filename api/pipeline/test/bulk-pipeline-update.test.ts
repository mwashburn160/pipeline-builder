// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Fix 1 — PUT /pipelines/bulk/update must isolate per-item failures. A single
// rejected update() (Promise.allSettled, not Promise.all) must NOT discard the
// rows that already committed nor surface a blanket 500; failures land in a
// per-index errors[] like bulk/create.

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUpdate = jest.fn<(...a: any[]) => Promise<any>>();
const mockFindByIds = jest.fn<(...a: any[]) => Promise<any>>().mockResolvedValue([]);
const mockEmitAudit = jest.fn();

jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({
  pipelineService: {
    update: mockUpdate,
    findByIds: mockFindByIds,
    createAsDefaultReportInserted: jest.fn(),
    bulkDelete: jest.fn(),
  },
}));

jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitPipelineAudit: mockEmitAudit,
}));

jest.unstable_mockModule('../src/helpers/pipeline-template-validator.js', () => ({
  validatePipelineTemplates: jest.fn(),
}));

const mockSendSuccess = jest.fn((res: any, statusCode: number, data?: any) => {
  res.status(statusCode).json({ success: true, statusCode, data });
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createComplianceClient: () => ({ validatePipeline: jest.fn() }),
  validateBulkArray: (val: unknown) => ({ value: val }),
  PipelineCreateSchema: { safeParse: (d: any) => ({ success: true, data: d }) },
  PipelineUpdateSchema: { safeParse: (d: any) => ({ success: true, data: d }) },
  pickDefined: (obj: any) => {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
    return out;
  },
  resolveAccessModifier: (_req: any, am?: string) => am || 'private',
  isSystemAdmin: () => true,
  reserveQuota: jest.fn(),
  decrementQuota: jest.fn(),
  sendSuccess: mockSendSuccess,
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ success: false, message: msg })),
  sendError: jest.fn((res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
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

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  CoreConstants: { MAX_BULK_ITEMS: 100 },
  replaceNonAlphanumeric: (s: string, r: string) => s.replace(/[^a-zA-Z0-9]/g, r),
}));

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
      if (id === 'id-2') throw new Error('db conflict on id-2');
      if (id === 'id-4') return null;
      return { id };
    });

    const req = mockReq({ ids: ['id-1', 'id-2', 'id-3', 'id-4'], data: { description: 'x' } });
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
    expect(payload.errors).toEqual([{ index: 1, error: 'db conflict on id-2' }]);

    // Audit emitted only for the two rows that actually updated.
    expect(mockEmitAudit).toHaveBeenCalledTimes(2);
    const auditedIds = mockEmitAudit.mock.calls.map((c: any[]) => c[0].targetId).sort();
    expect(auditedIds).toEqual(['id-1', 'id-3']);
  });

  it('reports all failures without throwing when every update rejects', async () => {
    mockUpdate.mockRejectedValue(new Error('boom'));

    const req = mockReq({ ids: ['a', 'b'], data: { description: 'x' } });
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
