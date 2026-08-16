// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared `loadAndRestore` restore-route skeleton
 * (src/helpers/restore-helpers.ts). The api service restore-route tests mock
 * this helper, so this is the ONE place its branches are exercised directly.
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import type { Request, Response } from 'express';
import { loadAndRestore, type RestorableService } from '../src/helpers/restore-helpers.js';

beforeAll(() => { process.env.JWT_SECRET = 'test'; });

interface Row { orgId: string; accessModifier?: string; name?: string }

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
    const out = await loadAndRestore(mockReq({}), res, 'org1', 'u1', svc, 'Pipeline', 'pipelines:publish');
    expect(out).toBeNull();
    expect(res._status).toBe(400);
    expect(svc.findDeletedById).not.toHaveBeenCalled();
  });

  it('404 + null when the tombstone does not exist', async () => {
    const res = mockRes();
    const svc = stubService(null, null);
    const out = await loadAndRestore(mockReq({ id: 'x' }), res, 'org1', 'u1', svc, 'Pipeline', 'pipelines:publish');
    expect(out).toBeNull();
    expect(res._status).toBe(404);
    expect(svc.restore).not.toHaveBeenCalled();
  });

  it('restores a PRIVATE tombstone (no publish gate) and returns { existing, restored }', async () => {
    const existing = { orgId: 'org1', accessModifier: 'private', name: 'p' };
    const restored = { orgId: 'org1', accessModifier: 'private', name: 'p' };
    const res = mockRes();
    const svc = stubService(existing, restored);
    const out = await loadAndRestore(mockReq({ id: 'p1' }, { sub: 'u1' }), res, 'org1', 'u1', svc, 'Pipeline', 'pipelines:publish');
    expect(out).toEqual({ existing, restored });
    expect(svc.restore).toHaveBeenCalledWith('p1', 'org1', 'u1');
    expect(res._status).toBe(0);
  });

  it('denies a non-publisher restoring a PUBLIC tombstone (403 + null, no restore)', async () => {
    const res = mockRes();
    // user: not sysadmin, no pipelines:publish permission.
    const svc = stubService({ orgId: 'org1', accessModifier: 'public', name: 'p' }, null);
    const out = await loadAndRestore(mockReq({ id: 'p1' }, { sub: 'u1', permissions: [] }), res, 'org1', 'u1', svc, 'Pipeline', 'pipelines:publish');
    expect(out).toBeNull();
    expect(res._status).toBe(403);
    expect(svc.restore).not.toHaveBeenCalled();
  });

  it('404 + null when restore matches no row', async () => {
    const res = mockRes();
    const svc = stubService({ orgId: 'org1', accessModifier: 'private' }, null);
    const out = await loadAndRestore(mockReq({ id: 'p1' }, { sub: 'u1' }), res, 'org1', 'u1', svc, 'Pipeline', 'pipelines:publish');
    expect(out).toBeNull();
    expect(res._status).toBe(404);
    expect(svc.restore).toHaveBeenCalled();
  });
});
