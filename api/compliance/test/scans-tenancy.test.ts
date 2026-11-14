// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /compliance/scans tenancy + body shape.
 *
 * A scan always evaluates the caller's whole org (the JWT orgId) — there is no
 * partial-scan filter. The body is STRICT, so a client that sends `filter` (or
 * any org-naming field) gets a 400 instead of a scan that silently ignored it.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const insertedRowRef: { value: { id: string } | null } = { value: null };
const insertCalls: Array<Record<string, unknown>> = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p[k],
  parsePaginationParams: () => ({ limit: 25, offset: 0 }),
  validateBody: (req: any, schema: any) => {
    try {
      return { ok: true, value: schema.parse(req.body) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'invalid' };
    }
  },
  validateQuery: (req: any, schema: any) => {
    try {
      return { ok: true, value: schema.parse(req.query) };
    } catch (err: any) {
      return { ok: false, error: err.message ?? 'invalid' };
    }
  },
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  sendPaginatedNested: jest.fn(),
  sendEntityNotFound: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.__orgId, userId: 'u-1' });
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  const insertChain: Record<string, Function> = {
    values: (row: Record<string, unknown>) => {
      insertCalls.push(row);
      return insertChain;
    },
    returning: () => Promise.resolve(insertedRowRef.value ? [insertedRowRef.value] : []),
  };
  const dbLike = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => insertChain,
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  };
  return stubModule('@pipeline-builder/pipeline-data', {
    schema: {
      complianceScan: { id: 'col_id', orgId: 'col_org' },
    },
    db: dbLike,
    // Services now read/write via withTenantTx; the tx exposes the same chain.
    withTenantTx: (fn: (tx: typeof dbLike) => unknown) => fn(dbLike),
    buildComplianceScanConditions: () => [],
    drizzleCount: (r: unknown) => r,
  });
});

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...a: unknown[]) => ({ __op: 'and', a }),
  eq: (c: unknown, v: unknown) => ({ __op: 'eq', c, v }),
  desc: (c: unknown) => ({ __op: 'desc', c }),
  sql: jest.fn(),
}));

const { createScanRoutes } = await import('../src/routes/scans.js');

function getPostHandler() {
  const router = createScanRoutes();
  const layer = (router.stack as any[]).find(
    (l) => l.route?.path === '/' && l.route?.methods?.post,
  );
  if (!layer) throw new Error('POST / not registered');
  // The route now mounts `requirePermission('compliance:write')` ahead of the
  // withRoute handler, so grab the LAST layer (the handler), not stack[0].
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, json };
}

describe('POST /compliance/scans — tenancy guard', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    insertedRowRef.value = { id: 'scan-1' };
  });

  it('REFUSES a body carrying a filter (there is no partial scan) — nothing is inserted', async () => {
    const handler = getPostHandler();
    const { res } = makeRes();
    await handler({
      __orgId: 'org-mine',
      body: { target: 'plugin', filter: { orgId: 'org-OTHER' } },
    } as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(insertCalls).toHaveLength(0);
  });

  it('scans the caller org from the JWT and stores no filter column', async () => {
    const handler = getPostHandler();
    const { res } = makeRes();
    await handler({
      __orgId: 'org-a',
      body: { target: 'pipeline' },
    } as any, res);

    const row = insertCalls[0];
    expect(row).not.toHaveProperty('filter');
    expect(row.orgId).toBe('org-a');
  });
});
