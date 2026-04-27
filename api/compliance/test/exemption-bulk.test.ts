// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /compliance/exemptions/bulk — accepts an array of exemption
 * specs and inserts them in one DB call. Used by the dashboard CSV-import flow
 * to onboard a new noisy rule against many known-acceptable resources.
 *
 * Verifies:
 * - Happy path returns the count of inserted rows
 * - Empty array → 400
 * - Oversize batch (501) → 400
 * - Malformed row → 400
 * - Returned ids are forwarded from db.returning
 */

const insertedRowsRef: { value: { id: string }[] } = { value: [] };

jest.mock('@pipeline-builder/api-core', () => ({
  ErrorCode: { VALIDATION_ERROR: 'VALIDATION_ERROR', MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD' },
  getParam: (p: any, k: string) => p[k],
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateBody: (req: any, schema: any) => {
    try {
      const value = schema.parse(req.body);
      return { ok: true, value };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'invalid' };
    }
  },
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendSuccess: jest.fn((res: any, status: number, data: any, _msg?: string) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  sendPaginatedNested: jest.fn(),
  sendEntityNotFound: jest.fn((res: any) => res.status(404).json({ message: 'not found' })),
}));

jest.mock('@pipeline-builder/api-server', () => ({
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: 'u-1' });
  },
}));

jest.mock('@pipeline-builder/pipeline-core', () => {
  const insertChain = {
    values: () => insertChain,
    returning: () => Promise.resolve(insertedRowsRef.value),
  };
  return {
    schema: {
      complianceExemption: { id: 'col_id', orgId: 'col_org', createdAt: 'col_created' },
    },
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      insert: () => insertChain,
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

function getHandler() {
  const router = createExemptionRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/bulk' && l.route?.methods?.post,
  );
  if (!layer) throw new Error('POST /bulk not registered');
  return layer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, json };
}

const validRow = (overrides: Record<string, unknown> = {}) => ({
  ruleId: '11111111-1111-4111-8111-111111111111',
  entityType: 'plugin',
  entityId: '22222222-2222-4222-8222-222222222222',
  reason: 'allowlisted by security team',
  ...overrides,
});

describe('POST /exemptions/bulk', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    insertedRowsRef.value = [];
  });

  it('inserts a batch and returns created/skipped counts', async () => {
    insertedRowsRef.value = [{ id: 'e1' }, { id: 'e2' }];
    const handler = getHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      body: { exemptions: [validRow(), validRow({ entityId: '33333333-3333-4333-8333-333333333333' })] },
    } as any, res);

    const payload = json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.statusCode).toBe(201);
    expect(payload.data.created).toBe(2);
    expect(payload.data.skipped).toBe(0);
    expect(payload.data.ids).toEqual(['e1', 'e2']);
  });

  it('reports skipped when some rows did not insert (DB returned fewer than requested)', async () => {
    insertedRowsRef.value = [{ id: 'e1' }];
    const handler = getHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      body: { exemptions: [validRow(), validRow({ entityId: '33333333-3333-4333-8333-333333333333' })] },
    } as any, res);

    const payload = json.mock.calls[0][0];
    expect(payload.data.created).toBe(1);
    expect(payload.data.skipped).toBe(1);
  });

  it('returns 400 on empty array', async () => {
    const handler = getHandler();
    const { res, json } = makeRes();
    await handler({ __orgId: 'org-a', body: { exemptions: [] } } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
  });

  it('returns 400 on oversize batch (>500)', async () => {
    const tooMany = Array.from({ length: 501 }, () => validRow());
    const handler = getHandler();
    const { res, json } = makeRes();
    await handler({ __orgId: 'org-a', body: { exemptions: tooMany } } as any, res);
    const payload = json.mock.calls[0][0];
    expect(payload.message).toBeDefined();
  });

  it('returns 400 when a row is malformed (missing reason)', async () => {
    const handler = getHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      body: { exemptions: [{ ruleId: validRow().ruleId, entityType: 'plugin', entityId: validRow().entityId /* no reason */ }] },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
  });

  it('returns 400 when entityType is unknown', async () => {
    const handler = getHandler();
    const { res, json } = makeRes();
    await handler({
      __orgId: 'org-a',
      body: { exemptions: [validRow({ entityType: 'organization' })] },
    } as any, res);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
  });
});
