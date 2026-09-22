// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the `stepUpVerify` controller (POST /api/auth/step-up).
 *
 * The controller's contract is: prove the caller's password, audit any
 * failure, and issue a short-lived token that destructive endpoints
 * require. All four branches matter — a bug in any of them either
 * weakens the auth check or stops legitimate flows.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockUserFindById = jest.fn<AnyFn>();
const mockAudit = jest.fn<AnyFn>();
const mockIssueStepUpToken = jest.fn<AnyFn>();
const mockIncCounter = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => {
    res.status(status).json({ success: false, message: msg });
  },
  sendSuccess: (res: any, status: number, data: unknown) => {
    res.status(status).json({ success: true, statusCode: status, data });
  },
}));

jest.unstable_mockModule('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  return { Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn<AnyFn>() };
});

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));

jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());

jest.unstable_mockModule('../src/services/session/membership-context.js', () => ({
  membershipForOrg: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/services/session/access-tokens.js', () => ({
  enforceOrgAssurance: async (_u: unknown, _m: unknown, a: unknown) => a,
  // Session-auth helpers the controllers now import (see utils/token.ts).
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  signApiKeyToken: jest.fn<AnyFn>(),
  signServiceAccountToken: jest.fn<AnyFn>(),
  issueStepUpToken: (...a: unknown[]) => mockIssueStepUpToken(...a),
}));
jest.unstable_mockModule('../src/services/session/refresh-sessions.js', () => ({
  hashRefreshToken: (t: string) => `h:${t}`,
  findRefreshSession: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  User: {
    findById: (...a: unknown[]) => mockUserFindById(...a),
  },
}));

const { stepUpVerify } = await import('../src/controllers/step-up.js');


function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockUserFindById.mockReset();
  mockAudit.mockReset();
  mockIssueStepUpToken.mockReset();
  mockIncCounter.mockReset();
});

describe('stepUpVerify', () => {
  it('returns 401 when no user on request', async () => {
    const req: any = { body: { password: 'x' }, user: undefined };
    const res = mockRes();
    await (stepUpVerify as unknown as (req: any, res: any) => Promise<void>)(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 400 when password missing or empty', async () => {
    const req: any = { body: { password: '' }, user: { sub: 'u1' } };
    const res = mockRes();
    await (stepUpVerify as unknown as (req: any, res: any) => Promise<void>)(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when password is non-string', async () => {
    const req: any = { body: { password: 123 }, user: { sub: 'u1' } };
    const res = mockRes();
    await (stepUpVerify as unknown as (req: any, res: any) => Promise<void>)(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 401 when the user is missing in Mongo', async () => {
    mockUserFindById.mockReturnValue({ select: jest.fn<AnyFn>().mockResolvedValue(null) });
    const req: any = { body: { password: 'p' }, user: { sub: 'u1' } };
    const res = mockRes();
    await (stepUpVerify as unknown as (req: any, res: any) => Promise<void>)(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('audits and returns 401 on bad password', async () => {
    const user = { comparePassword: jest.fn<AnyFn>().mockResolvedValue(false), email: 'a@b' };
    mockUserFindById.mockReturnValue({ select: jest.fn<AnyFn>().mockResolvedValue(user) });
    const req: any = { body: { password: 'wrong' }, user: { sub: 'u1' } };
    const res = mockRes();
    await (stepUpVerify as unknown as (req: any, res: any) => Promise<void>)(req, res);
    expect(mockAudit).toHaveBeenCalledWith(
      req,
      'user.login.failed',
      expect.objectContaining({
        targetType: 'step-up',
        targetId: 'u1',
        details: expect.objectContaining({ method: 'password' }),
      }),
    );
    expect(mockIncCounter).toHaveBeenCalledWith('platform_step_up_total', { method: 'password', outcome: 'failure' });
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('issues a token and returns it on good password', async () => {
    const user = { comparePassword: jest.fn<AnyFn>().mockResolvedValue(true), email: 'a@b' };
    mockUserFindById.mockReturnValue({ select: jest.fn<AnyFn>().mockResolvedValue(user) });
    mockIssueStepUpToken.mockReturnValue({ token: 'jwt.token.here', expiresAt: 1700000000 });

    const req: any = { body: { password: 'right' }, user: { sub: 'u1' } };
    const res = mockRes();
    await (stepUpVerify as unknown as (req: any, res: any) => Promise<void>)(req, res);

    expect(mockIssueStepUpToken).toHaveBeenCalledWith('u1', 'password');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ok: true, stepUpToken: 'jwt.token.here', expiresAt: 1700000000, method: 'password' }),
    }));
    // Success is audited too, carrying HOW the step-up was earned.
    expect(mockAudit).toHaveBeenCalledWith(
      req,
      'user.step-up',
      expect.objectContaining({ targetId: 'u1', details: { method: 'password' } }),
    );
    expect(mockIncCounter).toHaveBeenCalledWith('platform_step_up_total', { method: 'password', outcome: 'success' });
  });
});
