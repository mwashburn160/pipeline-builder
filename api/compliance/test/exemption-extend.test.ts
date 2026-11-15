// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for PUT /compliance/exemptions/:id/expiry (renewing an approved
 * exemption before it lapses) and the create routes' refusal of an expiry
 * that is already in the past.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { type AnyFn, drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const selectChainStub = {
  fromRows: [] as Array<Record<string, unknown>>,
  updateRows: [] as Array<Record<string, unknown>>,
};
const mockRecordAudit = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  sendError: jest.fn((res: any, status: number, msg: string, code?: string) =>
    res.status(status).json({ message: msg, code })),
  getParam: (p: any, k: string) => p[k],
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateBody: (req: any, schema: any) => {
    try {
      return { ok: true, value: schema.parse(req.body) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'invalid' };
    }
  },
  sendBadRequest: jest.fn((res: any, msg: string, code?: string) =>
    res.status(400).json({ message: msg, code })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  sendPaginatedNested: jest.fn<AnyFn>(),
  sendEntityNotFound: jest.fn((res: any) => res.status(404).json({ message: 'not found' })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn<AnyFn>() }, orgId: req.__orgId, userId: req.__userId });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  const insertChain = { values: () => insertChain, returning: () => Promise.resolve([]) };
  const tx = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(selectChainStub.fromRows) }) }),
    insert: () => insertChain,
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve(selectChainStub.updateRows) }),
      }),
    }),
    delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
  };
  return stubModule('@pipeline-builder/pipeline-data', {
    schema: {
      complianceExemption: {
        id: 'col_id', orgId: 'col_org', status: 'col_status', createdBy: 'col_createdBy',
      },
    },
    db: tx,
    withTenantTx: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
    buildComplianceExemptionConditions: () => [],
    drizzleCount: (r: unknown) => r,
  });
});

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...a: unknown[]) => ({ __op: 'and', a }),
  or: (...a: unknown[]) => ({ __op: 'or', a }),
  eq: (c: unknown, v: unknown) => ({ __op: 'eq', c, v }),
  gt: (c: unknown, v: unknown) => ({ __op: 'gt', c, v }),
  inArray: (c: unknown, v: unknown) => ({ __op: 'inArray', c, v }),
  isNull: (c: unknown) => ({ __op: 'isNull', c }),
  desc: (c: unknown) => ({ __op: 'desc', c }),
  sql: jest.fn<AnyFn>(),
}));

const { createExemptionRoutes } = await import('../src/routes/exemptions.js');

function getHandler(method: 'put' | 'post', path: string) {
  const router = createExemptionRoutes();
  const layer = (router.stack as any[]).find((l) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} not registered`);
  const stack = layer.route.stack as any[];
  return stack[stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json });
  return { res: { status, json } as any, json, status };
}

const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

describe('PUT /exemptions/:id/expiry', () => {
  beforeEach(() => {
    selectChainStub.fromRows = [];
    selectChainStub.updateRows = [];
    jest.clearAllMocks();
  });

  async function extend(userId: string, body: unknown) {
    const { res, json, status } = makeRes();
    await getHandler('put', '/:id/expiry')({ __orgId: 'org-1', __userId: userId, params: { id: 'ex-1' }, body } as any, res);
    return { json, status };
  }

  it('extends an approved exemption and audits it as an approval marked `extension`', async () => {
    const previous = inDays(2);
    const next = inDays(30);
    selectChainStub.fromRows = [{ createdBy: 'requester', status: 'approved', expiresAt: previous }];
    selectChainStub.updateRows = [{
      id: 'ex-1', status: 'approved', expiresAt: next, ruleId: 'r1', entityType: 'plugin', entityId: 'e1', createdBy: 'requester',
    }];

    const { json, status } = await extend('reviewer', { expiresAt: next.toISOString() });

    expect(status).toHaveBeenCalledWith(200);
    expect(json.mock.calls[0][0].data.exemption).toMatchObject({ id: 'ex-1', expiresAt: next });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.exemption.approve',
      actorId: 'reviewer',
      targetId: 'ex-1',
      details: expect.objectContaining({
        extension: true, requester: 'requester', previousExpiresAt: previous.toISOString(), expiresAt: next.toISOString(),
      }),
    }));
  });

  it('refuses the requester extending their own exemption and records the failed approval', async () => {
    selectChainStub.fromRows = [{ createdBy: 'requester', status: 'approved', expiresAt: inDays(2) }];

    const { json, status } = await extend('requester', { expiresAt: inDays(30).toISOString() });

    expect(status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'compliance.exemption.approve', outcome: 'failure', details: { extension: true, refusal: 'CE_SELF_APPROVE' },
    }));
  });

  it('400s an expiry in the past', async () => {
    const { status } = await extend('reviewer', { expiresAt: inDays(-1).toISOString() });
    expect(status).toHaveBeenCalledWith(400);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('400s an expiry not later than the current one', async () => {
    selectChainStub.fromRows = [{ createdBy: 'requester', status: 'approved', expiresAt: inDays(20) }];
    const { status } = await extend('reviewer', { expiresAt: inDays(10).toISOString() });
    expect(status).toHaveBeenCalledWith(400);
  });

  it('409s an exemption that is not approved and in force', async () => {
    selectChainStub.fromRows = [{ createdBy: 'requester', status: 'pending', expiresAt: inDays(2) }];
    const { json, status } = await extend('reviewer', { expiresAt: inDays(30).toISOString() });
    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0].code).toBe('CONFLICT');
  });

  it('404s an exemption outside the caller org', async () => {
    const { status } = await extend('reviewer', { expiresAt: inDays(30).toISOString() });
    expect(status).toHaveBeenCalledWith(404);
  });

  it('400s a body without a datetime expiresAt', async () => {
    const { status } = await extend('reviewer', { expiresAt: 'next week' });
    expect(status).toHaveBeenCalledWith(400);
  });
});

describe('creating an exemption whose expiresAt has already passed', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  const request = (expiresAt: string) => ({
    ruleId: '00000000-0000-4000-8000-000000000001',
    entityType: 'plugin',
    entityId: '00000000-0000-4000-8000-000000000002',
    reason: 'temporary',
    expiresAt,
  });

  it('POST / answers 400', async () => {
    const { res, status } = makeRes();
    await getHandler('post', '/')({ __orgId: 'org-1', __userId: 'u', headers: {}, params: {}, body: request(inDays(-1).toISOString()) } as any, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('POST /bulk answers 400 when any row is already past', async () => {
    const { res, status } = makeRes();
    await getHandler('post', '/bulk')({
      __orgId: 'org-1',
      __userId: 'u',
      headers: {},
      params: {},
      body: { exemptions: [request(inDays(5).toISOString()), request(inDays(-1).toISOString())] },
    } as any, res);
    expect(status).toHaveBeenCalledWith(400);
  });
});
