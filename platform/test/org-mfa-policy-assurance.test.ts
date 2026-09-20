// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Assurance on the two org SECURITY-POLICY writes is DIRECTIONAL:
 *   - loosening (MFA requirement off, admin-actions policy off, "our IdP
 *     enforces MFA" on; impersonation mode less strict, self-approval on) needs
 *     an `aal: 2` session;
 *   - tightening stays open to a single-factor admin, so someone without MFA can
 *     still adopt it for their org.
 * And changing the admin-actions policy refreshes every affected session, so
 * the `org_admin_aal` claim can't lag the policy.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));
const mockRefresh = jest.fn(async () => 3);
let before: Record<string, unknown> = {};
let effective: Record<string, unknown> = {};

/** Mirrors api-core's refusal for a weak session (the rule itself has its own suite). */
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
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ getOrgName: async () => undefined }));
jest.unstable_mockModule('../src/helpers/bootstrap-admin.js', () => ({ isBootstrapExceptionOpen: async () => false }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { passwordMinLength: 8 } } }));
jest.unstable_mockModule('../src/services/admin-mfa-claims.js', () => ({
  refreshAdminPolicyClaims: (...a: unknown[]) => (mockRefresh as any)(...a),
}));
jest.unstable_mockModule('../src/helpers/mfa-policy.js', () => ({
  DEFAULT_MFA_GRACE_DAYS: 14,
  MAX_MFA_GRACE_DAYS: 90,
  resolveEffectiveMfaPolicy: async () => effective,
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    findById: () => ({ select: () => ({ lean: async () => before }) }),
    updateOne: (...a: unknown[]) => (mockUpdateOne as any)(...a),
  },
  User: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

const { updateMfaPolicy, isLoosening } = await import('../src/controllers/org-mfa-policy.js');

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}

/**
 * `controller-helper` runs FOR REAL, so the caller's authority lives in the
 * FIXTURE: `canAdministerOrg` needs an admin/owner of the exact org the route
 * targets. Pass `user: null` for an anonymous caller.
 */
const ORG_ADMIN = (aal: 1 | 2) => ({ sub: 'actor', organizationId: 'org1', role: 'admin', aal });

async function patch(body: Record<string, unknown>, aal: 1 | 2, user: unknown = ORG_ADMIN(aal)) {
  const res = makeRes();
  await updateMfaPolicy({ user, params: { id: 'org1' }, body } as any, res, jest.fn() as any);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  before = { requireMfa: false, idpEnforcesMfa: false, adminActionsRequireMfa: false };
  effective = { requireMfa: false, enforced: false, own: false, idpEnforcesMfa: false, adminActionsRequireMfa: false, adminActionsOwn: false };
});

describe('isLoosening', () => {
  it.each([
    [{ requireMfa: true }, { requireMfa: false }, true],
    [{ requireMfa: false }, { requireMfa: true }, false],
    [{ adminActionsRequireMfa: true }, { adminActionsRequireMfa: false }, true],
    [{}, { adminActionsRequireMfa: true }, false],
    [{}, { idpEnforcesMfa: true }, true],
    [{ idpEnforcesMfa: true }, { idpEnforcesMfa: false }, false],
    [{ requireMfa: true }, { requireMfa: true }, false],
  ])('%j → %j loosens: %s', (from, to, expected) => {
    expect(isLoosening(from, to)).toBe(expected);
  });
});

describe('PATCH /organization/:id/mfa-policy — directional assurance', () => {
  it('refuses an anonymous caller with 401, and writes nothing', async () => {
    const res = await patch({ requireMfa: true }, 1, null);
    expect(res._status).toBe(401);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('refuses a plain MEMBER of the org with 403, and writes nothing', async () => {
    // No `role` → `isOrgAdmin` is false → `canAdministerOrg` refuses.
    const res = await patch({ requireMfa: true }, 2, { sub: 'member', organizationId: 'org1', aal: 2 });
    expect(res._status).toBe(403);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('lets a single-factor admin TURN ON the requirement', async () => {
    const res = await patch({ requireMfa: true }, 1);
    expect(res._status).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalled();
  });

  it('refuses a single-factor admin TURNING IT OFF, and writes nothing', async () => {
    before = { requireMfa: true };
    const res = await patch({ requireMfa: false }, 1);
    expect(res._status).toBe(401);
    expect(res._body.code).toBe('MFA_REQUIRED');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('lets an aal-2 admin turn it off', async () => {
    before = { requireMfa: true };
    expect((await patch({ requireMfa: false }, 2))._status).toBe(200);
  });

  it('treats "our IdP enforces MFA" as loosening', async () => {
    expect((await patch({ idpEnforcesMfa: true }, 1))._status).toBe(401);
    expect((await patch({ idpEnforcesMfa: true }, 2))._status).toBe(200);
  });
});

describe('PATCH /organization/:id/mfa-policy — administrative actions require MFA', () => {
  it('turns ON at aal 1, refreshes every other member\'s session, and audits the transition', async () => {
    effective = { ...effective, adminActionsRequireMfa: true, adminActionsOwn: true };
    const res = await patch({ adminActionsRequireMfa: true }, 1);
    expect(res._status).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'org1' }, { $set: { adminActionsRequireMfa: true } });
    expect(mockRefresh).toHaveBeenCalledWith('org1', 'actor');
    expect(res._body.data).toMatchObject({ adminActionsRequireMfa: true, adminActionsOwn: true, sessionsRefreshed: 3 });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.mfa_policy.update', expect.objectContaining({
      details: expect.objectContaining({ adminActionsRequireMfa: { from: false, to: true }, sessionsRefreshed: 3 }),
    }));
  });

  it('refuses turning it OFF from a single-factor session', async () => {
    before = { adminActionsRequireMfa: true };
    const res = await patch({ adminActionsRequireMfa: false }, 1);
    expect(res._status).toBe(401);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('turns OFF at aal 2 without signing anyone out (a stale token is only stricter; it lapses at refresh)', async () => {
    before = { adminActionsRequireMfa: true };
    expect((await patch({ adminActionsRequireMfa: false }, 2))._status).toBe(200);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does not sign anyone out when the setting did not change', async () => {
    before = { adminActionsRequireMfa: true };
    effective = { ...effective, adminActionsRequireMfa: true, adminActionsOwn: true };
    await patch({ adminActionsRequireMfa: true }, 1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('reports an inherited admin-actions policy with the parent\'s id', async () => {
    effective = { ...effective, adminActionsRequireMfa: true, adminActionsOwn: false, adminActionsInheritedFrom: 'root' };
    const res = await patch({ requireMfa: true }, 1);
    expect(res._body.data).toMatchObject({ adminActionsRequireMfa: true, adminActionsOwn: false, adminActionsInheritedFrom: 'root' });
  });
});
