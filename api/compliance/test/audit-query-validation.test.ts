// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for GET /compliance/audit query validation.
 *
 * Regression: `scanId`/`dateFrom`/`dateTo` were passed straight to the query
 * builder, which does `new Date(dateFrom)` (→ Invalid Date) and `eq(scanId)`
 * against a uuid column (→ Postgres cast error) → an unhandled 500. The route
 * now validates the query with a Zod schema and returns 400 on bad input.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockList = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateQuery: (req: any, schema: any) => {
    try {
      return { ok: true, value: schema.parse(req.query) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'invalid' };
    }
  },
  sendBadRequest: jest.fn((res: any, msg: string, code: string) =>
    res.status(400).json({ message: msg, code })),
  sendPaginatedNested: jest.fn((res: any, _key: string, entries: unknown[], meta: unknown) =>
    res.status(200).json({ entries, meta })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId ?? 'org-1' });
  },
}));

jest.unstable_mockModule('../src/services/compliance-check-log-query.js', () => ({
  complianceAuditService: {
    list: (...args: unknown[]) => mockList(...args),
  },
}));

const { createAuditRoutes } = await import('../src/routes/audit.js');

function getGetHandler() {
  const router = createAuditRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/' && l.route?.methods?.get,
  );
  if (!layer) throw new Error('GET / not registered');
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

describe('GET /compliance/audit — query validation', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockList.mockResolvedValue({ entries: [], total: 0 });
  });

  it('returns 400 (not 500) for a malformed dateFrom', async () => {
    const handler = getGetHandler();
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-1', query: { dateFrom: 'not-a-date' } } as any, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('returns 400 (not 500) for a non-uuid scanId', async () => {
    const handler = getGetHandler();
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-1', query: { scanId: 'not-a-uuid' } } as any, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('rejects an invalid result enum value', async () => {
    const handler = getGetHandler();
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-1', query: { result: 'exploded' } } as any, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('accepts a well-formed query and calls the service', async () => {
    const handler = getGetHandler();
    const { res, status } = makeRes();

    await handler({
      __orgId: 'org-1',
      query: {
        scanId: '11111111-1111-4111-8111-111111111111',
        dateFrom: '2026-07-01T00:00:00.000Z',
        dateTo: '2026-07-31T00:00:00.000Z',
        target: 'plugin',
        result: 'block',
      },
    } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(mockList).toHaveBeenCalledTimes(1);
    const [filter, orgId] = mockList.mock.calls[0];
    expect(orgId).toBe('org-1');
    expect((filter as Record<string, unknown>).scanId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('accepts an empty query (all filters optional)', async () => {
    const handler = getGetHandler();
    const { res, status } = makeRes();

    await handler({ __orgId: 'org-1', query: {} } as any, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(mockList).toHaveBeenCalledTimes(1);
  });
});
