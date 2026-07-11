// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for POST /compliance/scans tenancy guard.
 *
 * The route accepts a free-form `filter: Record<string, unknown>` from the
 * client. Without sanitization, a member could pass `filter: { orgId: 'other' }`
 * and the executor would scan another tenant's entities. The route MUST
 * overwrite `filter.orgId` with the caller's actual orgId before insert.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const insertedRowRef: { value: { id: string; filter: Record<string, unknown> | null } | null } = { value: null };
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

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
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
  return {
    schema: {
      complianceScan: { id: 'col_id', orgId: 'col_org' },
    },
    db: dbLike,
    // Services now read/write via withTenantTx; the tx exposes the same chain.
    withTenantTx: (fn: (tx: typeof dbLike) => unknown) => fn(dbLike),
    buildComplianceScanConditions: () => [],
    drizzleCount: (r: unknown) => r,
  };
});

jest.unstable_mockModule('drizzle-orm', () => ({
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
  return layer.route.stack[0].handle;
}

function makeRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status, json } as any, json };
}

describe('POST /compliance/scans — tenancy guard', () => {
  beforeEach(() => {
    insertCalls.length = 0;
    insertedRowRef.value = { id: 'scan-1', filter: null };
  });

  it('strips caller-supplied filter.orgId by overwriting with the JWT orgId', async () => {
    const handler = getPostHandler();
    const { res } = makeRes();
    await handler({
      __orgId: 'org-mine',
      body: {
        target: 'plugin',
        filter: { orgId: 'org-OTHER', extra: 'preserved' },
      },
    } as any, res);

    expect(insertCalls).toHaveLength(1);
    const row = insertCalls[0];
    // Tenancy: server overwrites the caller's filter.orgId with their own.
    expect((row.filter as Record<string, unknown>).orgId).toBe('org-mine');
    // Other filter fields pass through untouched.
    expect((row.filter as Record<string, unknown>).extra).toBe('preserved');
    // Top-level scan.orgId is also the caller's, never the spoofed one.
    expect(row.orgId).toBe('org-mine');
  });

  it('passes null filter through when not supplied', async () => {
    const handler = getPostHandler();
    const { res } = makeRes();
    await handler({
      __orgId: 'org-a',
      body: { target: 'pipeline' },
    } as any, res);

    const row = insertCalls[0];
    expect(row.filter).toBeNull();
    expect(row.orgId).toBe('org-a');
  });
});
