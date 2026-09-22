// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Loosening the impersonation policy needs an `aal: 2` session; tightening it
 * does not. "Loosening" is a less strict mode (open < consent < denied) or
 * turning self-approval on — either widens who can see the org's data. The real
 * resolver is used, so an absent stored field is judged by its real default.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUpdate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
let before: Record<string, unknown> = {};

const refuseWeakSession = jest.fn((req: any, res: any) => {
  if ((req.user?.aal ?? 1) >= 2) return false;
  res.status(401).json({ success: false, code: 'MFA_REQUIRED' });
  return true;
});

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, string>, key: string) => params[key],
  sendError: (res: any, status: number, msg: string, code?: string) => res.status(status).json({ success: false, message: msg, code }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  refuseWeakSession: (...a: unknown[]) => (refuseWeakSession as any)(...a),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn<AnyFn>() }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
// `canAdministerOrg` lazily imports org-hierarchy on the CROSS-org branch, so
// `isAncestorOrg` has to exist here too (a flat tree: nobody is anyone's
// ancestor) — otherwise the cross-org case throws instead of being refused.
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  getOrgName: async () => undefined,
  isAncestorOrg: async () => false,
}));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { passwordMinLength: 8 } } }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    findById: () => ({ select: () => ({ lean: async () => before }) }),
    findByIdAndUpdate: (...a: unknown[]) => ({ lean: async () => { await mockUpdate(...a); return { ...before, ...(a[1] as { $set: object }).$set }; } }),
  },
  User: { countDocuments: async () => 3 },
}));

const { updateImpersonationPolicy, isLooseningImpersonation } = await import('../src/controllers/org-impersonation-policy.js');

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}

/**
 * The route is `canAdministerOrg`-gated and that gate runs FOR REAL (see
 * helpers/controller-helper-mock.ts): it reads `req.user.role` via `isOrgAdmin`
 * and compares `req.user.organizationId` with the `:id` param. Authority is
 * therefore carried by the FIXTURE — `role: 'admin'` over the caller's own org
 * — not by stubbing the gate. `user` is overridable so the negative case below
 * can send a caller the gate must refuse.
 */
async function patch(body: Record<string, unknown>, aal: 1 | 2, user?: Record<string, unknown>) {
  const res = makeRes();
  await updateImpersonationPolicy(
    { user: user ?? { sub: 'actor', organizationId: 'org1', role: 'admin', aal }, params: { id: 'org1' }, body } as any,
    res,
  );
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdate.mockResolvedValue(undefined);
  before = { impersonationPolicy: 'consent', allowSelfApproval: false };
});

describe('isLooseningImpersonation', () => {
  it.each([
    ['consent', 'open', false, false, true],
    ['denied', 'consent', false, false, true],
    ['open', 'consent', false, false, false],
    ['consent', 'denied', false, false, false],
    ['consent', 'consent', false, true, true],
    ['consent', 'consent', true, false, false],
  ] as const)('%s → %s (self-approval %s → %s) loosens: %s', (fromMode, toMode, fromSelf, toSelf, expected) => {
    expect(isLooseningImpersonation(
      { policy: fromMode, allowSelfApproval: fromSelf },
      { policy: toMode, allowSelfApproval: toSelf },
    )).toBe(expected);
  });
});

describe('PATCH /organization/:id/impersonation-policy', () => {
  it('lets a single-factor admin TIGHTEN (consent → denied)', async () => {
    expect((await patch({ impersonationPolicy: 'denied' }, 1))._status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('refuses a single-factor admin LOOSENING (consent → open), and writes nothing', async () => {
    const res = await patch({ impersonationPolicy: 'open' }, 1);
    expect(res._status).toBe(401);
    expect(res._body.code).toBe('MFA_REQUIRED');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses turning self-approval ON from a single-factor session', async () => {
    expect((await patch({ allowSelfApproval: true }, 1))._status).toBe(401);
  });

  it('lets an aal-2 admin loosen', async () => {
    expect((await patch({ impersonationPolicy: 'open', allowSelfApproval: true }, 2))._status).toBe(200);
  });

  // Negative: the tenancy/role gate itself, not the assurance gate. A plain
  // MEMBER of the very same org holds no `admin`/`owner` role, so
  // `canAdministerOrg` refuses before any assurance check and nothing is
  // written — even for a TIGHTENING change an admin would be allowed to make.
  it('403s a non-admin member of the same org, and writes nothing', async () => {
    const res = await patch({ impersonationPolicy: 'denied' }, 2, { sub: 'member', organizationId: 'org1', role: 'member', aal: 2 });
    expect(res._status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(refuseWeakSession).not.toHaveBeenCalled();
  });

  // Negative: an admin of a DIFFERENT org gets no reach into org1.
  it('403s an admin of an unrelated org', async () => {
    const res = await patch({ impersonationPolicy: 'denied' }, 2, { sub: 'other', organizationId: 'org2', role: 'admin', aal: 2 });
    expect(res._status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
