// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for GET /api/admin/summary. The endpoint stitches together five
 * cheap Mongo counts + two env-derived flags into one response — the
 * mistakes that hurt are passing the wrong filter to a count() or
 * forgetting to lowercase the env values.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockOrgCount = jest.fn();
const mockUserCount = jest.fn();
const mockIdpCount = jest.fn();
const mockRequireSystemAdmin = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));

jest.unstable_mockModule('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  return { Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => fn(req, res),
  requireSystemAdmin: (req: any, res: any) => mockRequireSystemAdmin(req, res),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { countDocuments: (...a: unknown[]) => mockOrgCount(...a) },
  User: { countDocuments: (...a: unknown[]) => mockUserCount(...a) },
}));

jest.unstable_mockModule('../src/models/org-idp-config.js', () => ({
  __esModule: true,
  default: { countDocuments: (...a: unknown[]) => mockIdpCount(...a) },
}));

const { getAdminSummary } = await import('../src/controllers/admin-summary.js');


function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockOrgCount.mockReset();
  mockUserCount.mockReset();
  mockIdpCount.mockReset();
  mockRequireSystemAdmin.mockReset();
  delete process.env.SECRET_ENCRYPTION_PER_ORG_KMS;
  delete process.env.RLS_CONTEXT_MODE;
});

describe('getAdminSummary', () => {
  it('returns 403 path when not a sysadmin (delegates to requireSystemAdmin)', async () => {
    mockRequireSystemAdmin.mockImplementation((_req: any, res: any) => {
      res.status(403).json({ success: false, message: 'Forbidden' });
      return false;
    });
    const res = mockRes();
    await (getAdminSummary as unknown as (req: any, res: any) => Promise<void>)({}, res);
    expect(mockOrgCount).not.toHaveBeenCalled();
    expect(mockUserCount).not.toHaveBeenCalled();
  });

  it('returns aggregated counts when sysadmin', async () => {
    mockRequireSystemAdmin.mockReturnValue(true);
    // Counts in argument order they're awaited in Promise.all:
    //   org total, sysadmin count, perOrgKms count, idp enabled count, total users
    mockOrgCount
      .mockResolvedValueOnce(42) // org total
      .mockResolvedValueOnce(7); // perOrgKms
    mockUserCount
      .mockResolvedValueOnce(3) // sysadmin count
      .mockResolvedValueOnce(120); // total users
    mockIdpCount.mockResolvedValueOnce(5);

    const res = mockRes();
    await (getAdminSummary as unknown as (req: any, res: any) => Promise<void>)({}, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        orgs: { total: 42, perOrgKms: 7, ssoEnabled: 5 },
        users: { total: 120, sysadmins: 3 },
        encryption: { perOrgKmsEnabled: false },
        rls: { contextMode: 'warn' },
      },
    }));
  });

  it('queries Mongo with the indexed filters', async () => {
    mockRequireSystemAdmin.mockReturnValue(true);
    mockOrgCount.mockResolvedValue(0);
    mockUserCount.mockResolvedValue(0);
    mockIdpCount.mockResolvedValue(0);

    await (getAdminSummary as unknown as (req: any, res: any) => Promise<void>)({}, mockRes());

    expect(mockOrgCount).toHaveBeenNthCalledWith(1, {});
    expect(mockOrgCount).toHaveBeenNthCalledWith(2, { 'kmsConfig.keyId': { $exists: true, $ne: null } });
    expect(mockUserCount).toHaveBeenNthCalledWith(1, { isSuperAdmin: true });
    expect(mockUserCount).toHaveBeenNthCalledWith(2, {});
    expect(mockIdpCount).toHaveBeenCalledWith({ enabled: true });
  });

  it('reflects SECRET_ENCRYPTION_PER_ORG_KMS=true', async () => {
    mockRequireSystemAdmin.mockReturnValue(true);
    mockOrgCount.mockResolvedValue(0);
    mockUserCount.mockResolvedValue(0);
    mockIdpCount.mockResolvedValue(0);
    process.env.SECRET_ENCRYPTION_PER_ORG_KMS = 'TRUE';

    const res = mockRes();
    await (getAdminSummary as unknown as (req: any, res: any) => Promise<void>)({}, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ encryption: { perOrgKmsEnabled: true } }),
    }));
  });

  it('reflects RLS_CONTEXT_MODE=strict (case-insensitive)', async () => {
    mockRequireSystemAdmin.mockReturnValue(true);
    mockOrgCount.mockResolvedValue(0);
    mockUserCount.mockResolvedValue(0);
    mockIdpCount.mockResolvedValue(0);
    process.env.RLS_CONTEXT_MODE = 'STRICT';

    const res = mockRes();
    await (getAdminSummary as unknown as (req: any, res: any) => Promise<void>)({}, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ rls: { contextMode: 'strict' } }),
    }));
  });
});
