// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Support-contact designation — the write surface that makes the add-on work.
 *
 * WHY THIS MATTERS MORE THAN ITS SIZE SUGGESTS. `canOpenCase` is
 * `ownOrgContacts > 0`, so an org with nobody designated can never open a case
 * however much support it has bought — and the support send still SUCCEEDS, it
 * just lands as a plain message with no case number and no response target. The
 * store functions shipped with no route and no caller, which made the entire
 * ladder unreachable and visible only as a rising
 * `support_cases_total{action="unentitled"}`.
 *
 * Four behaviours carry the design, and each is asserted from both sides:
 *
 *  - THE TWO SCOPES. The cap pools subtree-wide (an account buys contacts once,
 *    like seats) while ownership is own-org. So `canDesignate` comes from the
 *    account-level entitlement, and the list and revoke act on ONE org id. A
 *    revoke that reached the subtree would let a parent silently strip a
 *    sibling team's contact.
 *  - MEMBERSHIP, not mere existence. A contact speaks for the org to the support
 *    desk, so a user from another tenant must not be nominated even though the
 *    allowance is shared across the account.
 *  - THE TWO REFUSALS ARE DISTINCT. "No support add-on" and "all contacts in
 *    use" need different fixes (buy a level / free a slot), and an admin who
 *    cannot tell them apart buys the wrong thing. They must not collapse into
 *    one 403.
 *  - REVOKE IS NOT BLOCKED on the contact's open cases (scope C4) — refusing to
 *    remove a departed employee because they still own cases would be worse
 *    than handing the cases on — so the cases come back in the response and the
 *    count is audited.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockEntitlement = jest.fn<AnyFn>();
const mockDesignate = jest.fn<AnyFn>();
const mockCountPremium = jest.fn<AnyFn>();
const mockSetPremium = jest.fn<AnyFn>();
const mockRevoke = jest.fn<AnyFn>();
const mockListContacts = jest.fn<AnyFn>();
const mockAudit = jest.fn<AnyFn>();
const mockMembership = jest.fn<AnyFn>();
const mockUserFind = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (p: any, k: string) => p?.[k],
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown, message?: string) =>
    res.status(status).json({ success: true, data, message }),
}));

jest.unstable_mockModule('mongoose', () => {
  // `Types.ObjectId` is used only to re-serialise a validated 24-hex string, so
  // a value that stringifies back is all the controller needs.
  class ObjectId {
    private readonly v: string;
    constructor(v: string) { this.v = v; }
    toString() { return this.v; }
  }
  const api = { Types: { ObjectId }, models: {}, model: jest.fn<AnyFn>() };
  return { ...api, default: api };
});

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  designateSupportContact: (...a: unknown[]) => mockDesignate(...a),
  countPremiumSupportContacts: (...a: unknown[]) => mockCountPremium(...a),
  setSupportContactPremium: (...a: unknown[]) => mockSetPremium(...a),
  revokeSupportContact: (...a: unknown[]) => mockRevoke(...a),
  listActiveSupportContacts: (...a: unknown[]) => mockListContacts(...a),
}));

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: mockAudit }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock({
  // The tenancy gate is proven by its own suite; here it is held open so these
  // tests exercise the entitlement/membership logic rather than re-testing it.
  requireOrgScope: async () => true,
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  resolveOrgLineage: async () => ({ rootOrgId: 'root' }),
  // root + two teams, so a subtree-scoped count is distinguishable from an
  // own-org one by the array it receives.
  expandOrgScope: async () => ['root', 'org-1', 'org-2'],
}));
jest.unstable_mockModule('../src/helpers/support-entitlement.js', () => ({
  supportEntitlement: (...a: unknown[]) => mockEntitlement(...a),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: { find: (...a: unknown[]) => ({ select: () => ({ lean: () => mockUserFind(...a) }) }) },
  UserOrganization: {
    findOne: (...a: unknown[]) => ({ select: () => ({ lean: () => mockMembership(...a) }) }),
  },
}));

const { addSupportContact, listSupportContacts, removeSupportContact, setSupportContactLevel } =
  await import('../src/controllers/support-contacts.js');

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}
const answered = (res: any) => ({
  status: res.status.mock.calls[0]?.[0] as number | undefined,
  body: res.json.mock.calls[0]?.[0] as any,
});

/** A 24-hex id, which is the only shape the controller accepts. */
const USER = 'a1b2c3d4e5f60718293a4b5c';
const OTHER = '0f1e2d3c4b5a69788796a5b4';
const req = (over: Record<string, unknown> = {}) => ({
  user: { sub: 'admin-1' },
  params: { id: 'org-1' },
  body: {},
  ...over,
});

/** An entitlement with room by default; override per test. */
const entitled = (over: Record<string, unknown> = {}) => mockEntitlement.mockResolvedValue({
  level: 'support_priority',
  premium: true,
  premiumLimit: 2,
  limit: 5,
  used: 2,
  ownOrgContacts: 2,
  canDesignate: true,
  canOpenCase: true,
  ...over,
});

const call = async (handler: unknown, r: Record<string, unknown> = {}) => {
  const res = mockRes();
  await (handler as (a: any, b: any) => Promise<void>)(req(r), res);
  return answered(res);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockListContacts.mockResolvedValue([]);
  mockUserFind.mockResolvedValue([]);
  mockMembership.mockResolvedValue({ _id: 'member-1' });
  mockRevoke.mockResolvedValue({ revoked: true, openCases: [] });
  mockCountPremium.mockResolvedValue(0);
  mockSetPremium.mockResolvedValue(true);
  entitled();
});

describe('listSupportContacts', () => {
  it('reports the POOLED allowance alongside the OWN-ORG list', async () => {
    // The distinction the UI depends on: `used` counts sibling teams the caller
    // may not administer, so a panel showing it as this org's own count makes a
    // refused third designation look like a bug.
    mockListContacts.mockResolvedValue([{ orgId: 'org-1', userId: USER }]);
    mockUserFind.mockResolvedValue([{ _id: USER, username: 'ada', email: 'ada@x.test' }]);
    const { status, body } = await call(listSupportContacts);
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ level: 'support_priority', limit: 5, used: 2, canDesignate: true });
    expect(body.data.contacts).toEqual([{ userId: USER, username: 'ada', email: 'ada@x.test' }]);
    // ONE org id, never the expanded subtree.
    expect(mockListContacts).toHaveBeenCalledWith(['org-1']);
  });

  it('skips the name lookup entirely when there are no contacts', async () => {
    await call(listSupportContacts);
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('reports a contact whose account is gone without inventing a name', async () => {
    // A revoked row is kept as the record that somebody once held the slot, so
    // a user id can outlive its user. Showing a bare ObjectId would read as a
    // person's name.
    mockListContacts.mockResolvedValue([{ orgId: 'org-1', userId: USER }]);
    mockUserFind.mockResolvedValue([]);
    const { body } = await call(listSupportContacts);
    expect(body.data.contacts).toEqual([{ userId: USER, username: null, email: null }]);
  });

  it('tolerates a malformed stored user id rather than throwing', async () => {
    mockListContacts.mockResolvedValue([{ orgId: 'org-1', userId: 'not-an-object-id' }]);
    const { status, body } = await call(listSupportContacts);
    expect(status).toBe(200);
    expect(body.data.contacts).toHaveLength(1);
    expect(mockUserFind).not.toHaveBeenCalled();
  });
});

describe('addSupportContact', () => {
  it('designates a member and audits the entitlement AS IT WAS', async () => {
    const { status, body } = await call(addSupportContact, { body: { userId: USER } });
    expect(status).toBe(201);
    // `isPremium` is echoed even when false, so a caller never has to infer the
    // level it got from the absence of a field.
    expect(body.data).toEqual({ userId: USER, isPremium: false });
    expect(mockDesignate).toHaveBeenCalledWith('org-1', USER, 'admin-1', false);
    // level/limit/usedBefore: a later dispute about who was entitled to raise a
    // case turns on what was true when they were nominated, not on what the
    // account holds today.
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'support.contact.designate', expect.objectContaining({
      targetType: 'support_contact',
      targetId: USER,
      affectedOrgId: 'org-1',
      details: { level: 'support_priority', limit: 5, usedBefore: 2, premium: false },
    }));
  });

  it('rejects anything that is not a 24-hex user id, before any lookup', async () => {
    for (const userId of [undefined, '', 'nope', 12, null, `${USER}xx`]) {
      const out = await call(addSupportContact, { body: { userId } });
      expect(out.status).toBe(400);
    }
    expect(mockEntitlement).not.toHaveBeenCalled();
    expect(mockDesignate).not.toHaveBeenCalled();
  });

  it('refuses NO ADD-ON and AT CAP with different messages', async () => {
    // Different problems, different fixes. Collapsing them into one 403 is how
    // an admin ends up buying a level they already have.
    entitled({ level: null, canDesignate: false });
    const noAddon = await call(addSupportContact, { body: { userId: USER } });
    expect(noAddon.status).toBe(403);
    expect(noAddon.body.message).toMatch(/no support add-on/i);

    jest.clearAllMocks();
    mockMembership.mockResolvedValue({ _id: 'm' });
    entitled({ canDesignate: false, used: 5 });
    const atCap = await call(addSupportContact, { body: { userId: USER } });
    expect(atCap.status).toBe(403);
    expect(atCap.body.message).toMatch(/All 5 support contacts are in use/);
    // And it says the cap is the ACCOUNT's, since the slot to free may be in
    // another team entirely.
    expect(atCap.body.message).toMatch(/across this account/);
    expect(mockDesignate).not.toHaveBeenCalled();
  });

  it('refuses a user who is not an ACTIVE member of this org', async () => {
    // The allowance pools across the account; membership does not. A sibling
    // team's member must not be nominated here.
    mockMembership.mockResolvedValue(null);
    const out = await call(addSupportContact, { body: { userId: OTHER } });
    expect(out.status).toBe(404);
    expect(out.body.message).toMatch(/not an active member/);
    expect(mockDesignate).not.toHaveBeenCalled();
  });

  it('checks membership against THIS org and only active edges', async () => {
    await call(addSupportContact, { body: { userId: USER } });
    const filter = mockMembership.mock.calls[0]![0] as Record<string, unknown>;
    expect(String(filter.organizationId)).toBe('org-1');
    expect(filter.isActive).toBe(true);
    expect(String(filter.userId)).toBe(USER);
  });

  it('checks the cap BEFORE membership, so a full account is told the truth', async () => {
    // Order matters: an at-cap account nominating a non-member should hear
    // "you are at your cap", which is the blocker they must act on, not "that
    // person is not a member", which they would fix and then hit the cap anyway.
    entitled({ canDesignate: false });
    mockMembership.mockResolvedValue(null);
    const out = await call(addSupportContact, { body: { userId: USER } });
    expect(out.status).toBe(403);
    expect(mockMembership).not.toHaveBeenCalled();
  });

  it('never audits a refusal', async () => {
    entitled({ level: null });
    await call(addSupportContact, { body: { userId: USER } });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('removeSupportContact', () => {
  const remove = (userId: string = USER) =>
    call(removeSupportContact, { params: { id: 'org-1', userId } });

  it('revokes and audits', async () => {
    const out = await remove();
    expect(out.status).toBe(200);
    expect(mockRevoke).toHaveBeenCalledWith('org-1', USER, 'admin-1');
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'support.contact.revoke', expect.objectContaining({
      targetId: USER,
      details: { openCasesLeftBehind: 0 },
    }));
  });

  it('revokes DESPITE open cases, and hands them back to be reassigned', async () => {
    // Scope C4. Blocking the revoke would mean a departed employee cannot be
    // removed while they still own a case, which is worse than the orphan.
    mockRevoke.mockResolvedValue({
      revoked: true,
      openCases: [
        { threadId: 't1', displayNumber: 7, status: 'open', orgId: 'org-1', severity: 'high' },
        { threadId: 't2', displayNumber: 9, status: 'awaiting_customer', orgId: 'org-1', severity: 'normal' },
      ],
    });
    const out = await remove();
    expect(out.status).toBe(200);
    // Thread ids and numbers only — the case bodies are the message service's
    // to serve, and this response must not become a second case reader.
    expect(out.body.data.openCases).toEqual([
      { threadId: 't1', displayNumber: 7, status: 'open' },
      { threadId: 't2', displayNumber: 9, status: 'awaiting_customer' },
    ]);
    expect(out.body.message).toMatch(/2 open case\(s\)/);
    // The count is audited, so an orphaned case is a recorded fact rather than
    // something discovered weeks later.
    expect(mockAudit.mock.calls[0]![2]).toMatchObject({ details: { openCasesLeftBehind: 2 } });
  });

  it('404s a user who is not a contact here, and audits nothing', async () => {
    mockRevoke.mockResolvedValue({ revoked: false, openCases: [] });
    const out = await remove();
    expect(out.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('rejects a malformed user id without touching the store', async () => {
    const out = await remove('nope');
    expect(out.status).toBe(400);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('scopes the revoke to ONE org, never the subtree', async () => {
    // A subtree-scoped revoke would let a parent strip a sibling team's contact.
    await remove();
    expect(mockRevoke.mock.calls[0]![0]).toBe('org-1');
  });

  it('does not need an entitlement to remove somebody', async () => {
    // An account whose add-on lapsed must still be able to tidy up its
    // contacts; gating the revoke on the entitlement would strand them.
    entitled({ level: null, canDesignate: false });
    expect((await remove()).status).toBe(200);
  });
});

describe('the premium UPGRADE', () => {
  // Premium is an upgrade applied per contact, not a third level: an account
  // holds one baseline covering every contact and upgrades a subset. These
  // handlers answer to `supportPremiumContacts`, a different cap from the one
  // designation answers to — which is exactly why they are a separate verb.
  const level = (userId: string, premium: unknown) =>
    call(setSupportContactLevel, { params: { id: 'org-1', userId }, body: { premium } });

  it('upgrades a contact and audits WHO was entitled to 24x7', async () => {
    const out = await level(USER, true);
    expect(out.status).toBe(200);
    expect(out.body.data).toEqual({ userId: USER, isPremium: true });
    expect(mockSetPremium).toHaveBeenCalledWith('org-1', USER, true);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'support.contact.upgrade', expect.objectContaining({
      targetId: USER,
      details: { premium: true, premiumLimit: 2 },
    }));
  });

  it('uses a DIFFERENT audit action for a downgrade', async () => {
    // One action for both directions would lose the fact a dispute turns on:
    // whether this person was entitled to out-of-hours coverage at the time.
    await level(USER, false);
    expect(mockAudit.mock.calls[0]![1]).toBe('support.contact.downgrade');
  });

  it('counts the upgrade cap over the SUBTREE, because it pools', async () => {
    // An upgrade spent in a sibling team is still spent. A single-org count
    // here would let each team spend the account's upgrades over again.
    mockCountPremium.mockResolvedValue(1);
    await level(USER, true);
    expect(mockCountPremium).toHaveBeenCalledWith(['root', 'org-1', 'org-2']);
  });

  it('refuses an upgrade when every upgrade is in use, naming the number', async () => {
    mockCountPremium.mockResolvedValue(2);
    const out = await level(USER, true);
    expect(out.status).toBe(403);
    expect(out.body.message).toMatch(/All 2 Premium Support upgrade\(s\) are in use/);
    expect(out.body.message).toMatch(/across this account/);
    expect(mockSetPremium).not.toHaveBeenCalled();
  });

  it('refuses an upgrade when the account holds no premium add-on', async () => {
    // Distinct from the at-cap refusal: different problem, different fix.
    entitled({ premium: false, premiumLimit: 0 });
    const out = await level(USER, true);
    expect(out.status).toBe(403);
    expect(out.body.message).toMatch(/no Premium Support upgrade/i);
  });

  it('allows an UNLIMITED upgrade cap without counting at all', async () => {
    entitled({ premiumLimit: -1 });
    expect((await level(USER, true)).status).toBe(200);
    expect(mockCountPremium).not.toHaveBeenCalled();
  });

  it('ALWAYS allows a downgrade, even with no add-on and at the cap', async () => {
    // An account whose premium add-on lapsed still has to be able to tidy up
    // contacts left marked as upgraded; gating the downgrade would strand them.
    entitled({ premium: false, premiumLimit: 0 });
    mockCountPremium.mockResolvedValue(99);
    expect((await level(USER, false)).status).toBe(200);
    expect(mockSetPremium).toHaveBeenCalledWith('org-1', USER, false);
  });

  it('rejects a non-boolean premium and a malformed user id', async () => {
    for (const v of [undefined, 'yes', 1, null]) {
      expect((await level(USER, v)).status).toBe(400);
    }
    expect((await level('nope', true)).status).toBe(400);
    expect(mockSetPremium).not.toHaveBeenCalled();
  });

  it('404s a user who is not a contact here', async () => {
    mockSetPremium.mockResolvedValue(false);
    const out = await level(USER, true);
    expect(out.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('touches NO case rows, because the level is frozen at open', async () => {
    // Downgrading must not weaken a promise already made: a case this contact
    // raised while upgraded keeps its 24x7 target. That is the whole point of
    // freezing `support_case.level`, and it is why this handler needs no case
    // access at all.
    await level(USER, false);
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockListContacts).not.toHaveBeenCalled();
  });
});

describe('designation can upgrade in the same step', () => {
  it('designates AND upgrades when asked', async () => {
    const out = await call(addSupportContact, { body: { userId: USER, premium: true } });
    expect(out.status).toBe(201);
    expect(out.body.data).toEqual({ userId: USER, isPremium: true });
    expect(mockDesignate).toHaveBeenCalledWith('org-1', USER, 'admin-1', true);
    expect(mockAudit.mock.calls[0]![2]).toMatchObject({ details: { premium: true } });
  });

  it('REFUSES rather than silently designating at the baseline', async () => {
    // An admin who asked for 24x7 and quietly got business hours would not find
    // out until a 3am case went unanswered.
    mockCountPremium.mockResolvedValue(2);
    const out = await call(addSupportContact, { body: { userId: USER, premium: true } });
    expect(out.status).toBe(403);
    expect(mockDesignate).not.toHaveBeenCalled();
  });

  it('designates at the baseline when premium is not asked for', async () => {
    const out = await call(addSupportContact, { body: { userId: USER } });
    expect(out.status).toBe(201);
    expect(mockDesignate).toHaveBeenCalledWith('org-1', USER, 'admin-1', false);
    expect(mockCountPremium).not.toHaveBeenCalled();
  });
});
