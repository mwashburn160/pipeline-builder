// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/ops/*` (controllers/ops-internal.ts): the three reads of
 * platform-held identity data ops-center makes since the operations control
 * plane moved out of this service — an org's account root (feature quotas), one
 * audit-activity aggregation (Audit Activity panels), and the live org ids (a
 * sysadmin's `orgs=all` log view). Each validates through its api-core contract.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ROOT = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const mockExists = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFind = jest.fn<(...a: unknown[]) => unknown>();
const mockLineage = jest.fn<(orgId: string) => Promise<{ rootOrgId?: string }>>();
const mockAuditStore = jest.fn<(...a: unknown[]) => Promise<unknown>>();
let foundIds: string[] = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => `oid:${id}` }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ resolveOrgLineage: (o: string) => mockLineage(o) }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    exists: (...a: unknown[]) => mockExists(...a),
    find: (...a: unknown[]) => {
      mockFind(...a);
      const q = { sort: () => q, limit: (n: number) => ({ lean: async () => foundIds.slice(0, n).map((_id) => ({ _id })) }) };
      return q;
    },
  },
}));
jest.unstable_mockModule('../src/observability/audit-store-client.js', () => ({ queryAuditStore: (...a: unknown[]) => mockAuditStore(...a) }));

const { getOrgAccountRoot, postAuditActivity, getLiveOrgIds } = await import('../src/controllers/ops-internal.js');

function mockRes() {
  const res: any = { statusCode: 0, body: undefined, headersSent: false };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; return res; });
  return res;
}
const call = async (fn: unknown, req: Record<string, unknown>) => {
  const res = mockRes();
  await (fn as any)({ headers: {}, params: {}, query: {}, ...req }, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockExists.mockResolvedValue({ _id: ORG });
  mockLineage.mockResolvedValue({ rootOrgId: ROOT });
  foundIds = [];
});

describe('GET /internal/ops/org-account-root/:orgId', () => {
  it('answers the root of the org\'s ancestry', async () => {
    const res = await call(getOrgAccountRoot, { params: { orgId: ORG.toUpperCase() } });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ orgId: ORG, rootOrgId: ROOT });
    expect(mockLineage).toHaveBeenCalledWith(ORG);
  });

  it('a flat org is its own root', async () => {
    mockLineage.mockResolvedValue({});
    const res = await call(getOrgAccountRoot, { params: { orgId: ORG } });
    expect(res.body.data).toEqual({ orgId: ORG, rootOrgId: ORG });
  });

  it('404s an unknown org and 400s a malformed id', async () => {
    mockExists.mockResolvedValue(null);
    expect((await call(getOrgAccountRoot, { params: { orgId: ORG } })).statusCode).toBe(404);
    expect((await call(getOrgAccountRoot, { params: { orgId: 'nope' } })).statusCode).toBe(400);
    expect(mockLineage).not.toHaveBeenCalled();
  });
});

describe('POST /internal/ops/audit-activity', () => {
  const body = { query: 'events_by_action', scope: { isSuperAdmin: false, orgId: ORG }, range: '6h', end: 1_800_000_000, limit: 50, vars: { event: 'user.login' } };

  it('runs the named aggregation under the caller-verified scope', async () => {
    mockAuditStore.mockResolvedValue({ kind: 'matrix', series: [], step: '1800s' });
    const res = await call(postAuditActivity, { body });
    expect(res.statusCode).toBe(200);
    expect(mockAuditStore).toHaveBeenCalledWith('events_by_action', { isSuperAdmin: false, orgId: ORG }, { range: '6h', end: 1_800_000_000, limit: 50, vars: { event: 'user.login' } });
    expect(res.body.data).toEqual({ kind: 'matrix', series: [], step: '1800s' });
  });

  it('400s an unknown query, an unknown range or an unbounded limit', async () => {
    for (const bad of [{ ...body, query: 'drop_everything' }, { ...body, range: '1y' }, { ...body, limit: 100_000 }]) {
      expect((await call(postAuditActivity, { body: bad })).statusCode).toBe(400);
    }
    expect(mockAuditStore).not.toHaveBeenCalled();
  });
});

describe('GET /internal/ops/live-org-ids', () => {
  it('lists live orgs in id order up to the limit', async () => {
    foundIds = ['o1', 'o2', 'o3'];
    const res = await call(getLiveOrgIds, { query: { limit: '2' } });
    expect(mockFind).toHaveBeenCalledWith({ deletedAt: null }, { _id: 1 });
    expect(res.body.data).toEqual({ orgIds: ['o1', 'o2'] });
  });

  it('clamps a nonsense limit to the contract maximum', async () => {
    foundIds = ['o1'];
    const res = await call(getLiveOrgIds, { query: { limit: 'lots' } });
    expect(res.statusCode).toBe(200);
  });
});
