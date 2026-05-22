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

const mockUserFindById = jest.fn();
const mockAudit = jest.fn();
const mockIssueStepUpToken = jest.fn();

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  sendError: (res: any, status: number, msg: string) => {
    res.status(status).json({ success: false, message: msg });
  },
  sendSuccess: (res: any, status: number, data: unknown) => {
    res.status(status).json({ success: true, statusCode: status, data });
  },
  SYSTEM_ORG_ID: 'system',
}));

jest.mock('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  return { Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

jest.mock('../src/helpers/audit', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));

jest.mock('../src/helpers/controller-helper', () => ({
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => fn(req, res),
}));

jest.mock('../src/utils/token', () => ({
  issueStepUpToken: (...a: unknown[]) => mockIssueStepUpToken(...a),
}));

jest.mock('../src/models', () => ({
  User: {
    findById: (...a: unknown[]) => mockUserFindById(...a),
  },
}));

import { stepUpVerify } from '../src/controllers/step-up';

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
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    const req: any = { body: { password: 'p' }, user: { sub: 'u1' } };
    const res = mockRes();
    await (stepUpVerify as unknown as (req: any, res: any) => Promise<void>)(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('audits and returns 401 on bad password', async () => {
    const user = { comparePassword: jest.fn().mockResolvedValue(false), email: 'a@b' };
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
    const req: any = { body: { password: 'wrong' }, user: { sub: 'u1' } };
    const res = mockRes();
    await (stepUpVerify as unknown as (req: any, res: any) => Promise<void>)(req, res);
    expect(mockAudit).toHaveBeenCalledWith(
      req,
      'user.login.failed',
      expect.objectContaining({ targetType: 'step-up', targetId: 'u1' }),
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('issues a token and returns it on good password', async () => {
    const user = { comparePassword: jest.fn().mockResolvedValue(true), email: 'a@b' };
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
    mockIssueStepUpToken.mockReturnValue({ token: 'jwt.token.here', expiresAt: 1700000000 });

    const req: any = { body: { password: 'right' }, user: { sub: 'u1' } };
    const res = mockRes();
    await (stepUpVerify as unknown as (req: any, res: any) => Promise<void>)(req, res);

    expect(mockIssueStepUpToken).toHaveBeenCalledWith('u1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ok: true, stepUpToken: 'jwt.token.here', expiresAt: 1700000000 }),
    }));
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
