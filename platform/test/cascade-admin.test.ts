// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * controllers/cascade-admin.ts — the operator view of the cascade outbox
 * (GET /admin/cascade) and the redrive (POST /admin/cascade/:id/redrive).
 *
 * The service layer runs against real Mongo in cascade-outbox.integration.test.ts;
 * this pins the HTTP contract: each controller re-checks its permission, the
 * filters are validated before anything is read, the list is the nested
 * paginated shape, a redrive is audited `admin.cascade.redrive` with the leg's
 * before-state, and a refusal maps to 404 / 409 with nothing audited.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({}));
const mockAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
const mockList = jest.fn<AnyFn>();
const mockRedrive = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/cascade-outbox.js', () => ({
  listCascadeLegs: (...a: unknown[]) => mockList(...a),
  redriveCascadeLeg: (...a: unknown[]) => mockRedrive(...a),
}));

const { listCascade, redriveCascade } = await import('../src/controllers/cascade-admin.js');

type Handler = (req: any, res: any) => Promise<void>;
function mockRes() {
  const res: any = { headersSent: false };
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}
const sysadmin = (extra: Record<string, unknown> = {}): any => ({
  user: { sub: 'root', organizationId: 'system', isSuperAdmin: true },
  headers: {},
  params: {},
  query: {},
  body: {},
  ...extra,
});
const orgAdmin = (extra: Record<string, unknown> = {}): any => ({
  user: { sub: 'u1', organizationId: 'org-1', role: 'admin' },
  headers: {},
  params: {},
  query: {},
  body: {},
  ...extra,
});

const leg = {
  id: '65f000000000000000000001',
  kind: 'org.deleted',
  subjectId: 'org-9',
  service: 'billing',
  status: 'pending',
  attempts: 0,
  nextAttemptAt: new Date(0),
  lastError: 'HTTP 503',
  lastStatusCode: 503,
  completedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue({ legs: [leg], total: 3 });
});

describe('GET /admin/cascade', () => {
  it('lists with the filters and answers the nested paginated shape', async () => {
    const res = mockRes();
    await (listCascade as Handler)(sysadmin({ query: { status: 'dead', kind: 'org.deleted', subjectId: 'org-9', service: 'billing', limit: '1', offset: '1' } }), res);
    expect(mockList).toHaveBeenCalledWith({ status: 'dead', kind: 'org.deleted', subjectId: 'org-9', service: 'billing' }, { limit: 1, offset: 1 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      success: true,
      data: { legs: [expect.objectContaining({ id: leg.id })], pagination: { total: 3, limit: 1, offset: 1, hasMore: true } },
    });
  });

  it('passes no filter when none is given', async () => {
    await (listCascade as Handler)(sysadmin(), mockRes());
    expect(mockList).toHaveBeenCalledWith({}, { limit: 50, offset: 0 });
  });

  it.each([
    [{ status: 'stuck' }],
    [{ kind: 'org.renamed' }],
    [{ subjectId: 'x'.repeat(129) }],
  ])('400s invalid filter #%# and reads nothing', async (query) => {
    const res = mockRes();
    await (listCascade as Handler)(sysadmin({ query }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('403s a tenant admin (re-checks platform:read)', async () => {
    const res = mockRes();
    await (listCascade as Handler)(orgAdmin(), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /admin/cascade/:id/redrive', () => {
  it('redrives (attempts reset by default) and audits the before-state', async () => {
    mockRedrive.mockResolvedValue({ ok: true, previous: { status: 'dead', attempts: 12 }, leg });
    const res = mockRes();
    await (redriveCascade as Handler)(sysadmin({ params: { id: leg.id }, body: { reason: 'billing fixed' } }), res);
    expect(mockRedrive).toHaveBeenCalledWith(leg.id, { resetAttempts: undefined });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'admin.cascade.redrive', {
      targetType: 'organization',
      targetId: 'org-9',
      affectedOrgId: 'org-9',
      details: {
        legId: leg.id, kind: 'org.deleted', service: 'billing', previousStatus: 'dead', previousAttempts: 12, resetAttempts: true, reason: 'billing fixed',
      },
    });
  });

  it('a user-erasure leg targets the user and names no affected org', async () => {
    mockRedrive.mockResolvedValue({ ok: true, previous: { status: 'pending', attempts: 3 }, leg: { ...leg, kind: 'user.erased', subjectId: 'user-1' } });
    await (redriveCascade as Handler)(sysadmin({ params: { id: leg.id }, body: { resetAttempts: false } }), mockRes());
    expect(mockRedrive).toHaveBeenCalledWith(leg.id, { resetAttempts: false });
    const [, , opts] = mockAudit.mock.calls[0] as [unknown, string, Record<string, any>];
    expect(opts).toMatchObject({ targetType: 'user', targetId: 'user-1', details: { resetAttempts: false } });
    expect(opts).not.toHaveProperty('affectedOrgId');
  });

  it.each([
    ['already_done', 409],
    ['not_found', 404],
  ])('maps %s to %i and audits nothing', async (reason, status) => {
    mockRedrive.mockResolvedValue({ ok: false, reason });
    const res = mockRes();
    await (redriveCascade as Handler)(sysadmin({ params: { id: leg.id } }), res);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('400s an unknown body field', async () => {
    const res = mockRes();
    await (redriveCascade as Handler)(sysadmin({ params: { id: leg.id }, body: { attempts: 0 } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockRedrive).not.toHaveBeenCalled();
  });

  it('403s a tenant admin (re-checks orgs:manage)', async () => {
    const res = mockRes();
    await (redriveCascade as Handler)(orgAdmin({ params: { id: leg.id } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockRedrive).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
