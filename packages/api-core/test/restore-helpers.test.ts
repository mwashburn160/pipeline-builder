// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared `loadAndRestore` restore-route skeleton
 * (src/helpers/restore-helpers.ts). The api service restore-route tests mock
 * this helper, so this is the ONE place its branches are exercised directly.
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import type { Request, Response } from 'express';
import { loadAndPurge, loadAndRestore, type RestorableService } from '../src/helpers/restore-helpers.js';

beforeAll(() => { process.env.JWT_SECRET = 'test'; });

interface Row { orgId: string; visibility?: string; name?: string; createdBy?: string }

function mockReq(params: Record<string, string>, user?: Record<string, unknown>): Request {
  return { params, user } as unknown as Request;
}
function mockRes(): Response & { _status: number; _json: { code?: string } } {
  const res = {
    _status: 0,
    _json: {} as { code?: string },
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._json = body as { code?: string }; return res; },
  };
  return res as unknown as Response & { _status: number; _json: { code?: string } };
}

/** A stub service whose findDeletedById/restore return the queued values. */
function stubService(existing: Row | null, restored: Row | null) {
  const findDeletedById = jest.fn<RestorableService<Row>['findDeletedById']>().mockResolvedValue(existing);
  const restore = jest.fn<RestorableService<Row>['restore']>().mockResolvedValue(restored);
  return { findDeletedById, restore };
}

describe('loadAndRestore', () => {
  it('400 + null when the id is missing', async () => {
    const res = mockRes();
    const svc = stubService(null, null);
    const out = await loadAndRestore(mockReq({}), res, svc, { orgId: 'org1', userId: 'u1', label: 'Pipeline', publishPermission: 'pipelines:publish' });
    expect(out).toBeNull();
    expect(res._status).toBe(400);
    expect(svc.findDeletedById).not.toHaveBeenCalled();
  });

  it('404 + null when the tombstone does not exist', async () => {
    const res = mockRes();
    const svc = stubService(null, null);
    const out = await loadAndRestore(mockReq({ id: 'x' }), res, svc, { orgId: 'org1', userId: 'u1', label: 'Pipeline', publishPermission: 'pipelines:publish' });
    expect(out).toBeNull();
    expect(res._status).toBe(404);
    expect(svc.restore).not.toHaveBeenCalled();
  });

  it('restores the AUTHOR\'s own PRIVATE tombstone (no publish gate) and returns { existing, restored }', async () => {
    const existing = { orgId: 'org1', visibility: 'private', createdBy: 'u1', name: 'p' };
    const restored = { orgId: 'org1', visibility: 'private', createdBy: 'u1', name: 'p' };
    const res = mockRes();
    const svc = stubService(existing, restored);
    const out = await loadAndRestore(mockReq({ id: 'p1' }, { sub: 'u1' }), res, svc, { orgId: 'org1', userId: 'u1', label: 'Pipeline', publishPermission: 'pipelines:publish' });
    expect(out).toEqual({ existing, restored });
    expect(svc.restore).toHaveBeenCalledWith('p1', 'org1', 'u1');
    expect(res._status).toBe(0);
  });

  it('denies a non-publisher restoring a PUBLIC tombstone (403 + null, no restore)', async () => {
    const res = mockRes();
    // user: not sysadmin, no pipelines:publish permission.
    const svc = stubService({ orgId: 'org1', visibility: 'public', name: 'p' }, null);
    const out = await loadAndRestore(mockReq({ id: 'p1' }, { sub: 'u1', permissions: [] }), res, svc, { orgId: 'org1', userId: 'u1', label: 'Pipeline', publishPermission: 'pipelines:publish' });
    expect(out).toBeNull();
    expect(res._status).toBe(403);
    expect(svc.restore).not.toHaveBeenCalled();
  });

  it('denies a COLLEAGUE restoring someone else\'s private tombstone (403 + null)', async () => {
    // Load-bearing: the tombstone load is org-scoped, not visibility-scoped
    // (soft-delete is one shared code path), so this gate is the only thing
    // stopping any org member from resurrecting another user's personal draft.
    const res = mockRes();
    const svc = stubService({ orgId: 'org1', visibility: 'private', createdBy: 'author', name: 'p' }, null);
    const out = await loadAndRestore(mockReq({ id: 'p1' }, { sub: 'u2', permissions: [] }), res, svc, { orgId: 'org1', userId: 'u2', label: 'Pipeline', publishPermission: 'pipelines:publish' });
    expect(out).toBeNull();
    expect(res._status).toBe(403);
    expect(svc.restore).not.toHaveBeenCalled();
  });

  it('denies an author-less private tombstone outright (fails closed)', async () => {
    // No `createdBy` means nobody can claim authorship — an empty userId must
    // never match an empty author and hand the row over.
    const res = mockRes();
    const svc = stubService({ orgId: 'org1', visibility: 'private', name: 'p' }, null);
    const out = await loadAndRestore(mockReq({ id: 'p1' }, { sub: 'u1', permissions: [] }), res, svc, { orgId: 'org1', userId: 'u1', label: 'Pipeline', publishPermission: 'pipelines:publish' });
    expect(out).toBeNull();
    expect(res._status).toBe(403);
  });

  it('lets ANY org member restore an `org` tombstone (the ladder\'s middle rung)', async () => {
    const existing = { orgId: 'org1', visibility: 'org', createdBy: 'author', name: 'p' };
    const res = mockRes();
    const svc = stubService(existing, existing);
    const out = await loadAndRestore(mockReq({ id: 'p1' }, { sub: 'u2', permissions: [] }), res, svc, { orgId: 'org1', userId: 'u2', label: 'Pipeline', publishPermission: 'pipelines:publish' });
    expect(out).toEqual({ existing, restored: existing });
    expect(res._status).toBe(0);
  });

  it('404 + null when restore matches no row', async () => {
    const res = mockRes();
    const svc = stubService({ orgId: 'org1', visibility: 'private', createdBy: 'u1' }, null);
    const out = await loadAndRestore(mockReq({ id: 'p1' }, { sub: 'u1' }), res, svc, { orgId: 'org1', userId: 'u1', label: 'Pipeline', publishPermission: 'pipelines:publish' });
    expect(out).toBeNull();
    expect(res._status).toBe(404);
    expect(svc.restore).toHaveBeenCalled();
  });
});

describe('loadAndRestore / loadAndPurge — custom authorization + scope', () => {
  it('a custom authorizer replaces the visibility ladder and can refuse', async () => {
    const svc = stubService({ orgId: 'org1', visibility: 'private', createdBy: 'someone-else' }, { orgId: 'org1' });
    const res = mockRes();
    const authorize = jest.fn(() => true);
    const out = await loadAndRestore(mockReq({ id: 'p1' }, { sub: 'u1', permissions: [] }), res, svc, { orgId: 'org1', userId: 'u1', label: 'Message', authorize });
    expect(out).not.toBeNull();
    expect(authorize).toHaveBeenCalledTimes(1);

    const refused = await loadAndRestore(mockReq({ id: 'p1' }), mockRes(), svc, { orgId: 'org1', userId: 'u1', label: 'Message', authorize: () => false });
    expect(refused).toBeNull();
    expect(svc.restore).toHaveBeenCalledTimes(1);
  });

  it('an undefined scopeOrgId spans orgs (load unpinned, mutation with an empty org)', async () => {
    const svc = stubService({ orgId: 'other' }, { orgId: 'other' });
    await loadAndRestore(mockReq({ id: 'p1' }), mockRes(), svc, { orgId: 'org1', userId: 'u1', label: 'Message', scopeOrgId: undefined, authorize: () => true });
    expect(svc.findDeletedById).toHaveBeenCalledWith('p1', undefined);
    expect(svc.restore).toHaveBeenCalledWith('p1', '', 'u1');
  });

  it('purge hard-deletes an authorized tombstone and 404s on a race', async () => {
    const findDeletedById = jest.fn<(id: string, orgId?: string) => Promise<Row | null>>().mockResolvedValue({ orgId: 'org1' });
    const purgeById = jest.fn<(id: string, orgId?: string) => Promise<string | null>>().mockResolvedValueOnce('p1').mockResolvedValueOnce(null);
    const opts = { orgId: 'org1', userId: 'u1', label: 'Rule', authorize: () => true };
    expect(await loadAndPurge(mockReq({ id: 'p1' }), mockRes(), { findDeletedById, purgeById }, opts)).toEqual({ existing: { orgId: 'org1' }, purgedId: 'p1' });
    expect(purgeById).toHaveBeenCalledWith('p1', 'org1');
    const res = mockRes();
    expect(await loadAndPurge(mockReq({ id: 'p1' }), res, { findDeletedById, purgeById }, opts)).toBeNull();
    expect(res._status).toBe(404);
  });
});
