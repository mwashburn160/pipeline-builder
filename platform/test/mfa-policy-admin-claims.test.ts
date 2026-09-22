// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `PATCH /organization/:id/mfa-policy` — the `adminActionsRequireMfa` claim
 * refresh. TURNING IT ON ends member sessions at once (a stale single-factor
 * token must not keep acting as an admin). Turning it OFF does not: a stale
 * token is then only stricter than the policy and settles at its next refresh,
 * so relaxing a control never signs the whole org out.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRefreshClaims = jest.fn(async (..._a: unknown[]) => 4);
const mockFindById = jest.fn<(...a: unknown[]) => Promise<Record<string, unknown> | null>>();
const mockUpdateOne = jest.fn(async (..._a: unknown[]) => ({}));
const mockAudit = jest.fn();

jest.unstable_mockModule('../src/config/index.js', () => mockConfig());
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, string>, key: string) => params[key],
  refuseWeakSession: () => false,
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  updateMfaPolicySchema: {},
  validateBody: (_schema: unknown, body: unknown) => body,
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
// `canManageOrgScope` (real — see helpers/controller-helper-mock.ts) lazily
// imports this module on the CROSS-org branch, so `isAncestorOrg` must exist
// here too. Flat tree: nobody is anyone's ancestor, so only the same-org admin
// in the fixture below is admitted.
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  getOrgName: async () => undefined,
  isAncestorOrg: async () => false,
}));
jest.unstable_mockModule('../src/helpers/bootstrap-admin.js', () => ({ isBootstrapExceptionOpen: async () => false, bootstrapSuperAdminEmails: () => new Set<string>() }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: jest.fn() }));
jest.unstable_mockModule('../src/services/admin-mfa-claims.js', () => ({
  refreshAdminPolicyClaims: (...a: unknown[]) => mockRefreshClaims(...a),
}));
jest.unstable_mockModule('../src/helpers/mfa-policy.js', () => ({
  DEFAULT_MFA_GRACE_DAYS: 14,
  MAX_MFA_GRACE_DAYS: 90,
  resolveEffectiveMfaPolicy: async () => ({
    own: false, enforced: false, idpEnforcesMfa: false, adminActionsOwn: false, requireMfa: false,
  }),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    findById: (...a: unknown[]) => ({ select: () => ({ lean: () => mockFindById(...a) }) }),
    updateOne: (...a: unknown[]) => mockUpdateOne(...a),
    exists: async () => true,
  },
  User: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  UserOrganization: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  WebAuthnCredential: { distinct: async () => [] },
  UserTotp: { distinct: async () => [] },
}));

const { updateMfaPolicy } = await import('../src/controllers/org-mfa-policy.js');

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}
/**
 * The route is `canManageOrgScope`-gated and that gate runs FOR REAL: `role` is
 * what the real `isOrgAdmin` reads, and `organizationId` must match the `:id`
 * being edited. `user` is overridable so the negative cases can send a caller
 * the gate has to refuse.
 */
const ADMIN = { sub: 'admin-1', organizationId: 'org-1', role: 'admin' };

const req = (body: Record<string, unknown>, user: unknown = ADMIN) =>
  ({ user, params: { id: 'org-1' }, body }) as any;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('updateMfaPolicy — admin-actions claim refresh', () => {
  it('turning it ON refreshes member sessions now (excluding the saving admin)', async () => {
    mockFindById.mockResolvedValue({ adminActionsRequireMfa: false });
    const res = makeRes();
    await updateMfaPolicy(req({ adminActionsRequireMfa: true }), res);

    expect(res._status).toBe(200);
    expect(mockRefreshClaims).toHaveBeenCalledWith('org-1', 'admin-1');
    expect(res._body.data.sessionsRefreshed).toBe(4);
  });

  it('turning it OFF does not sign anyone out — stale tokens are only stricter', async () => {
    mockFindById.mockResolvedValue({ adminActionsRequireMfa: true });
    const res = makeRes();
    await updateMfaPolicy(req({ adminActionsRequireMfa: false }), res);

    expect(res._status).toBe(200);
    expect(mockRefreshClaims).not.toHaveBeenCalled();
    expect(res._body.data.sessionsRefreshed).toBe(0);
    // The change itself is still recorded, with both sides of the transition.
    const [, action, meta] = mockAudit.mock.calls[0] as [unknown, string, { details: Record<string, unknown> }];
    expect(action).toBe('org.mfa_policy.update');
    expect(meta.details.adminActionsRequireMfa).toEqual({ from: true, to: false });
  });

  it('an unchanged value refreshes nothing', async () => {
    mockFindById.mockResolvedValue({ adminActionsRequireMfa: true });
    await updateMfaPolicy(req({ adminActionsRequireMfa: true }), makeRes());
    expect(mockRefreshClaims).not.toHaveBeenCalled();
  });

  // Negative: the authority gate, not the claim-refresh logic. Nothing is
  // written, nothing is audited, and no session is touched.
  it.each([
    ['an anonymous caller', null, 401],
    ['an admin of an unrelated org', { sub: 'u3', organizationId: 'org-2', role: 'admin' }, 403],
  ] as const)('refuses %s and writes nothing', async (_label, user, status) => {
    mockFindById.mockResolvedValue({ adminActionsRequireMfa: false });
    const res = makeRes();
    await updateMfaPolicy(req({ adminActionsRequireMfa: true }, user), res);

    expect(res._status).toBe(status);
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockRefreshClaims).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
