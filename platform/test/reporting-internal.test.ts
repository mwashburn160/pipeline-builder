// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/internal/reporting/*`: the facts a SCHEDULED stakeholder report needs, which the
 * reporting service cannot know on its own.
 *
 * What matters here is what these endpoints refuse to say. They exist so a scheduler can
 * re-check a definition's owner, and a report can show an access posture, without platform
 * handing over the org's address book, the person's full permission set, or a list of who
 * has no second factor:
 *
 *  - `report-authority` returns ONLY the `reports:*` family, and one flat
 *    `active: false` for every reason a run should stop;
 *  - `recipient-check` answers about ONE address the caller already holds, and
 *    never enumerates members;
 *  - `access-posture` returns COUNTS. A report that named the members without a second
 *    factor would be a ready-made target list, and it would reach managers with no
 *    permission to see that in the product.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER = 'user-lead';

const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockMemberFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockMembership = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockMemberFind = jest.fn<(...a: unknown[]) => unknown>();
const mockTotpDistinct = jest.fn<(...a: unknown[]) => unknown>();
const mockPasskeyDistinct = jest.fn<(...a: unknown[]) => unknown>();
const mockIdpFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockServiceAccountCount = jest.fn<(...a: unknown[]) => unknown>();
const mockPatCount = jest.fn<(...a: unknown[]) => unknown>();
const mockAuditCount = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, data }),
}));

jest.unstable_mockModule('mongoose', () => {
  class ObjectId {
    v: string;
    constructor(v: string) { this.v = v; }
    toString() { return this.v; }
    static isValid(v: unknown) { return typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v); }
  }
  const api = { Types: { ObjectId } };
  return { ...api, default: api };
});

/** A `Model.findX().select().lean()` chain that resolves to whatever `fn` returns. */
const one = (fn: (...a: unknown[]) => unknown) => {
  const chain = (...args: unknown[]) => {
    const c = { select: () => c, lean: () => Promise.resolve(fn(...args)) };
    return c;
  };
  return chain;
};

/** A `Model.find().select().lean()` chain over MANY rows. */
const many = (fn: (...a: unknown[]) => unknown) => {
  const chain = (...args: unknown[]) => {
    const c = { select: () => c, lean: () => Promise.resolve(fn(...args)) };
    return c;
  };
  return chain;
};

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { findById: one(mockUserFindById), findOne: one(mockUserFindOne) },
  UserOrganization: { findOne: one(mockMemberFindOne), find: many(mockMemberFind) },
  UserTotp: { distinct: (...a: unknown[]) => Promise.resolve(mockTotpDistinct(...a)) },
  WebAuthnCredential: { distinct: (...a: unknown[]) => Promise.resolve(mockPasskeyDistinct(...a)) },
  OrgIdpConfig: { findOne: one(mockIdpFindOne) },
  ServiceAccount: { countDocuments: (...a: unknown[]) => Promise.resolve(mockServiceAccountCount(...a)) },
  PersonalAccessToken: { countDocuments: (...a: unknown[]) => Promise.resolve(mockPatCount(...a)) },
  AuditEvent: { countDocuments: (...a: unknown[]) => Promise.resolve(mockAuditCount(...a)) },
}));

jest.unstable_mockModule('../src/services/session/membership-context.js', () => ({
  membershipForOrg: (...a: unknown[]) => mockMembership(...a),
}));

const { getReportAuthority, getRecipientCheck, getAccessPosture } = await import('../src/controllers/reporting-internal.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}
const body = (res: any) => res.json.mock.calls[0][0];
const data = (res: any) => body(res).data;

beforeEach(() => {
  jest.clearAllMocks();
  mockUserFindById.mockReturnValue({ _id: USER, isSuperAdmin: false });
  mockMembership.mockResolvedValue({
    organizationId: ORG,
    role: 'member',
    tier: 'team',
    rolePermissions: ['reports:read', 'reports:author', 'pipelines:write', 'members:manage'],
    featureEntitlements: ['stakeholder_reports'],
  });
});

describe('GET /internal/reporting/report-authority/:orgId/:userId', () => {
  const call = (orgId = ORG, userId = USER) => {
    const res = mockRes();
    return getReportAuthority({ params: { orgId, userId }, query: {} } as any, res).then(() => res);
  };

  it('answers with the reporting permissions the owner still holds', async () => {
    const res = await call();
    expect(data(res).active).toBe(true);
    expect(data(res).permissions).toEqual(['reports:read', 'reports:author']);
  });

  /**
   * A scheduler has no business learning what else this person can do. The filter
   * is an allow-list, so a new permission elsewhere in the catalog cannot start
   * leaking through here.
   */
  it('returns ONLY the reports:* family, never the rest of the permission set', async () => {
    const res = await call();
    expect(data(res).permissions).not.toContain('members:manage');
    expect(data(res).permissions).not.toContain('pipelines:write');
  });

  it('reports the org’s resolved entitlements, so a lapsed add-on stops the next run', async () => {
    const res = await call();
    expect(data(res).features).toContain('stakeholder_reports');
    expect(data(res).tier).toBe('team');
  });

  it('drops the add-on from the answer once the entitlement is gone', async () => {
    mockMembership.mockResolvedValue({ tier: 'team', rolePermissions: ['reports:author'], featureEntitlements: [] });
    const res = await call();
    expect(data(res).features).not.toContain('stakeholder_reports');
  });

  /**
   * One flat `active: false` for every stop condition. `membershipForOrg` already
   * collapses them — no membership row, a deactivated membership, a soft-deleted
   * org — and the caller's behaviour is identical for all of them (pause the
   * definition), so distinguishing them here would only disclose more.
   */
  it.each([
    ['the account does not exist', () => { mockUserFindById.mockReturnValue(null); }],
    ['the membership is gone, deactivated, or the org is torn down', () => { mockMembership.mockResolvedValue(undefined); }],
  ])('answers active:false with no permissions when %s', async (_case, arrange) => {
    arrange();
    const res = await call();
    expect(data(res)).toEqual({ active: false, permissions: [], features: [] });
  });

  it('gives a superadmin every feature, as the tier resolver does everywhere else', async () => {
    mockUserFindById.mockReturnValue({ _id: USER, isSuperAdmin: true });
    const res = await call();
    expect(data(res).features).toContain('stakeholder_reports');
  });

  it('refuses a malformed org id or user id before any read', async () => {
    const res = await call('not-an-org');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockMembership).not.toHaveBeenCalled();

    const res2 = await call(ORG, 'a'.repeat(200));
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  it('lowercases the org id so it matches the RLS scope', async () => {
    await call(ORG.toUpperCase());
    expect(mockMembership).toHaveBeenCalledWith(USER, ORG);
  });
});

describe('GET /internal/reporting/recipient-check/:orgId', () => {
  const call = (email: unknown, orgId = ORG) => {
    const res = mockRes();
    return getRecipientCheck({ params: { orgId }, query: { email } } as any, res).then(() => res);
  };

  beforeEach(() => {
    mockUserFindOne.mockReturnValue({ _id: 'user-2', username: 'Dana Ng' });
    mockMemberFindOne.mockReturnValue({ _id: 'membership-1' });
  });

  it('confirms a member and returns their display name', async () => {
    const res = await call('Dana@Acme.test');
    expect(data(res)).toEqual({ member: true, userId: 'user-2', displayName: 'Dana Ng' });
  });

  it('normalizes the address before looking it up', async () => {
    await call('  DANA@ACME.TEST  ');
    expect(mockUserFindOne).toHaveBeenCalledWith({ email: 'dana@acme.test' });
  });

  it('omits the display name when the account has no name on it', async () => {
    mockUserFindOne.mockReturnValue({ _id: 'user-2' });
    expect(data(await call('dana@acme.test'))).toEqual({ member: true, userId: 'user-2' });
  });

  /** A bare `{ member: false }` — never "no such user", which would be an oracle. */
  it.each([
    ['there is no such account', () => { mockUserFindOne.mockReturnValue(null); }],
    ['the account has no live membership in this org', () => { mockMemberFindOne.mockReturnValue(null); }],
  ])('answers member:false and nothing else when %s', async (_case, arrange) => {
    arrange();
    expect(data(await call('someone@else.test'))).toEqual({ member: false });
  });

  it('only counts an ACTIVE membership in the named org', async () => {
    await call('dana@acme.test');
    expect(mockMemberFindOne).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
  });

  it.each([
    ['a missing email', undefined],
    ['a non-string email', ['a@b.test']],
    ['something that is not an address', 'nope'],
    ['an address longer than the column', `${'a'.repeat(320)}@acme.test`],
  ])('refuses %s before any read', async (_case, email) => {
    const res = await call(email);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockUserFindOne).not.toHaveBeenCalled();
  });

  it('refuses a malformed org id', async () => {
    const res = await call('dana@acme.test', 'nope');
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('GET /internal/reporting/access-posture/:orgId', () => {
  const FROM = '2026-09-14T00:00:00.000Z';
  const TO = '2026-09-21T00:00:00.000Z';

  const call = (query: Record<string, unknown> = { from: FROM, to: TO }, orgId = ORG) => {
    const res = mockRes();
    return getAccessPosture({ params: { orgId }, query } as any, res).then(() => res);
  };

  beforeEach(() => {
    mockMemberFind.mockReturnValue([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]);
    mockTotpDistinct.mockReturnValue(['u1', 'u2']);
    mockPasskeyDistinct.mockReturnValue(['u1']);
    mockIdpFindOne.mockReturnValue({ ssoRequired: true });
    mockServiceAccountCount.mockReturnValue(4);
    mockPatCount.mockReturnValue(7);
    mockAuditCount.mockReturnValue(3);
  });

  it('returns counts, and nothing that names a person', async () => {
    const posture = data(await call());
    expect(posture).toEqual({
      members: 3,
      membersWithMfa: 2,
      ssoRequired: true,
      serviceAccounts: 4,
      activeApiKeys: 7,
      permissionChanges: 3,
    });
    // The property that matters: no ids, no emails, no role names. A report that named the
    // accounts without a second factor would be a target list.
    for (const value of Object.values(posture as Record<string, unknown>)) {
      expect(typeof value === 'number' || typeof value === 'boolean').toBe(true);
    }
  });

  it('counts a person with BOTH factors once', async () => {
    // One passkey holder (u1) and two confirmed authenticators, one of which is u1's. A
    // sum would report 3 of 3 protected when only 2 accounts are.
    mockPasskeyDistinct.mockReturnValue(['u1']);
    mockTotpDistinct.mockReturnValue(['u1', 'u2']);
    expect((data(await call()) as { membersWithMfa: number }).membersWithMfa).toBe(2);
  });

  it('never reports coverage above the member count', async () => {
    // Somebody with three passkeys is ONE protected account; counting credentials would
    // put coverage over 100%.
    mockPasskeyDistinct.mockReturnValue(['u1', 'u2', 'u3']);
    mockTotpDistinct.mockReturnValue([]);
    const posture = data(await call()) as { members: number; membersWithMfa: number };
    expect(posture.membersWithMfa).toBeLessThanOrEqual(posture.members);
  });

  it('counts only ACTIVE memberships of the named org', async () => {
    await call();
    expect(mockMemberFind).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
  });

  it('counts only CONFIRMED authenticator enrolments', async () => {
    await call();
    // An enrolment nobody finished is not a factor, and counting it would report an org as
    // protected when it is not.
    expect(mockTotpDistinct).toHaveBeenCalledWith('userId', expect.objectContaining({ activatedAt: { $ne: null } }));
  });

  it('counts only live API keys', async () => {
    await call();
    const filter = mockPatCount.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter.revokedAt).toBeNull();
    expect(filter.expiresAt).toMatchObject({ $gt: expect.any(Date) });
  });

  it('counts only enabled service accounts', async () => {
    await call();
    expect(mockServiceAccountCount).toHaveBeenCalledWith(expect.objectContaining({ disabled: false }));
  });

  it('counts permission changes by AFFECTED org, inside the window', async () => {
    await call();
    const filter = mockAuditCount.mock.calls[0]?.[0] as Record<string, unknown>;
    // `affectedOrgId`, not `orgId`: a sysadmin acting on this org carries the SYSTEM org in
    // `orgId`, and a permission change made by one is exactly what the org wants counted.
    expect(filter.affectedOrgId).toBe(ORG);
    expect(filter.createdAt).toMatchObject({ $gte: new Date(FROM), $lt: new Date(TO) });
  });

  it('reports ssoRequired false when the org has no IdP configured', async () => {
    mockIdpFindOne.mockReturnValue(null);
    expect((data(await call()) as { ssoRequired: boolean }).ssoRequired).toBe(false);
  });

  it('reads nothing for an org with no members', async () => {
    mockMemberFind.mockReturnValue([]);
    const posture = data(await call()) as { members: number; membersWithMfa: number };
    expect(posture).toMatchObject({ members: 0, membersWithMfa: 0 });
    // No member ids to ask about, so the factor queries are skipped entirely rather than
    // sent an empty `$in`.
    expect(mockTotpDistinct).not.toHaveBeenCalled();
    expect(mockPasskeyDistinct).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing window', {}],
    ['a malformed from', { from: 'nope', to: TO }],
    ['a malformed to', { from: FROM, to: 'nope' }],
    ['a backwards window', { from: TO, to: FROM }],
  ])('refuses %s before any read', async (_case, query) => {
    const res = await call(query);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockMemberFind).not.toHaveBeenCalled();
  });

  it('refuses a malformed org id', async () => {
    const res = await call({ from: FROM, to: TO }, 'nope');
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
