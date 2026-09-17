// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * authorizeOrg against the REAL api-core auth gate (no api-core mock): a denied
 * system-admin-only mutation must reach the shared `authz.denied` auditor that
 * `wireServiceSecurity` registers at boot. The previous hand-rolled 403 skipped
 * the auditor, so probes of the admin-only quota routes left no audit trail.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { setAuthzDenialAuditor } from '@pipeline-builder/api-core';
import type { AuthzDenialInfo } from '@pipeline-builder/api-core';

const { authorizeOrg } = await import('../src/middleware/authorize-org.js');

function reqResNext(method: string, user: Record<string, unknown>, orgId = 'org-1') {
  const req = { method, user, params: { orgId }, originalUrl: `/quotas/${orgId}?x=1`, url: `/quotas/${orgId}` } as any;
  const res: any = { statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn(() => res);
  const next = jest.fn();
  return { req, res, next };
}

const denials: AuthzDenialInfo[] = [];

beforeEach(() => {
  denials.length = 0;
  setAuthzDenialAuditor((info) => { denials.push(info); });
});

afterAll(() => setAuthzDenialAuditor(undefined));

describe('authorizeOrg({ requireSystemAdmin: true }) — audited denials', () => {
  const middleware = authorizeOrg({ requireSystemAdmin: true });

  it('403s a non-admin mutation AND emits an authz.denied record', () => {
    const { req, res, next } = reqResNext('PUT', { sub: 'u1', email: 'u@x.io', organizationId: 'org-1' });
    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(denials).toEqual([
      expect.objectContaining({ actorId: 'u1', orgId: 'org-1', method: 'PUT', path: '/quotas/org-1', required: 'system-admin' }),
    ]);
  });

  it('403s (and audits) a cross-org non-admin DELETE', () => {
    const { req, res, next } = reqResNext('DELETE', { sub: 'u2', organizationId: 'org-2' });
    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(denials).toEqual([expect.objectContaining({ actorId: 'u2', method: 'DELETE', required: 'system-admin' })]);
  });

  it('still 401s an unauthenticated request before the admin gate', () => {
    const { req, res, next } = reqResNext('PUT', undefined as unknown as Record<string, unknown>);
    middleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(denials).toHaveLength(0);
  });

  it('passes a superadmin without auditing', () => {
    const { req, res, next } = reqResNext('PUT', { sub: 'admin', organizationId: 'sys', isSuperAdmin: true });
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(denials).toHaveLength(0);
  });
});

describe('authorizeOrg() — audited cross-org denial', () => {
  const middleware = authorizeOrg();

  it("403s (and audits) a member mutating ANOTHER org's quota", () => {
    const { req, res, next } = reqResNext('POST', { sub: 'u3', organizationId: 'org-3' }, 'org-9');
    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(denials).toEqual([
      expect.objectContaining({ actorId: 'u3', orgId: 'org-3', method: 'POST', path: '/quotas/org-9', required: 'same-org or system-admin' }),
    ]);
  });

  it('passes same-org access without auditing', () => {
    const { req, res, next } = reqResNext('POST', { sub: 'u3', organizationId: 'org-3' }, 'org-3');
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(denials).toHaveLength(0);
  });
});
