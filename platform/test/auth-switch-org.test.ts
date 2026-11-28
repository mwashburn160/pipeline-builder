// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-scoped auth controllers:
 *  - `switchOrg` (POST /auth/switch-org) emits `org.switch` with the DESTINATION
 *    org as `affectedOrgId`, moves the CURRENT refresh-session slot to the org and
 *    returns an access token ONLY — never a refresh token, never a cookie.
 *  - `refresh` revokes only the reused token's slot, never every session.
 *  - `logout` clears only the current slot.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockAudit = jest.fn();
const mockSwitchActiveOrg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockSetLastActiveOrg = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockIssueTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRenewSessionTokens = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockSwitchSessionOrg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRevokeRefreshSession = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockInvalidateAllSessions = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockFindForTokenIssue = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string, code?: string, details?: unknown) =>
    res.status(status).json({ success: false, message: msg, ...(code ? { code } : {}), ...(details ? { details } : {}) }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
  createSafeClient: () => ({ post: jest.fn(), delete: jest.fn() }),
  isSystemOrgId: () => false,
}));

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ billing: { enabled: false }, compliance: { enabled: false } }));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
// controllers/auth now imports SSO login enforcement, which pulls in the org-idp /
// secret-blob / entitlement chain. This suite tests switchOrg, not SSO — mock the
// helper so that chain isn't loaded (avoids needing its transitive api-core exports).
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ findSsoEnforcementForEmail: async () => null, rejectIfSsoEnforced: async () => false }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
const mockIncCounter = jest.fn();
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));
jest.unstable_mockModule('../src/services/billing-provision.js', () => ({ provisionBillingSubscription: jest.fn() }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  authService: {
    resolveSwitchTarget: (...a: unknown[]) => mockSwitchActiveOrg(...a),
    setLastActiveOrg: (...a: unknown[]) => mockSetLastActiveOrg(...a),
    revokeRefreshSession: (...a: unknown[]) => mockRevokeRefreshSession(...a),
    invalidateAllSessions: (...a: unknown[]) => mockInvalidateAllSessions(...a),
    findForTokenIssue: (...a: unknown[]) => mockFindForTokenIssue(...a),
  },
  // controllers/auth.ts attributes the PUBLIC email-verify to the user the token
  // resolved to via createEvent (no req.user on that route); unused here.
  auditService: { createEvent: jest.fn(async () => undefined) },
}));
const mockHoldsTeamAccess = jest.fn<(...a: unknown[]) => Promise<boolean>>();
jest.unstable_mockModule('../src/services/session/membership-context.js', () => ({
  membershipForOrg: jest.fn(async () => undefined),
  holdsInheritedTeamAccess: (...a: unknown[]) => mockHoldsTeamAccess(...a),
}));
jest.unstable_mockModule('../src/services/session/access-tokens.js', () => ({
  enforceOrgAssurance: async (_u: unknown, _m: unknown, a: unknown) => a,
  // Session-auth helpers the controllers now import (see utils/token.ts).
  signInAuth: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  authFromClaims: () => ({ amr: ['pwd'], aal: 1, authTime: new Date(0) }),
  signApiKeyToken: jest.fn(),
  signServiceAccountToken: jest.fn(),
}));
jest.unstable_mockModule('../src/services/session/refresh-sessions.js', () => ({
  findRefreshSession: jest.fn(async () => undefined),
  issueTokens: (...a: unknown[]) => mockIssueTokens(...a),
  renewSessionTokens: (...a: unknown[]) => mockRenewSessionTokens(...a),
  switchSessionOrg: (...a: unknown[]) => mockSwitchSessionOrg(...a),
  hashRefreshToken: (t: string) => `h:${t}`,
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  validateBody: (_schema: unknown, body: unknown) => body, registerSchema: {}, loginSchema: {}, completeOnboardingSchema: {}, joinOrgSchema: {},
}));

const { _resetAllPendingStoresForTests } = await import('../src/helpers/pending-state-store.js');
const { switchOrg, refresh, logout } = await import('../src/controllers/auth.js');

/** A plain membership in the destination org. */
const MEMBER = { role: 'member', via: 'membership', permissionOrgIds: ['org-to'] };

function makeRes() {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetAllPendingStoresForTests();
  mockIssueTokens.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
  mockRenewSessionTokens.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2' });
  mockSwitchSessionOrg.mockResolvedValue({ accessToken: 'a-switched', expiresIn: 900 });
});

describe('switchOrg — org.switch audit', () => {
  it('emits org.switch with destination org as affectedOrgId and from/to in details', async () => {
    mockSwitchActiveOrg.mockResolvedValue({ user: { _id: 'u1', lastActiveOrgId: 'org-to' }, authority: MEMBER });

    const req: any = { user: { sub: 'u1', sid: 's1', organizationId: 'org-from' }, headers: {}, body: { organizationId: 'org-to' } };
    const res = makeRes();
    await (switchOrg as any)(req, res);

    expect(mockAudit).toHaveBeenCalledWith(req, 'org.switch', expect.objectContaining({
      affectedOrgId: 'org-to',
      details: { fromOrgId: 'org-from', toOrgId: 'org-to' },
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each([
    ['an exchanged access key', { sub: 'u1', organizationId: 'org-from', token_use: 'api_key', jti: 'k1', permissionsRestricted: true, permissions: ['plugins:read'] }],
    ['a service account', { sub: 'sa-1', organizationId: 'org-from', token_use: 'api_key', jti: 'k1', principalType: 'service_account' }],
    ['an impersonation session', { sub: 'u1', organizationId: 'org-from', jti: 'imp-1', impersonatorId: 'op-1' }],
    ['a token with no slot', { sub: 'u1', organizationId: 'org-from' }],
  ])('REFUSES %s — there is no session slot to re-issue, and none is minted (403)', async (_label, user) => {
    mockSwitchActiveOrg.mockResolvedValue({ user: { _id: 'u1', lastActiveOrgId: 'org-to' }, authority: MEMBER });
    const res = makeRes();
    await (switchOrg as any)({ user, headers: {}, body: { organizationId: 'org-to' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(mockRenewSessionTokens).not.toHaveBeenCalled();
    expect(mockSwitchSessionOrg).not.toHaveBeenCalled();
    expect(mockSwitchActiveOrg).not.toHaveBeenCalled();
  });

  it('records the ancestor whose admin membership let a parent admin into a team', async () => {
    mockSwitchActiveOrg.mockResolvedValue({
      user: { _id: 'u1' },
      authority: { role: 'admin', via: 'ancestor', inheritedFromOrgId: 'root-1', permissionOrgIds: ['root-1'] },
    });

    // `team_access:open` is in the admin bundle, so a real parent-org admin
    // holds it; the inherited switch now requires it (see below).
    mockHoldsTeamAccess.mockResolvedValue(true);
    const req: any = {
      user: { sub: 'u1', sid: 's1', organizationId: 'root-1', permissions: ['team_access:open'] },
      headers: {},
      body: { organizationId: 'team-1' },
    };
    const res = makeRes();
    await (switchOrg as any)(req, res);

    expect(mockAudit).toHaveBeenCalledWith(req, 'org.switch', expect.objectContaining({
      affectedOrgId: 'team-1',
      details: { fromOrgId: 'root-1', toOrgId: 'team-1', via: 'ancestor', inheritedFromOrgId: 'root-1' },
    }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  /**
   * An INHERITED switch needs `team_access:open`; a switch into an org the
   * person is actually a MEMBER of does not.
   *
   * The permission is in the admin and owner bundles, so this changes nothing
   * for an ordinary parent-org admin. What it buys is the delegation: an org can
   * take team access off one of its admins with a custom Role, or give it to a
   * lead who is not an admin, and the switch follows — where before, reaching
   * into a team was an unconditional consequence of the admin label.
   *
   * It is checked HERE rather than in `resolveOrgAuthority`, which is also the
   * token chokepoint: requiring it there would re-gate every request of an
   * already-open inherited session.
   */
  it('REFUSES an inherited switch without team_access:open, and audits nothing (403)', async () => {
    mockSwitchActiveOrg.mockResolvedValue({
      user: { _id: 'u1' },
      authority: { role: 'admin', via: 'ancestor', inheritedFromOrgId: 'root-1', permissionOrgIds: ['root-1'] },
    });

    mockHoldsTeamAccess.mockResolvedValue(false);
    const res = makeRes();
    await (switchOrg as any)({
      user: { sub: 'u1', sid: 's1', organizationId: 'root-1', permissions: ['members:manage'] },
      headers: {},
      body: { organizationId: 'team-1' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSwitchSessionOrg).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    // The refused team must not become where the next sign-in lands — sign-in
    // does not re-ask for team_access:open.
    expect(mockSetLastActiveOrg).not.toHaveBeenCalled();
  });

  it('checks team_access:open in the ANCESTOR, not in the org the caller\'s token is for', async () => {
    // Regression: the check read the CURRENT token's permissions. A caller active
    // in their personal org (whose Roles grant team_access:open) could enter a
    // team under a parent org whose Roles do not.
    const user = { _id: 'u1' };
    mockSwitchActiveOrg.mockResolvedValue({
      user,
      authority: { role: 'admin', via: 'ancestor', inheritedFromOrgId: 'root-1', permissionOrgIds: ['root-1'] },
    });
    mockHoldsTeamAccess.mockResolvedValue(false);

    const res = makeRes();
    await (switchOrg as any)({
      user: { sub: 'u1', sid: 's1', organizationId: 'personal-1', permissions: ['team_access:open'] },
      headers: {},
      body: { organizationId: 'team-1' },
    }, res);

    expect(mockHoldsTeamAccess).toHaveBeenCalledWith(user, 'root-1');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSwitchSessionOrg).not.toHaveBeenCalled();
  });

  it('does NOT require team_access:open for a MEMBERSHIP switch', async () => {
    mockSwitchActiveOrg.mockResolvedValue({ user: { _id: 'u1' }, authority: MEMBER });

    const res = makeRes();
    await (switchOrg as any)({
      user: { sub: 'u1', sid: 's1', organizationId: 'org-from', permissions: [] },
      headers: {},
      body: { organizationId: 'org-to' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockHoldsTeamAccess).not.toHaveBeenCalled();
  });

  it('admits a superadmin on the inherited path — the flag implies every permission', async () => {
    // The loaded account's flag (not the token's) decides, inside the helper.
    mockHoldsTeamAccess.mockImplementation(async (u: any) => u.isSuperAdmin === true);
    mockSwitchActiveOrg.mockResolvedValue({
      user: { _id: 'u1', isSuperAdmin: true },
      authority: { role: 'admin', via: 'ancestor', inheritedFromOrgId: 'root-1', permissionOrgIds: ['root-1'] },
    });

    const res = makeRes();
    await (switchOrg as any)({
      user: { sub: 'u1', sid: 's1', organizationId: 'root-1', isSuperAdmin: true },
      headers: {},
      body: { organizationId: 'team-1' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('400s a non-string organizationId before any lookup', async () => {
    for (const organizationId of [['org-to', 'org-x'], { $ne: null }, 42, '']) {
      const res = makeRes();
      await (switchOrg as any)({ user: { sub: 'u1', organizationId: 'org-from', sid: 's1' }, headers: {}, body: { organizationId } }, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(mockSwitchActiveOrg).not.toHaveBeenCalled();
    expect(mockSwitchSessionOrg).not.toHaveBeenCalled();
  });

  it('does NOT audit when the user is not an active member (403)', async () => {
    mockSwitchActiveOrg.mockResolvedValue(null);

    const res = makeRes();
    await (switchOrg as any)({ user: { sub: 'u1', organizationId: 'org-from' }, headers: {}, body: { organizationId: 'org-x' } }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('switchOrg — session slot', () => {
  it('moves the caller\'s refresh-session slot instead of opening or rotating one', async () => {
    const user = { _id: 'u1' };
    mockSwitchActiveOrg.mockResolvedValue({ user, authority: MEMBER });
    const res = makeRes();
    await (switchOrg as any)({ user: { sub: 'u1', organizationId: 'org-from', sid: 's1' }, headers: {}, body: { organizationId: 'org-to' } }, res);

    // The device details of the switching request are recorded on the slot too.
    expect(mockSwitchSessionOrg).toHaveBeenCalledWith(user, 'org-to', 's1', expect.objectContaining({ client: expect.anything() }));
    expect(mockRenewSessionTokens).not.toHaveBeenCalled();
    expect(mockIssueTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    // The completed switch is what the next sign-in opens in.
    expect(mockSetLastActiveOrg).toHaveBeenCalledWith('u1', 'org-to');
  });

  /**
   * REGRESSION: switch-org is authenticated by an ACCESS token alone. It used to
   * mint a fresh refresh token (cookie for the browser, body for the CLI) — so
   * anyone holding a 15-minute access token could turn it into a long-lived
   * login, rotating the legitimate holder's refresh token out on the way.
   */
  it.each([
    ['a browser', { 'x-pb-client': 'web' }],
    ['a CLI', { 'x-pb-client': 'cli' }],
    ['an unlabelled caller', {}],
  ])('returns ONLY an access token to %s — no refresh token in the body, no cookie set or cleared', async (_label, headers) => {
    mockSwitchActiveOrg.mockResolvedValue({ user: { _id: 'u1' }, authority: MEMBER });
    const res = makeRes();
    await (switchOrg as any)({ user: { sub: 'u1', organizationId: 'org-from', sid: 's1' }, headers, body: { organizationId: 'org-to' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { accessToken: 'a-switched', expiresIn: 900 } }));
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('refreshToken');
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
  });

  it('401s when the caller\'s slot is gone — and leaves the next sign-in where it was', async () => {
    mockSwitchActiveOrg.mockResolvedValue({ user: { _id: 'u1' }, authority: MEMBER });
    mockSwitchSessionOrg.mockResolvedValue('session-invalid');
    const res = makeRes();
    await (switchOrg as any)({ user: { sub: 'u1', sid: 's1' }, headers: {}, body: { organizationId: 'org-to' } }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0]).toMatchObject({ code: 'TOKEN_REVOKED' });
    expect(mockSetLastActiveOrg).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('403s SESSION_POLICY_REAUTH_REQUIRED when the session is too old for the destination\'s policy — nothing recorded', async () => {
    mockSwitchActiveOrg.mockResolvedValue({ user: { _id: 'u1' }, authority: MEMBER });
    mockSwitchSessionOrg.mockResolvedValue('session-expired');
    const res = makeRes();
    await (switchOrg as any)({ user: { sub: 'u1', sid: 's1' }, headers: {}, body: { organizationId: 'org-to' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_POLICY_REAUTH_REQUIRED' }));
    expect(mockSetLastActiveOrg).not.toHaveBeenCalled();
  });

  it('403s when the org stops resolving between the gate and the mint — nothing recorded', async () => {
    mockSwitchActiveOrg.mockResolvedValue({ user: { _id: 'u1' }, authority: MEMBER });
    mockSwitchSessionOrg.mockResolvedValue('org-unavailable');
    const res = makeRes();
    await (switchOrg as any)({ user: { sub: 'u1', sid: 's1' }, headers: {}, body: { organizationId: 'org-to' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockSetLastActiveOrg).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('refresh — reuse revokes one slot', () => {
  it('rotates the presented token\'s slot', async () => {
    const user = { _id: 'u1' };
    mockFindForTokenIssue.mockResolvedValue(user);
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    res.locals.presentedRefreshToken = 'rt';
    res.locals.refreshSessionKind = 'interactive';
    await (refresh as any)({ user: { sub: 'u1', organizationId: 'org-1' }, headers: {}, body: {} }, res);

    // The slot's own kind is required to match: a device's token rotates its
    // interactive slot, a machine credential's its machine slot.
    expect(mockRenewSessionTokens).toHaveBeenCalledWith(
      user, 'org-1', { sessionId: 's1', presentedToken: 'rt', kind: 'interactive' },
      expect.objectContaining({ client: expect.anything() }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each([
    ['"user" — real input since the last refresh', { activity: 'user' }, 'user'],
    ['"passive" — a background poll', { activity: 'passive' }, 'passive'],
    ['missing — a client that never reports activity times out', {}, 'passive'],
    ['anything else', { activity: 'USER!' }, 'passive'],
  ])('passes the activity signal through: %s', async (_label, body, activity) => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    res.locals.presentedRefreshToken = 'rt';
    res.locals.refreshSessionKind = 'interactive';
    await (refresh as any)({ user: { sub: 'u1', organizationId: 'org-1' }, headers: {}, body }, res);
    expect(mockRenewSessionTokens).toHaveBeenCalledWith(
      expect.anything(), 'org-1', expect.anything(), expect.objectContaining({ activity }),
    );
  });

  it('on a rotation miss revokes ONLY that slot — never every session', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockResolvedValue(null);
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    res.locals.presentedRefreshToken = 'old';
    await (refresh as any)({ user: { sub: 'u1' }, headers: {}, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockRevokeRefreshSession).toHaveBeenCalledWith('u1', 's1');
    expect(mockInvalidateAllSessions).not.toHaveBeenCalled();
    // Presumed theft is counted, so a spike pages rather than hiding in logs.
    expect(mockIncCounter).toHaveBeenCalledWith('platform_refresh_reuse_total');
  });
});

describe('refresh — an expired session', () => {
  it('answers 401 SESSION_EXPIRED, clears the cookie, and records no reuse', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockRejectedValue(new Error('SESSION_EXPIRED'));
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    res.locals.presentedRefreshToken = 'rt';
    res.locals.refreshSessionKind = 'interactive';
    await (refresh as any)({ user: { sub: 'u1' }, headers: {}, body: {} }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_EXPIRED' }));
    expect(res.clearCookie).toHaveBeenCalled();
    // `renewSessionTokens` already dropped the slot; this is no theft.
    expect(mockRevokeRefreshSession).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('platform_session_expired_total', { kind: 'interactive' });
    expect(mockIncCounter).not.toHaveBeenCalledWith('platform_refresh_reuse_total');
  });

  it('says WHICH bound ended it: idle, with the effective timeout in minutes', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockRejectedValue(Object.assign(new Error('SESSION_EXPIRED'), { reason: 'idle', idleTimeoutMinutes: 15 }));
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    res.locals.presentedRefreshToken = 'rt';
    res.locals.refreshSessionKind = 'interactive';
    await (refresh as any)({ user: { sub: 'u1' }, headers: {}, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SESSION_EXPIRED', details: { reason: 'idle', idleTimeoutMinutes: 15 },
    }));
  });

  it('lets any other renewal error through to the controller\'s error handling', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockRejectedValue(new Error('boom'));
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    res.locals.presentedRefreshToken = 'rt';
    await (refresh as any)({ user: { sub: 'u1' }, headers: {}, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('refresh — the 30-second rotation grace', () => {
  const refreshWith = async (presented: string, sessionId = 's1') => {
    const res = makeRes();
    res.locals.refreshSessionId = sessionId;
    res.locals.presentedRefreshToken = presented;
    res.locals.refreshSessionKind = 'interactive';
    await (refresh as any)({ user: { sub: 'u1' }, headers: { 'x-pb-client': 'cli' }, body: {} }, res);
    return res;
  };

  it('a concurrent loser presenting the IMMEDIATELY-PREVIOUS token gets the current pair — no revocation', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockResolvedValueOnce({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 });
    await refreshWith('old'); // the winner rotates old → r2
    mockRenewSessionTokens.mockResolvedValueOnce(null);
    const res = await refreshWith('old'); // the racing loser

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 } }));
    expect(mockRevokeRefreshSession).not.toHaveBeenCalled();
  });

  it('the grace is per slot: the same token against another slot is still reuse', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockResolvedValueOnce({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 });
    await refreshWith('old', 's1');
    mockRenewSessionTokens.mockResolvedValueOnce(null);
    const res = await refreshWith('old', 's2');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockRevokeRefreshSession).toHaveBeenCalledWith('u1', 's2');
  });
});

describe('logout — current slot only', () => {
  it('revokes the access token\'s slot and nothing else', async () => {
    const res = makeRes();
    await (logout as any)({ user: { sub: 'u1', sid: 's1' }, headers: {}, body: {} }, res);
    expect(mockRevokeRefreshSession).toHaveBeenCalledWith('u1', 's1');
    expect(mockInvalidateAllSessions).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('clears the refresh cookie — only the server can, it is HttpOnly', async () => {
    const res = makeRes();
    await (logout as any)({ user: { sub: 'u1', sid: 's1' }, headers: { 'x-pb-client': 'web' }, body: {} }, res);
    expect(res.clearCookie).toHaveBeenCalledWith('pb_refresh', expect.objectContaining({ httpOnly: true, path: '/api/auth/refresh' }));
  });
});

describe('refresh — transport', () => {
  const browserReq = (extra: Record<string, unknown> = {}) =>
    ({ user: { sub: 'u1', organizationId: 'org-1' }, headers: { 'x-pb-client': 'web' }, body: {}, ...extra }) as any;

  it('rotates the browser\'s cookie and keeps the refresh token out of the body', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 });
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    res.locals.presentedRefreshToken = 'rt';

    await (refresh as any)(browserReq(), res);

    expect(res.cookie).toHaveBeenCalledWith('pb_refresh', 'r2', expect.objectContaining({ httpOnly: true, sameSite: 'strict' }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { accessToken: 'a2', expiresIn: 900 } }));
  });

  it('hands a CLI caller both tokens in the body, with no cookie', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 });
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    res.locals.presentedRefreshToken = 'rt';

    await (refresh as any)(browserReq({ headers: { 'x-pb-client': 'cli' } }), res);

    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 },
    }));
  });

  it('drops the cookie when the slot is revoked, so the browser stops retrying a dead credential', async () => {
    mockFindForTokenIssue.mockResolvedValue({ _id: 'u1' });
    mockRenewSessionTokens.mockResolvedValue(null);
    const res = makeRes();
    res.locals.refreshSessionId = 's1';
    res.locals.presentedRefreshToken = 'old';

    await (refresh as any)(browserReq(), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.clearCookie).toHaveBeenCalledWith('pb_refresh', expect.anything());
  });
});
