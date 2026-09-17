// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `impersonateUser` controller. The controller's contract:
 * sysadmin gate, refuse self-impersonation, refuse chained impersonation,
 * refuse impersonating another sysadmin, audit the start event, and
 * return a token issued by `issueImpersonationToken`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
const mockUserFindById = jest.fn();
const mockIssueImpersonation = jest.fn();
const mockAudit = jest.fn();
const mockCreateRequest = jest.fn();
const mockResolveAuthority = jest.fn();
const mockNotifyTeam = jest.fn();
const mockRequestFindById = jest.fn();
const mockCanAdministerOrg = jest.fn();
const mockDecide = jest.fn();
const mockRevoke = jest.fn();
const mockConsume = jest.fn();
const mockIsSystemAdmin = jest.fn();
const mockIsTenantAdminOf = jest.fn();
const mockNotifyBreakglass = jest.fn();
const mockResolvePolicy = jest.fn();
const mockCreateBreakglass = jest.fn();
const mockExpandOrgScope = jest.fn();
const mockListForCaller = jest.fn();
const mockIsOrgAdmin = jest.fn();
const mockPublishSessionRevocation = jest.fn();
const mockDecideInitialApproval = jest.fn();
const mockResolveChallengeRoute = jest.fn();
const mockSendChallenge = jest.fn();
const mockMarkUndeliverable = jest.fn();
const mockUOFindOne = jest.fn();
const mockNotifyRequester = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));

jest.unstable_mockModule('mongoose', () => {
  class Schema {
    constructor() { /* no-op */ }
    index() { /* no-op */ }
    method() { /* no-op */ }
    pre() { /* no-op */ }
    post() { /* no-op */ }
    virtual() { return this; }
    set() { /* no-op */ }
    static Types = { Mixed: class {}, ObjectId: class {} };
  }
  return { Types: { ObjectId: class {} }, Schema, models: {}, model: jest.fn() };
});

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  withController: (_label: string, fn: Function) =>
    async (req: any, res: any) => fn(req, res),
  canAdministerOrg: (...a: unknown[]) => mockCanAdministerOrg(...a),
  isSystemAdmin: (...a: unknown[]) => mockIsSystemAdmin(...a),
  isOrgAdmin: (...a: unknown[]) => mockIsOrgAdmin(...a),
}));
// Authority now depends on BOTH parties (is the caller an ancestor admin of the
// target's pinned org?), so it is resolved in the controller rather than by a
// route middleware. Stub it at that boundary; the rule itself is covered in
// impersonation-authority.test.ts.
jest.unstable_mockModule('../src/helpers/impersonation-authority.js', () => ({
  resolveImpersonationAuthority: (...a: unknown[]) => mockResolveAuthority(...a),
  isTenantAdminOf: (...a: unknown[]) => mockIsTenantAdminOf(...a),
}));
// The controller publishes an ended session so OTHER services reject it too.
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishImpersonationSessionRevocation: (...a: unknown[]) => mockPublishSessionRevocation(...a),
}));
jest.unstable_mockModule('../src/helpers/impersonation-challenge.js', () => ({
  resolveChallengeRoute: (...a: unknown[]) => mockResolveChallengeRoute(...a),
  sendImpersonationChallenge: (...a: unknown[]) => mockSendChallenge(...a),
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  expandOrgScope: (...a: unknown[]) => mockExpandOrgScope(...a),
}));
jest.unstable_mockModule('../src/helpers/impersonation-policy.js', () => ({
  resolveEffectiveImpersonationPolicy: (...a: unknown[]) => mockResolvePolicy(...a),
}));
jest.unstable_mockModule('../src/helpers/impersonation-notify.js', () => ({
  notifyTeamOfAncestorImpersonation: (...a: unknown[]) => mockNotifyTeam(...a),
  notifyOrgOfBreakglass: (...a: unknown[]) => mockNotifyBreakglass(...a),
  notifyRequesterOfDecision: (...a: unknown[]) => mockNotifyRequester(...a),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  User: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  // The decide/revoke controllers load the request to authorize the decider.
  ImpersonationRequest: { findById: (...a: unknown[]) => mockRequestFindById(...a) },
  UserOrganization: { findOne: (...a: unknown[]) => mockUOFindOne(...a) },
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/utils/token.js', () => ({
  signPersonalAccessToken: jest.fn(),
  issueImpersonationToken: (...a: unknown[]) => mockIssueImpersonation(...a),
}));
// This is a CONTROLLER test: stub the request lifecycle at the service boundary
// the same way the token helper is stubbed. The service's own state machine is
// covered in impersonation-request.test.ts.
jest.unstable_mockModule('../src/services/impersonation-service.js', () => ({
  impersonationService: {
    createRequest: (...a: unknown[]) => mockCreateRequest(...a),
    consume: (...a: unknown[]) => mockConsume(...a),
    decide: (...a: unknown[]) => mockDecide(...a),
    revoke: (...a: unknown[]) => mockRevoke(...a),
    createBreakglassRequest: (...a: unknown[]) => mockCreateBreakglass(...a),
    listForCaller: (...a: unknown[]) => mockListForCaller(...a),
    markUndeliverable: (...a: unknown[]) => mockMarkUndeliverable(...a),
  },
  // The decision itself is covered exhaustively in impersonation-request.test.ts;
  // here it's stubbed so each controller branch can be driven directly.
  decideInitialApproval: (...a: unknown[]) => mockDecideInitialApproval(...a),
  IMP_NOT_APPROVED: 'IMP_NOT_APPROVED',
  IMP_EXPIRED: 'IMP_EXPIRED',
}));

const {
  impersonateUser, redeemImpersonationRequest, decideImpersonationRequest, breakglassImpersonation,
  listImpersonationRequests, revokeImpersonationSession,
} = await import('../src/controllers/impersonate.js');


function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  mockUserFindById.mockReset();
  mockResolveAuthority.mockReset().mockResolvedValue({ kind: 'sysadmin' });
  mockNotifyTeam.mockReset().mockResolvedValue(undefined);
  mockRequestFindById.mockReset();
  mockCanAdministerOrg.mockReset().mockResolvedValue(false);
  mockDecide.mockReset();
  mockRevoke.mockReset();
  mockIsSystemAdmin.mockReset().mockReturnValue(false);
  mockIsTenantAdminOf.mockReset().mockResolvedValue(false);
  mockNotifyBreakglass.mockReset().mockResolvedValue({ attempted: 2, delivered: 2 });
  mockResolvePolicy.mockReset().mockResolvedValue({ policy: 'open', allowSelfApproval: true, resolved: true });
  mockCreateBreakglass.mockReset();
  mockExpandOrgScope.mockReset().mockResolvedValue([]);
  mockListForCaller.mockReset().mockResolvedValue([]);
  mockIsOrgAdmin.mockReset().mockReturnValue(false);
  mockPublishSessionRevocation.mockReset().mockResolvedValue(true);
  // Default: an `open` org, so pre-existing happy-path tests still start a session.
  mockDecideInitialApproval.mockReset().mockReturnValue({ kind: 'approved', reason: 'policy_open' });
  mockResolveChallengeRoute.mockReset().mockImplementation((mode: string) => ({ ok: true, mode }));
  mockSendChallenge.mockReset().mockResolvedValue({ attempted: 1, delivered: 1 });
  mockMarkUndeliverable.mockReset().mockResolvedValue(undefined);
  mockNotifyRequester.mockReset().mockResolvedValue(undefined);
  mockUOFindOne.mockReset().mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'm1' }) }) });
  mockIssueImpersonation.mockReset();
  mockAudit.mockReset();
  // Default: the request opens already-approved and redeems cleanly, which is
  // what happens while no org requires consent.
  mockCreateRequest.mockReset().mockResolvedValue({ id: 'req-1', status: 'approved', approvalReason: 'policy_open' });
  mockConsume.mockReset().mockResolvedValue({ ok: true });
});

describe('impersonateUser', () => {
  it('returns 403 when the caller has no authority over the target', async () => {
    mockResolveAuthority.mockResolvedValue({ kind: 'none' });
    mockUserFindById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: 'target', isSuperAdmin: false, lastActiveOrgId: 'org-target' }),
    });
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'u1' }, params: { userId: 'target' } }, res,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
    // Refused BEFORE a request record exists — a denied attempt must not leave
    // a spurious approved row behind.
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  it('passes ancestor authority through and informs the team', async () => {
    mockResolveAuthority.mockResolvedValue({ kind: 'ancestor', viaOrgId: 'org-parent' });
    mockUserFindById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: 'target', isSuperAdmin: false, lastActiveOrgId: 'org-team' }),
    });
    mockIssueImpersonation.mockResolvedValue({ accessToken: 'imp.jwt', expiresIn: 900 });

    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'parent-admin', organizationId: 'org-parent' }, params: { userId: 'target' } }, res,
    );

    // The reason is what a reviewer reads to tell "nobody was asked" from
    // "someone said yes". An ancestor is decided as such, and the policy is skipped.
    expect(mockDecideInitialApproval).toHaveBeenCalledWith({ ancestorAuthority: true, policy: undefined });
    // Informed, not asked.
    expect(mockNotifyTeam).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-team', requesterId: 'parent-admin', targetUserId: 'target' }),
    );
  });

  it('does NOT send the team notice on the sysadmin path', async () => {
    mockUserFindById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: 'target', isSuperAdmin: false, lastActiveOrgId: 'org-team' }),
    });
    mockIssueImpersonation.mockResolvedValue({ accessToken: 'imp.jwt', expiresIn: 900 });

    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, params: { userId: 'target' } }, res,
    );

    // The notice explains PARENT-org access specifically; sending it for a
    // platform operator would misdescribe what happened.
    expect(mockNotifyTeam).not.toHaveBeenCalled();
  });

  it('refuses to impersonate from within an existing impersonation session', async () => {
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'u1', impersonatorId: 'orig' }, params: { userId: 'target' } }, res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
  });

  it('refuses self-impersonation', async () => {
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'u1' }, params: { userId: 'u1' } }, res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when target does not exist', async () => {
    // Controller now does `User.findById(...).select('+isSuperAdmin')` to opt
    // into a `select: false` field — mock must return a thenable-on-.select().
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, params: { userId: 'missing' } }, res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('refuses to impersonate another sysadmin', async () => {
    mockUserFindById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: 'other-sysadmin', isSuperAdmin: true }),
    });
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, params: { userId: 'other-sysadmin' } }, res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
  });

  it('issues a token and audits the start event on the happy path', async () => {
    mockUserFindById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: 'target', isSuperAdmin: false, lastActiveOrgId: 'org-target' }),
    });
    mockIssueImpersonation.mockResolvedValue({ accessToken: 'imp.jwt', expiresIn: 900 });

    const req: any = { user: { sub: 'sysadmin' }, params: { userId: 'target' } };
    const res = mockRes();
    await (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(req, res);

    // The session's org is passed EXPLICITLY (third arg) rather than derived
    // inside the token helper — the org is a property of the request, not of the
    // target's browsing history. Today it's the target's active org.
    expect(mockIssueImpersonation).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'target' }),
      'sysadmin',
      'org-target',
      expect.any(String), // the session jti
    );
    // The impersonator at session start IS the actor (the sysadmin), already
    // captured as the event's actorId — so it's no longer duplicated into
    // `details`. Events performed LATER under the issued token carry the
    // sysadmin in the first-class `impersonatorId` field instead.
    // `affectedOrgId` is the IMPERSONATED user's org so it surfaces in that org's
    // audit view (not the sysadmin's system org).
    expect(mockAudit).toHaveBeenCalledWith(req, 'admin.impersonate.start', expect.objectContaining({
      targetType: 'user',
      targetId: 'target',
      affectedOrgId: 'org-target',
      details: expect.objectContaining({ expiresIn: 900 }),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ accessToken: 'imp.jwt', expiresIn: 900, targetUserId: 'target' }),
    }));
  });
});


describe('redeemImpersonationRequest', () => {
  const leanOf = (doc: unknown) => ({ lean: () => Promise.resolve(doc) });
  const call = (user: any, id = 'req-1') => {
    const res = mockRes();
    return (redeemImpersonationRequest as unknown as (req: any, res: any) => Promise<void>)(
      { user, params: { id } }, res,
    ).then(() => res);
  };

  it('lets the requester redeem an approved request for a token', async () => {
    mockRequestFindById.mockReturnValue(leanOf({
      requesterId: 'sysadmin', targetUserId: 'target', orgId: 'org-a', approvalReason: 'consent',
    }));
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue({ _id: 'target', isSuperAdmin: false }) });
    mockIssueImpersonation.mockResolvedValue({ accessToken: 'imp.jwt', expiresIn: 900 });

    const res = await call({ sub: 'sysadmin' });

    expect(res.status).toHaveBeenCalledWith(200);
    // Redeemed through the SAME single-use gate and token path as inline sessions.
    expect(mockConsume).toHaveBeenCalledWith('req-1', expect.any(String));
    expect(mockIssueImpersonation).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'target' }), 'sysadmin', 'org-a', expect.any(String),
    );
  });

  it('refuses anyone other than the requester — an approval is not a bearer ticket', async () => {
    mockRequestFindById.mockReturnValue(leanOf({ requesterId: 'sysadmin', targetUserId: 'target' }));

    const res = await call({ sub: 'someone-who-learned-the-id' });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
  });

  it('re-checks the target is not a sysadmin at redemption time', async () => {
    // The target may have been promoted during the up-to-an-hour approval window.
    mockRequestFindById.mockReturnValue(leanOf({ requesterId: 'sysadmin', targetUserId: 'target' }));
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue({ _id: 'target', isSuperAdmin: true }) });

    const res = await call({ sub: 'sysadmin' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('refuses redemption from inside an impersonation session', async () => {
    const res = await call({ sub: 'sysadmin', impersonatorId: 'orig' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockRequestFindById).not.toHaveBeenCalled();
  });

  it('reports a request that is no longer redeemable', async () => {
    mockRequestFindById.mockReturnValue(leanOf({ requesterId: 'sysadmin', targetUserId: 'target' }));
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue({ _id: 'target', isSuperAdmin: false }) });
    mockConsume.mockResolvedValue({ ok: false, code: 'IMP_EXPIRED' });

    const res = await call({ sub: 'sysadmin' });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
  });
});


describe('decideImpersonationRequest — authorization', () => {
  const leanOf = (doc: unknown) => ({ lean: () => Promise.resolve(doc) });
  const decide = (user: any, approve = true) => {
    const res = mockRes();
    return (decideImpersonationRequest as unknown as (req: any, res: any) => Promise<void>)(
      { user, params: { id: 'req-1' }, body: { approve } }, res,
    ).then(() => res);
  };

  it('REFUSES a requester deciding their OWN request — the consent bypass', async () => {
    // Without this, a sysadmin opens a consent request and approves it themselves.
    mockRequestFindById.mockReturnValue(leanOf({ requesterId: 'sysadmin', targetUserId: 't', orgId: 'org-a' }));
    mockIsSystemAdmin.mockReturnValue(true);
    // Grant EVERY other form of authority, as reality would for a sysadmin who
    // also administers the org. canAdministerOrg really does return true for any
    // sysadmin. With these defaulted to false the test passed on the old, buggy
    // code too — so it proved nothing. Now the ONLY thing that can refuse this is
    // the requester-cannot-decide-their-own guard.
    mockCanAdministerOrg.mockResolvedValue(true);
    mockIsTenantAdminOf.mockResolvedValue(true);

    const res = await decide({ sub: 'sysadmin' });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('REFUSES a different sysadmin approving a tenant CONSENT request', async () => {
    // Consent belongs to the tenant. Sysadmin status must not confer it —
    // canAdministerOrg would have returned true here.
    mockRequestFindById.mockReturnValue(leanOf({ requesterId: 'sysadmin-a', targetUserId: 't', orgId: 'org-a' }));
    mockIsSystemAdmin.mockReturnValue(true);
    mockCanAdministerOrg.mockResolvedValue(true);
    mockIsTenantAdminOf.mockResolvedValue(false);

    const res = await decide({ sub: 'sysadmin-b' });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('lets a genuine tenant admin decide a consent request', async () => {
    mockRequestFindById.mockReturnValue(leanOf({ requesterId: 'sysadmin', targetUserId: 't', orgId: 'org-a' }));
    mockIsTenantAdminOf.mockResolvedValue(true);
    mockDecide.mockResolvedValue({ ok: true, request: { status: 'approved' } });

    const res = await decide({ sub: 'org-admin', organizationId: 'org-a' });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDecide).toHaveBeenCalledWith('req-1', 'org-admin', true, false);
  });

  it('lets the named approver decide', async () => {
    mockRequestFindById.mockReturnValue(leanOf({
      requesterId: 'sysadmin', targetUserId: 't', orgId: 'org-a', approverUserId: 'the-user',
    }));
    mockDecide.mockResolvedValue({ ok: true, request: { status: 'approved' } });

    const res = await decide({ sub: 'the-user' });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('FOUR-EYES: a second sysadmin may approve break-glass', async () => {
    mockRequestFindById.mockReturnValue(leanOf({
      requesterId: 'sysadmin-a', targetUserId: 't', orgId: 'org-a', breakglass: true,
    }));
    mockIsSystemAdmin.mockReturnValue(true);
    mockDecide.mockResolvedValue({ ok: true, request: { status: 'approved' } });

    const res = await decide({ sub: 'sysadmin-b' });

    expect(res.status).toHaveBeenCalledWith(200);
    // Recorded as breakglass, not consent — nobody in the tenant said yes.
    expect(mockDecide).toHaveBeenCalledWith('req-1', 'sysadmin-b', true, true);
  });

  it('FOUR-EYES: a tenant admin may NOT approve break-glass', async () => {
    mockRequestFindById.mockReturnValue(leanOf({
      requesterId: 'sysadmin-a', targetUserId: 't', orgId: 'org-a', breakglass: true,
    }));
    mockIsTenantAdminOf.mockResolvedValue(true);

    const res = await decide({ sub: 'org-admin', organizationId: 'org-a' });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('FOUR-EYES: the requesting sysadmin cannot be their own second pair of eyes', async () => {
    mockRequestFindById.mockReturnValue(leanOf({
      requesterId: 'sysadmin-a', targetUserId: 't', orgId: 'org-a', breakglass: true,
    }));
    mockIsSystemAdmin.mockReturnValue(true);

    const res = await decide({ sub: 'sysadmin-a' });
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('breakglassImpersonation', () => {
  const justification = 'Production incident INC-123: customer pipelines failing';
  const target = { _id: 'target', isSuperAdmin: false, lastActiveOrgId: 'org-a' };
  const call = (user: any, body: any) => {
    const res = mockRes();
    return (breakglassImpersonation as unknown as (req: any, res: any) => Promise<void>)(
      { user, params: { userId: 'target' }, body }, res,
    ).then(() => res);
  };

  beforeEach(() => {
    mockIsSystemAdmin.mockReturnValue(true);
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(target) });
  });

  it('is sysadmin only', async () => {
    mockIsSystemAdmin.mockReturnValue(false);
    const res = await call({ sub: 'org-admin' }, { justification });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockCreateBreakglass).not.toHaveBeenCalled();
  });

  it('requires a real written justification', async () => {
    const res = await call({ sub: 'sysadmin' }, { justification: 'urgent' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreateBreakglass).not.toHaveBeenCalled();
  });

  it('refuses a user with no organization — there is nobody to notify', async () => {
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue({ ...target, lastActiveOrgId: undefined }) });
    const res = await call({ sub: 'sysadmin' }, { justification });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreateBreakglass).not.toHaveBeenCalled();
  });

  it('issues a token immediately when no second sysadmin is required, and notifies loudly', async () => {
    mockCreateBreakglass.mockResolvedValue({ request: { id: 'req-9' }, fourEyes: null, recentCount: 0 });
    mockIssueImpersonation.mockResolvedValue({ accessToken: 'imp.jwt', expiresIn: 900 });

    const res = await call({ sub: 'sysadmin' }, { justification });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockNotifyBreakglass).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-a', justification, awaitingSecondSysadmin: false,
    }));
    // Audited as break-glass, never as an ordinary start.
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'admin.impersonate.breakglass', expect.anything());
  });

  it('issues NOTHING when a second sysadmin is required', async () => {
    mockCreateBreakglass.mockResolvedValue({ request: { id: 'req-9' }, fourEyes: 'policy_denied', recentCount: 0 });

    const res = await call({ sub: 'sysadmin' }, { justification });

    expect(res.status).toHaveBeenCalledWith(202);
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
    expect(mockNotifyBreakglass).toHaveBeenCalledWith(expect.objectContaining({ awaitingSecondSysadmin: true }));
  });

  it('records how many admins were actually reached, so a silent notice failure is visible', async () => {
    mockCreateBreakglass.mockResolvedValue({ request: { id: 'req-9' }, fourEyes: null, recentCount: 0 });
    mockNotifyBreakglass.mockResolvedValue({ attempted: 3, delivered: 0 });
    mockIssueImpersonation.mockResolvedValue({ accessToken: 'imp.jwt', expiresIn: 900 });

    await call({ sub: 'sysadmin' }, { justification });

    const breakglassAudit = mockAudit.mock.calls.find((c) => c[1] === 'admin.impersonate.breakglass')!;
    expect((breakglassAudit[2] as any).details.notified).toEqual({ attempted: 3, delivered: 0 });
  });
});


describe('listImpersonationRequests', () => {
  const list = (user: any, view?: string) => {
    const res = mockRes();
    return (listImpersonationRequests as unknown as (req: any, res: any) => Promise<void>)(
      { user, query: view === undefined ? {} : { view } }, res,
    ).then(() => res);
  };

  it('rejects an unknown view', async () => {
    const res = await list({ sub: 'me' }, 'everything');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockListForCaller).not.toHaveBeenCalled();
  });

  it('gives an ordinary user NO admin org scope', async () => {
    await list({ sub: 'me', organizationId: 'org-a' }, 'to-decide');

    expect(mockExpandOrgScope).not.toHaveBeenCalled();
    expect(mockListForCaller).toHaveBeenCalledWith({ userId: 'me', isSysadmin: false, adminOrgIds: [] }, 'to-decide');
  });

  it('scopes a tenant admin to their active org subtree', async () => {
    mockIsOrgAdmin.mockReturnValue(true);
    mockExpandOrgScope.mockResolvedValue(['org-a', 'team-1']);

    await list({ sub: 'admin', organizationId: 'org-a' }, 'to-decide');

    expect(mockExpandOrgScope).toHaveBeenCalledWith('org-a');
    expect(mockListForCaller).toHaveBeenCalledWith(
      { userId: 'admin', isSysadmin: false, adminOrgIds: ['org-a', 'team-1'] }, 'to-decide',
    );
  });

  it('does NOT widen a sysadmin\'s org scope — sysadmin reach is applied per view', async () => {
    mockIsSystemAdmin.mockReturnValue(true);

    await list({ sub: 'sys', organizationId: 'system' }, 'to-decide');

    expect(mockListForCaller).toHaveBeenCalledWith({ userId: 'sys', isSysadmin: true, adminOrgIds: [] }, 'to-decide');
  });
});


describe('revokeImpersonationSession — cross-service', () => {
  const leanOf = (doc: unknown) => ({ lean: () => Promise.resolve(doc) });
  const revoke = (user: any) => {
    const res = mockRes();
    return (revokeImpersonationSession as unknown as (req: any, res: any) => Promise<void>)(
      { user, params: { id: 'req-1' } }, res,
    ).then(() => res);
  };
  const consumedAt = new Date();

  beforeEach(() => {
    mockRequestFindById.mockReturnValue(leanOf({ requesterId: 'op', targetUserId: 'me', orgId: 'org-a' }));
    mockRevoke.mockResolvedValue({ ok: true, request: { jti: 'sess-1', consumedAt } });
  });

  it('publishes the ended session so every other service rejects it', async () => {
    await revoke({ sub: 'me' });
    expect(mockPublishSessionRevocation).toHaveBeenCalledWith('sess-1', consumedAt);
  });

  it('tells the caller when it ended everywhere', async () => {
    const res = await revoke({ sub: 'me' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'revoked', revokedEverywhere: true }),
    }));
  });

  it('tells the caller when it did NOT — never reports success while the token still works elsewhere', async () => {
    mockPublishSessionRevocation.mockResolvedValue(false);
    const res = await revoke({ sub: 'me' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ revokedEverywhere: false }),
    }));
  });
});


describe('impersonateUser — consent enforcement', () => {
  const target = { _id: 'target', isSuperAdmin: false, lastActiveOrgId: 'org-a' };
  const start = (body: any = {}) => {
    const res = mockRes();
    return (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'sysadmin' }, params: { userId: 'target' }, body }, res,
    ).then(() => res);
  };

  beforeEach(() => {
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(target) });
    mockIssueImpersonation.mockResolvedValue({ accessToken: 'imp.jwt', expiresIn: 900 });
  });

  it('consults the org\'s EFFECTIVE policy', async () => {
    await start();
    expect(mockResolvePolicy).toHaveBeenCalledWith('org-a');
    expect(mockDecideInitialApproval).toHaveBeenCalledWith(expect.objectContaining({ ancestorAuthority: false }));
  });

  it('under CONSENT: issues NO token, sends the challenge, answers 202 pending', async () => {
    mockResolvePolicy.mockResolvedValue({ policy: 'consent', allowSelfApproval: true, resolved: true });
    mockDecideInitialApproval.mockReturnValue({ kind: 'pending' });

    const res = await start({ reason: 'ticket #9' });

    expect(res.status).toHaveBeenCalledWith(202);
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockSendChallenge).toHaveBeenCalledWith(expect.objectContaining({ mode: 'user', orgId: 'org-a', reason: 'ticket #9' }));
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'admin.impersonate.request', expect.anything());
  });

  it('under CONSENT with self-approval forbidden: the DEFAULT route is the org admins', async () => {
    mockResolvePolicy.mockResolvedValue({ policy: 'consent', allowSelfApproval: false, resolved: true });
    mockDecideInitialApproval.mockReturnValue({ kind: 'pending' });

    await start();

    // No choice was made, so this is a default — not a silent reroute.
    expect(mockResolveChallengeRoute).toHaveBeenCalledWith('org_admin', false);
    expect(mockCreateRequest).toHaveBeenCalledWith(expect.objectContaining({ approverMode: 'org_admin', approverUserId: undefined }));
  });

  it('an EXPLICIT user route the org forbids is REFUSED, not rerouted', async () => {
    mockResolvePolicy.mockResolvedValue({ policy: 'consent', allowSelfApproval: false, resolved: true });
    mockDecideInitialApproval.mockReturnValue({ kind: 'pending' });
    mockResolveChallengeRoute.mockReturnValue({ ok: false, code: 'IMPERSONATION_SELF_APPROVAL_FORBIDDEN' });

    const res = await start({ approverMode: 'user' });

    expect(mockResolveChallengeRoute).toHaveBeenCalledWith('user', false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  it('under DENIED: refused before any record exists', async () => {
    mockResolvePolicy.mockResolvedValue({ policy: 'denied', allowSelfApproval: true, resolved: true });
    mockDecideInitialApproval.mockReturnValue({ kind: 'refused' });

    const res = await start();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockCreateRequest).not.toHaveBeenCalled();
    expect(mockIssueImpersonation).not.toHaveBeenCalled();
  });

  it('when the challenge reaches NOBODY: marks it undeliverable and says so, not pending', async () => {
    mockResolvePolicy.mockResolvedValue({ policy: 'consent', allowSelfApproval: true, resolved: true });
    mockDecideInitialApproval.mockReturnValue({ kind: 'pending' });
    mockSendChallenge.mockResolvedValue({ attempted: 1, delivered: 0 });

    const res = await start();

    expect(mockMarkUndeliverable).toHaveBeenCalledWith('req-1');
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('refuses a target with no organization', async () => {
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue({ ...target, lastActiveOrgId: undefined }) });

    const res = await start();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  it('under OPEN: starts the session immediately', async () => {
    const res = await start();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockIssueImpersonation).toHaveBeenCalled();
    expect(mockSendChallenge).not.toHaveBeenCalled();
  });

  it('an ancestor admin skips the policy entirely', async () => {
    mockResolveAuthority.mockResolvedValue({ kind: 'ancestor', viaOrgId: 'org-parent' });
    mockDecideInitialApproval.mockReturnValue({ kind: 'approved', reason: 'ancestor_authority' });

    await start();

    expect(mockResolvePolicy).not.toHaveBeenCalled();
    expect(mockDecideInitialApproval).toHaveBeenCalledWith({ ancestorAuthority: true, policy: undefined });
  });
});


describe('impersonateUser — explicit organization', () => {
  const target = { _id: 'target', isSuperAdmin: false, lastActiveOrgId: 'org-parent' };
  const start = (body: any) => {
    const res = mockRes();
    return (impersonateUser as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'parent-admin', organizationId: 'org-parent' }, params: { userId: 'target' }, body }, res,
    ).then(() => res);
  };

  beforeEach(() => {
    mockUserFindById.mockReturnValue({ select: jest.fn().mockResolvedValue(target) });
    mockIssueImpersonation.mockResolvedValue({ accessToken: 'imp.jwt', expiresIn: 900 });
  });

  it('pins the session to the NAMED team, not the target\'s last active org', async () => {
    // Last active in the parent — pinning there would make this the parent
    // admin's OWN org, and the request would be refused.
    mockResolveAuthority.mockResolvedValue({ kind: 'ancestor', viaOrgId: 'org-parent' });

    await start({ orgId: 'team-1' });

    expect(mockResolveAuthority).toHaveBeenCalledWith(expect.anything(), 'team-1');
    expect(mockCreateRequest).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'team-1' }));
  });

  it('refuses a named org the target is not an active member of', async () => {
    mockUOFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });

    const res = await start({ orgId: 'some-other-org' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockResolveAuthority).not.toHaveBeenCalled();
    expect(mockCreateRequest).not.toHaveBeenCalled();
  });

  it('falls back to the target\'s active org when none is named', async () => {
    await start({});
    expect(mockResolveAuthority).toHaveBeenCalledWith(expect.anything(), 'org-parent');
    expect(mockUOFindOne).not.toHaveBeenCalled();
  });
});


describe('decideImpersonationRequest — requester is told', () => {
  const leanOf = (doc: unknown) => ({ lean: () => Promise.resolve(doc) });
  const decide = (approve: boolean) => {
    const res = mockRes();
    return (decideImpersonationRequest as unknown as (req: any, res: any) => Promise<void>)(
      { user: { sub: 'the-user' }, params: { id: 'req-1' }, body: { approve } }, res,
    ).then(() => res);
  };

  beforeEach(() => {
    mockRequestFindById.mockReturnValue(leanOf({
      requesterId: 'op', targetUserId: 'the-user', orgId: 'org-a', approverUserId: 'the-user',
    }));
    mockDecide.mockResolvedValue({ ok: true, request: { status: 'approved' } });
  });

  it('notifies the requester when their request is APPROVED', async () => {
    await decide(true);
    expect(mockNotifyRequester).toHaveBeenCalledWith({
      requesterId: 'op', targetUserId: 'the-user', deciderId: 'the-user', approved: true, breakglass: false,
    });
  });

  it('notifies the requester when their request is DENIED', async () => {
    mockDecide.mockResolvedValue({ ok: true, request: { status: 'denied' } });
    await decide(false);
    expect(mockNotifyRequester).toHaveBeenCalledWith(expect.objectContaining({ approved: false }));
  });

  it('does not notify when the decision did not land (already answered)', async () => {
    mockDecide.mockResolvedValue({ ok: false, code: 'IMP_ALREADY_DECIDED' });
    await decide(true);
    expect(mockNotifyRequester).not.toHaveBeenCalled();
  });
});
