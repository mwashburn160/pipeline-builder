// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireAuth` PAT branch (middleware/auth.ts) — a Personal Access Token's
 * authority is decoupled from `tokenVersion`, so soft-deleting its org (which
 * bumps tokenVersion to cut interactive sessions) does NOT reach it. This test
 * pins the read-path guard: a PAT scoped to a SOFT-DELETED (or missing) org is
 * rejected 401, while a PAT scoped to a LIVE org still authenticates.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockVerifyAccessToken = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockPatFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockPatUpdateOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUOFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string) =>
    res.status(status).json({ success: false, message: msg, code }),
}));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  toOrgId: (v: unknown) => v,
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  UserOrganization: { findOne: (...a: unknown[]) => mockUOFindOne(...a) },
  PersonalAccessToken: {
    findOne: (...a: unknown[]) => mockPatFindOne(...a),
    updateOne: (...a: unknown[]) => mockPatUpdateOne(...a),
  },
}));

jest.unstable_mockModule('../src/utils/index.js', () => ({
  verifyAccessToken: (...a: unknown[]) => mockVerifyAccessToken(...a),
  verifyRefreshToken: jest.fn(),
  hashRefreshToken: jest.fn(),
}));

const { requireAuth } = await import('../src/middleware/auth.js');

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** findById(id).select(...).lean() → doc. */
function selectLean(doc: unknown) {
  return { select: () => ({ lean: () => Promise.resolve(doc) }) };
}
/** findOne(...).select(...).lean() → doc. */
function findOneSelectLean(doc: unknown) {
  return { select: () => ({ lean: () => Promise.resolve(doc) }) };
}

const PAT_DECODED = {
  type: 'access',
  sub: 'user-1',
  jti: 'jti-1',
  organizationId: 'org-9',
  username: 'u',
  email: 'e@x.com',
  role: 'admin',
  permissions: [],
  isSuperAdmin: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyAccessToken.mockReturnValue(PAT_DECODED);
  mockUserFindById.mockReturnValue(selectLean({ _id: 'user-1', tokenVersion: 1, isSuperAdmin: false }));
  mockPatFindOne.mockReturnValue(findOneSelectLean({ revoked: false, expiresAt: null, lastUsedAt: new Date() }));
  mockUOFindOne.mockReturnValue(findOneSelectLean({ _id: 'm1' }));
  mockPatUpdateOne.mockReturnValue({ catch: () => undefined });
});

describe('requireAuth PAT branch — org soft-delete', () => {
  it('authenticates a PAT whose org is LIVE (baseline)', async () => {
    mockOrgFindById.mockReturnValue(selectLean({ deletedAt: null }));
    const next = jest.fn();
    const req: any = { headers: { authorization: 'Bearer pat-token' } };
    const res = makeRes();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({ sub: 'user-1', jti: 'jti-1' });
  });

  it('rejects (401) a PAT whose org has been SOFT-DELETED', async () => {
    mockOrgFindById.mockReturnValue(selectLean({ deletedAt: new Date() }));
    const next = jest.fn();
    const res = makeRes();

    await requireAuth({ headers: { authorization: 'Bearer pat-token' } } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Token authority revoked' }));
  });

  it('rejects (401) a PAT whose org no longer exists (hard-purged)', async () => {
    mockOrgFindById.mockReturnValue(selectLean(null));
    const next = jest.fn();
    const res = makeRes();

    await requireAuth({ headers: { authorization: 'Bearer pat-token' } } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
