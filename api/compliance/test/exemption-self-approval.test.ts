// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for PUT /compliance/exemptions/:id/review.
 *
 * The reviewer cannot be the same user that requested the exemption — that
 * would defeat the approval workflow. Rejecting your own request is allowed
 * (a user backing out of their own ask); only `status === 'approved'` by the
 * requester is blocked. System admins reviewing other-org exemptions are
 * unaffected (the route's outer where-clause already scopes by orgId).
 */

const selectChainStub = {
  fromRows: [] as Array<{ createdBy: string }>,
  updateRows: [] as Array<{ id: string; status: string }>,
};

jest.mock('@pipeline-builder/api-core', () => ({
  ErrorCode: {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  },
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
  sendPaginatedNested: jest.fn(),
  sendEntityNotFound: jest.fn((res: any) => res.status(404).json({ message: 'not found' })),
}));

jest.mock('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: req.__userId });
  },
}));

jest.mock('@pipeline-builder/pipeline-core', () => {
  const insertChain = { values: () => insertChain, returning: () => Promise.resolve([]) };
  return {
    schema: {
      complianceExemption: {
        id: 'col_id', orgId: 'col_org', status: 'col_status', createdBy: 'col_createdBy',
      },
    },
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(selectChainStub.fromRows) }) }),
      insert: () => insertChain,
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve(selectChainStub.updateRows) }),
        }),
      }),
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    },
    buildComplianceExemptionConditions: () => [],
    drizzleCount: (r: unknown) => r,
  };
});

jest.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ __op: 'and', a }),
  eq: (c: unknown, v: unknown) => ({ __op: 'eq', c, v }),
  desc: (c: unknown) => ({ __op: 'desc', c }),
  sql: jest.fn(),
}));

import { createExemptionRoutes } from '../src/routes/exemptions';

function getReviewHandler() {
  const router = createExemptionRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/:id/review' && l.route?.methods?.put,
  );
  if (!layer) throw new Error('PUT /:id/review not registered');
  return layer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, json, status };
}

describe('PUT /exemptions/:id/review — self-approval guard', () => {
  beforeEach(() => {
    selectChainStub.fromRows = [];
    selectChainStub.updateRows = [];
    jest.clearAllMocks();
  });

  it('rejects approval when the reviewer is the requester', async () => {
    selectChainStub.fromRows = [{ createdBy: 'user-X' }];
    const handler = getReviewHandler();
    const { res, status, json } = makeRes();

    await handler({
      __orgId: 'org-1',
      __userId: 'user-X', // same as createdBy
      params: { id: 'exemp-1' },
      body: { status: 'approved' },
    } as any, res);

    expect(status).toHaveBeenCalledWith(400);
    const payload = json.mock.calls[0][0];
    expect(payload.message).toMatch(/Cannot approve an exemption you requested/);
    expect(payload.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('allows the requester to REJECT their own pending request', async () => {
    // Self-rejection is a valid "I withdraw" flow — only approval is blocked.
    selectChainStub.fromRows = [{ createdBy: 'user-X' }];
    selectChainStub.updateRows = [{ id: 'exemp-1', status: 'rejected' }];
    const handler = getReviewHandler();
    const { res, json } = makeRes();

    await handler({
      __orgId: 'org-1',
      __userId: 'user-X',
      params: { id: 'exemp-1' },
      body: { status: 'rejected' },
    } as any, res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: true, statusCode: 200,
    }));
  });

  it('allows a different reviewer to approve', async () => {
    selectChainStub.fromRows = [{ createdBy: 'user-REQUESTER' }];
    selectChainStub.updateRows = [{ id: 'exemp-1', status: 'approved' }];
    const handler = getReviewHandler();
    const { res, json } = makeRes();

    await handler({
      __orgId: 'org-1',
      __userId: 'user-REVIEWER',
      params: { id: 'exemp-1' },
      body: { status: 'approved' },
    } as any, res);

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      success: true, statusCode: 200,
    }));
  });

  it('returns 404 when no pending exemption exists for the caller orgId', async () => {
    selectChainStub.fromRows = []; // pre-check finds nothing
    const handler = getReviewHandler();
    const { res } = makeRes();

    await handler({
      __orgId: 'org-1',
      __userId: 'user-Y',
      params: { id: 'missing' },
      body: { status: 'approved' },
    } as any, res);

    // sendEntityNotFound returns 404
    const calls = (res.status as jest.Mock).mock.calls;
    expect(calls.some((c) => c[0] === 404)).toBe(true);
  });
});
