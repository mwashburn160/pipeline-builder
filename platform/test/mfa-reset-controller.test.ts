// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The HTTP half of MFA recovery (controllers/mfa-reset.ts): tenancy, input
 * validation, and that every step is audited under the REAL signed-in actor.
 * The two-person rule itself lives in the service and is exercised against a
 * real database in `mfa-reset.integration.test.ts`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockCanAdminister = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
const mockScope = jest.fn<(...a: unknown[]) => Promise<string[]>>(async () => ['root', 'team']);
const svc = {
  request: jest.fn<(...a: any[]) => Promise<any>>(),
  approve: jest.fn<(...a: any[]) => Promise<any>>(),
  deny: jest.fn<(...a: any[]) => Promise<any>>(),
  direct: jest.fn<(...a: any[]) => Promise<any>>(),
  get: jest.fn<(...a: any[]) => Promise<any>>(),
  list: jest.fn<(...a: any[]) => Promise<any>>(),
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, string>, key: string) => params[key],
  isSystemAdmin: (req: any) => req.user?.isSuperAdmin === true,
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireAuth: () => true,
  canAdministerOrg: (...a: unknown[]) => mockCanAdminister(...a),
  withController: (_label: string, fn: Function, map?: Record<string, { status: number; message: string; code?: string }>) =>
    async (req: any, res: any) => {
      try { await fn(req, res); } catch (err) {
        const mapped = map?.[(err as Error).message];
        if (mapped) res.status(mapped.status).json({ success: false, message: mapped.message, code: mapped.code });
        else throw err;
      }
    },
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ expandOrgScope: (...a: unknown[]) => mockScope(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { passwordMinLength: 8 } } }));
jest.unstable_mockModule('../src/services/mfa-recovery.js', () => ({
  MFA_RESET_ALREADY_PENDING: 'MFA_RESET_ALREADY_PENDING',
  MFA_RESET_EXPIRED: 'MFA_RESET_EXPIRED',
  MFA_RESET_GRACE_MAX_HOURS: 168,
  MFA_RESET_NOT_FOUND: 'MFA_RESET_NOT_FOUND',
  MFA_RESET_NOT_MEMBER: 'MFA_RESET_NOT_MEMBER',
  MFA_RESET_NOT_PENDING: 'MFA_RESET_NOT_PENDING',
  MFA_RESET_PLATFORM_ADMIN: 'MFA_RESET_PLATFORM_ADMIN',
  MFA_RESET_SECOND_PERSON_REQUIRED: 'MFA_RESET_SECOND_PERSON_REQUIRED',
  MFA_RESET_SELF: 'MFA_RESET_SELF',
  requestMfaReset: (...a: any[]) => svc.request(...a),
  approveMfaReset: (...a: any[]) => svc.approve(...a),
  denyMfaReset: (...a: any[]) => svc.deny(...a),
  directMfaReset: (...a: any[]) => svc.direct(...a),
  getMfaReset: (...a: any[]) => svc.get(...a),
  listMfaResets: (...a: any[]) => svc.list(...a),
}));

const ctrl = await import('../src/controllers/mfa-reset.js');

const TARGET = '651111111111111111111111';
const GRACE = new Date('2026-10-01T00:00:00.000Z');
const RESULT = { userId: TARGET, email: 'm@example.com', passkeysRemoved: 1, totpRemoved: true, recoveryCodesRemoved: true, tokenVersion: 4, graceUntil: GRACE };
const pending = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  organizationId: 'team',
  targetUserId: TARGET,
  targetEmail: 'm@example.com',
  requestedBy: 'admin1',
  requestedByEmail: 'a1@example.com',
  reason: 'Lost phone and laptop',
  status: 'pending',
  ...over,
});

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}
const call = async (handler: any, { params = {}, body = {}, user = {} }: { params?: any; body?: any; user?: any }) => {
  const res = makeRes();
  await handler({ params, body, headers: {}, user: { sub: 'admin2', email: 'a2@example.com', aal: 2, ...user } }, res, jest.fn());
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCanAdminister.mockResolvedValue(true);
  mockScope.mockResolvedValue(['root', 'team']);
});

describe('request', () => {
  it('files the request with the caller as requester, and audits it under the real actor', async () => {
    svc.request.mockResolvedValue(pending({ requestedBy: 'admin2', expiresAt: '2026-09-20T00:00:00.000Z' }));
    const res = await call(ctrl.requestMfaReset, { params: { id: 'team' }, body: { userId: TARGET, reason: 'Lost phone and laptop' } });
    expect(res._status).toBe(201);
    expect(svc.request).toHaveBeenCalledWith({
      organizationId: 'team',
      targetUserId: TARGET,
      reason: 'Lost phone and laptop',
      requester: { id: 'admin2', email: 'a2@example.com', isSuperAdmin: false },
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ sub: 'admin2' }) }),
      'auth.mfa.reset_requested', expect.objectContaining({ targetId: TARGET, affectedOrgId: 'team' }));
  });

  it('refuses a caller who does not administer the org', async () => {
    mockCanAdminister.mockResolvedValue(false);
    const res = await call(ctrl.requestMfaReset, { params: { id: 'team' }, body: { userId: TARGET, reason: 'Lost phone and laptop' } });
    expect(res._status).toBe(403);
    expect(svc.request).not.toHaveBeenCalled();
  });

  it('requires a real reason', async () => {
    const res = await call(ctrl.requestMfaReset, { params: { id: 'team' }, body: { userId: TARGET, reason: 'x' } });
    expect(res._status).toBe(400);
    expect(svc.request).not.toHaveBeenCalled();
  });

  it('maps the service refusals', async () => {
    svc.request.mockRejectedValue(new Error('MFA_RESET_ALREADY_PENDING'));
    const res = await call(ctrl.requestMfaReset, { params: { id: 'team' }, body: { userId: TARGET, reason: 'Lost phone and laptop' } });
    expect(res._status).toBe(409);
    expect(res._body.code).toBe('MFA_RESET_ALREADY_PENDING');
  });
});

describe('approve', () => {
  it('approves as the caller and audits the reset with the requester recorded separately', async () => {
    svc.get.mockResolvedValue(pending());
    svc.approve.mockResolvedValue({ request: pending({ status: 'approved', decidedBy: 'admin2' }), result: RESULT });
    const res = await call(ctrl.approveMfaReset, { params: { id: 'root', requestId: 'r1' }, body: { graceHours: 24 } });
    expect(res._status).toBe(200);
    expect(svc.approve).toHaveBeenCalledWith({ requestId: 'r1', approver: expect.objectContaining({ id: 'admin2' }), graceHours: 24 });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'auth.mfa.reset_approved', expect.objectContaining({
      targetId: TARGET,
      affectedOrgId: 'team',
      details: expect.objectContaining({ requestedBy: 'admin1', passkeysRemoved: 1, graceUntil: GRACE.toISOString(), approverIsSysadmin: false }),
    }));
  });

  it('checks tenancy against the REQUEST\'s org, not the URL\'s', async () => {
    svc.get.mockResolvedValue(pending({ organizationId: 'team' }));
    mockCanAdminister.mockImplementation(async (_req, orgId) => orgId !== 'team');
    const res = await call(ctrl.approveMfaReset, { params: { id: 'root', requestId: 'r1' } });
    expect(res._status).toBe(403);
    expect(svc.approve).not.toHaveBeenCalled();
  });

  it('404s a request outside the URL org\'s subtree', async () => {
    svc.get.mockResolvedValue(pending({ organizationId: 'elsewhere' }));
    const res = await call(ctrl.approveMfaReset, { params: { id: 'root', requestId: 'r1' } });
    expect(res._status).toBe(404);
    expect(svc.approve).not.toHaveBeenCalled();
  });

  it('refuses the second-person violation with its own code', async () => {
    svc.get.mockResolvedValue(pending());
    svc.approve.mockRejectedValue(new Error('MFA_RESET_SECOND_PERSON_REQUIRED'));
    const res = await call(ctrl.approveMfaReset, { params: { id: 'root', requestId: 'r1' } });
    expect(res._status).toBe(403);
    expect(res._body.code).toBe('MFA_RESET_SECOND_PERSON_REQUIRED');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('refuses a grace beyond the ceiling', async () => {
    const res = await call(ctrl.approveMfaReset, { params: { id: 'root', requestId: 'r1' }, body: { graceHours: 500 } });
    expect(res._status).toBe(400);
  });
});

describe('deny', () => {
  it('records a withdrawal when the requester denies their own request', async () => {
    svc.get.mockResolvedValue(pending({ requestedBy: 'admin2' }));
    svc.deny.mockResolvedValue(pending({ requestedBy: 'admin2', status: 'denied' }));
    await call(ctrl.denyMfaReset, { params: { id: 'team', requestId: 'r1' } });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'auth.mfa.reset_denied', expect.objectContaining({
      details: expect.objectContaining({ withdrawn: true }),
    }));
  });

  it('records a denial by another admin with its note', async () => {
    svc.get.mockResolvedValue(pending());
    svc.deny.mockResolvedValue(pending({ status: 'denied' }));
    await call(ctrl.denyMfaReset, { params: { id: 'team', requestId: 'r1' }, body: { note: 'Could not verify' } });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'auth.mfa.reset_denied', expect.objectContaining({
      details: expect.objectContaining({ withdrawn: false, note: 'Could not verify' }),
    }));
  });
});

describe('direct (sysadmin)', () => {
  it('resets with a reason and audits it as the single-person path', async () => {
    svc.direct.mockResolvedValue(RESULT);
    const res = await call(ctrl.directMfaReset, {
      params: { id: TARGET }, body: { reason: 'Only admin of a one-person org' }, user: { sub: 'sys', isSuperAdmin: true },
    });
    expect(res._status).toBe(200);
    expect(svc.direct).toHaveBeenCalledWith({ targetUserId: TARGET, actor: expect.objectContaining({ id: 'sys' }), graceHours: undefined });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'auth.mfa.direct_reset', expect.objectContaining({
      targetId: TARGET, details: expect.objectContaining({ direct: true, reason: 'Only admin of a one-person org' }),
    }));
  });

  it('requires a reason', async () => {
    const res = await call(ctrl.directMfaReset, { params: { id: TARGET }, body: {}, user: { sub: 'sys', isSuperAdmin: true } });
    expect(res._status).toBe(400);
    expect(svc.direct).not.toHaveBeenCalled();
  });
});

describe('list', () => {
  it('lists requests across the org and its teams', async () => {
    svc.list.mockResolvedValue([pending()]);
    const res = await call(ctrl.listMfaResets, { params: { id: 'root' } });
    expect(svc.list).toHaveBeenCalledWith(['root', 'team']);
    expect(res._body.data.requests).toHaveLength(1);
  });
});
