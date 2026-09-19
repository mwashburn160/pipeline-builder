// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/org-hierarchy-service.ts — the recently-deleted team list, the team
 * branch of restore (parent eligibility, seats, tier/entitlement re-sync) and
 * sysadmin reparenting (`move`) with its structural refusals and the re-sync of
 * everything pooled at the account root.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

interface Org {
  _id: string;
  name?: string;
  parentOrgId?: string | null;
  tier?: string;
  featureEntitlements?: string[];
  deletedAt?: Date | null;
  purgeAfter?: Date | null;
  isSystem?: boolean;
  quotas?: { seats?: number };
}

const orgs = new Map<string, Org>();
/** orgId → active member user ids. */
const members = new Map<string, string[]>();
/** orgId → live pending invite emails. */
const invites = new Map<string, string[]>();
/** userId → lastActiveOrgId. */
const lastActive = new Map<string, string>();

const mockOrgUpdateOne = jest.fn(async (..._a: unknown[]) => ({}));
const mockUserUpdateMany = jest.fn(async (..._a: unknown[]) => ({}));
const mockOrgFind = jest.fn();
const mockPublish = jest.fn(async (..._a: unknown[]) => undefined);
/** Billing's `GET /billing/subscriptions/by-org/:orgId/billable` answer. */
const mockBillingGet = jest.fn(async (..._a: unknown[]): Promise<unknown> => ({ statusCode: 200, body: { data: { billable: false } } }));

const chain = <T>(value: T) => {
  const c: any = { lean: async () => value, select: () => c, session: () => c, sort: () => c };
  return c;
};
const idsIn = (q: any): string[] => (q.organizationId?.$in ?? [q.organizationId]).map(String);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  SYSTEM_ORG_ID: 'sys',
  DEFAULT_TIER: 'developer',
  createSafeClient: () => ({ get: (...a: unknown[]) => mockBillingGet(...a) }),
  getServiceAuthHeader: () => 'Bearer svc',
  tierAllowsTeams: (t: string | undefined) => t === 'team' || t === 'enterprise',
  QUOTA_TIERS: {
    developer: { limits: { plugins: 5, seats: 1, eventRetentionDays: 7, doraRetentionDays: 30 } },
    pro: { limits: { plugins: 10, seats: 3, eventRetentionDays: 30, doraRetentionDays: 90 } },
    team: { limits: { plugins: 50, seats: 10, eventRetentionDays: 30, doraRetentionDays: 180 } },
    enterprise: { limits: { plugins: -1, seats: -1, eventRetentionDays: -1, doraRetentionDays: -1 } },
  },
}));
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { billing: { enabled: true, serviceHost: 'billing', servicePort: 3000, serviceTimeout: 1000 } },
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({ publishUsersRevocation: (...a: unknown[]) => mockPublish(...a) }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({ withMongoTransaction: (fn: (s: unknown) => unknown) => fn({ id: 'tx' }) }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  // Live scope: self + live direct children.
  expandOrgScope: async (id: string) => [id, ...[...orgs.values()].filter((o) => o.parentOrgId === id && !o.deletedAt).map((o) => o._id)],
  hasAnyChildOrg: async (id: string) => [...orgs.values()].some((o) => o.parentOrgId === id),
  isAncestorOrg: async (a: string, b: string) => {
    let cur = orgs.get(b)?.parentOrgId;
    while (cur) { if (cur === a) return true; cur = orgs.get(cur)?.parentOrgId; }
    return false;
  },
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    findById: (id: string) => chain(orgs.get(String(id)) ?? null),
    find: (q: unknown) => chain(mockOrgFind(q)),
    updateOne: (...a: unknown[]) => mockOrgUpdateOne(...a),
  },
  UserOrganization: {
    distinct: (_f: string, q: any) => ({ session: async () => [...new Set(idsIn(q).flatMap((id) => members.get(id) ?? []))] }),
  },
  Invitation: {
    distinct: (_f: string, q: any) => ({ session: async () => [...new Set(idsIn(q).flatMap((id) => invites.get(id) ?? []))] }),
  },
  User: {
    find: (q: { lastActiveOrgId: string }) => chain([...lastActive].filter(([, org]) => org === q.lastActiveOrgId).map(([_id]) => ({ _id }))),
    updateMany: (...a: unknown[]) => mockUserUpdateMany(...a),
  },
}));

const { orgHierarchyService } = await import('../src/services/org-hierarchy-service.js');

const ROOT_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ROOT_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const TEAM = 'cccccccccccccccccccccccc';
const SOLO = 'dddddddddddddddddddddddd';

beforeEach(() => {
  jest.clearAllMocks();
  orgs.clear(); members.clear(); invites.clear(); lastActive.clear();
  orgs.set(ROOT_A, { _id: ROOT_A, name: 'A', tier: 'team', featureEntitlements: ['sso'], quotas: { seats: 10 } });
  orgs.set(ROOT_B, { _id: ROOT_B, name: 'B', tier: 'enterprise', featureEntitlements: ['audit_log'], quotas: { seats: 5 } });
  orgs.set(TEAM, { _id: TEAM, name: 'T', tier: 'team', parentOrgId: ROOT_A, featureEntitlements: ['sso'] });
  orgs.set(SOLO, { _id: SOLO, name: 'S', tier: 'pro', quotas: { seats: 3 } });
  members.set(ROOT_B, ['b1', 'b2']);
  members.set(TEAM, ['t1', 't2']);
});

describe('listDeletedTeams', () => {
  it('queries soft-deleted teams of the parent still inside the window, newest first', async () => {
    const deletedAt = new Date();
    const purgeAfter = new Date(Date.now() + 86400_000);
    mockOrgFind.mockReturnValue([{ _id: TEAM, name: 'T', deletedAt, purgeAfter }]);

    const result = await orgHierarchyService.listDeletedTeams(ROOT_A);

    const [q] = mockOrgFind.mock.calls[0] as [any];
    expect(q.parentOrgId).toBe(ROOT_A);
    expect(q.deletedAt).toEqual({ $ne: null });
    expect(q.purgeAfter.$gt).toBeInstanceOf(Date);
    expect(result).toEqual({ teams: [{ orgId: TEAM, orgName: 'T', deletedAt, purgeAfter }] });
  });
});

describe('prepareTeamRestore', () => {
  it('re-syncs tier + entitlements from the live, eligible parent', async () => {
    await expect(orgHierarchyService.prepareTeamRestore(TEAM, ROOT_A, {} as any))
      .resolves.toEqual({ tier: 'team', featureEntitlements: ['sso'] });
  });

  it('refuses when the parent is gone / soft-deleted, or can no longer hold teams', async () => {
    await expect(orgHierarchyService.prepareTeamRestore(TEAM, 'missing', {} as any)).rejects.toThrow('ORG_RESTORE_PARENT_GONE');
    orgs.set(ROOT_A, { ...orgs.get(ROOT_A)!, deletedAt: new Date() });
    await expect(orgHierarchyService.prepareTeamRestore(TEAM, ROOT_A, {} as any)).rejects.toThrow('ORG_RESTORE_PARENT_GONE');
    orgs.set(ROOT_A, { ...orgs.get(ROOT_A)!, deletedAt: null, tier: 'pro' });
    await expect(orgHierarchyService.prepareTeamRestore(TEAM, ROOT_A, {} as any)).rejects.toThrow('ORG_RESTORE_PARENT_INELIGIBLE');
  });

  it('refuses when the returning members would push the account over its seat cap', async () => {
    orgs.set(TEAM, { ...orgs.get(TEAM)!, deletedAt: new Date() });
    orgs.set(ROOT_A, { ...orgs.get(ROOT_A)!, quotas: { seats: 3 } });
    members.set(ROOT_A, ['a1', 'a2']);
    await expect(orgHierarchyService.prepareTeamRestore(TEAM, ROOT_A, {} as any)).rejects.toThrow('ORG_SEAT_LIMIT');

    // The same people already seated elsewhere in the account cost nothing.
    members.set(TEAM, ['a1', 'a2']);
    await expect(orgHierarchyService.prepareTeamRestore(TEAM, ROOT_A, {} as any)).resolves.toBeDefined();
  });
});

describe('move — refusals', () => {
  it.each([
    ['the system org', 'sys', ROOT_B, 'ORG_MOVE_SYSTEM'],
    ['into the system org', TEAM, 'sys', 'ORG_MOVE_SYSTEM'],
    ['self-parenting', TEAM, TEAM, 'ORG_MOVE_SELF'],
    ['a missing org', 'eeeeeeeeeeeeeeeeeeeeeeee', ROOT_B, 'ORG_NOT_FOUND'],
    ['a root with teams under another org', ROOT_A, ROOT_B, 'ORG_MOVE_HAS_TEAMS'],
    ['into its own team (cycle)', ROOT_A, TEAM, 'ORG_MOVE_CYCLE'],
    ['under a team (two levels deep)', SOLO, TEAM, 'ORG_MOVE_TARGET_NOT_ROOT'],
    ['under a tier without teams', TEAM, SOLO, 'ORG_MOVE_TARGET_TIER'],
    ['to where it already is', TEAM, ROOT_A, 'ORG_MOVE_NOOP'],
    ['a root to standalone', SOLO, null, 'ORG_MOVE_NOOP'],
    ['to a missing destination', TEAM, 'ffffffffffffffffffffffff', 'ORG_MOVE_TARGET_NOT_FOUND'],
  ] as const)('refuses %s', async (_label, orgId, parent, code) => {
    await expect(orgHierarchyService.move(orgId, parent)).rejects.toThrow(code);
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
  });

  it('refuses a root whose only teams are SOFT-deleted (a restore would nest two deep)', async () => {
    orgs.set(TEAM, { ...orgs.get(TEAM)!, deletedAt: new Date() });
    await expect(orgHierarchyService.move(ROOT_A, ROOT_B)).rejects.toThrow('ORG_MOVE_HAS_TEAMS');
  });

  it('refuses a soft-deleted org, and a soft-deleted destination', async () => {
    orgs.set(TEAM, { ...orgs.get(TEAM)!, deletedAt: new Date() });
    await expect(orgHierarchyService.move(TEAM, ROOT_B)).rejects.toThrow('ORG_MOVE_DELETED');
    orgs.set(TEAM, { ...orgs.get(TEAM)!, deletedAt: null });
    orgs.set(ROOT_B, { ...orgs.get(ROOT_B)!, deletedAt: new Date() });
    await expect(orgHierarchyService.move(TEAM, ROOT_B)).rejects.toThrow('ORG_MOVE_TARGET_NOT_FOUND');
  });

  it('refuses a move that would put the destination over its seat cap', async () => {
    orgs.set(ROOT_B, { ...orgs.get(ROOT_B)!, quotas: { seats: 3 } }); // b1, b2 + t1, t2 = 4
    await expect(orgHierarchyService.move(TEAM, ROOT_B)).rejects.toThrow('ORG_SEAT_LIMIT');
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
  });
});

describe('move — re-sync', () => {
  it('team → another root: takes the new root\'s tier + entitlements, keeps -1 quotas, cuts scoped sessions', async () => {
    lastActive.set('parent-admin', TEAM); // inherited-authority session from the OLD parent
    const result = await orgHierarchyService.move(TEAM, ROOT_B);

    const [filter, update] = mockOrgUpdateOne.mock.calls[0] as [any, any];
    expect(filter).toEqual({ _id: TEAM });
    expect(update.$set).toEqual({
      parentOrgId: ROOT_B,
      tier: 'enterprise',
      featureEntitlements: ['audit_log'],
      quotas: { plugins: -1, seats: -1, eventRetentionDays: -1, doraRetentionDays: -1 },
    });
    const [uFilter, uUpdate] = mockUserUpdateMany.mock.calls[0] as [any, any];
    expect(new Set(uFilter._id.$in)).toEqual(new Set(['t1', 't2', 'parent-admin']));
    expect(uUpdate).toEqual({ $inc: { tokenVersion: 1 } });
    expect(mockPublish).toHaveBeenCalled();
    expect(result).toEqual({ orgId: TEAM, fromParentOrgId: ROOT_A, toParentOrgId: ROOT_B, tier: 'enterprise', membersInvalidated: 3 });
  });

  it('team → standalone: drops to the default tier (no subscription follows it — no free paid tier), reseeds its root quotas, clears entitlements', async () => {
    members.set(TEAM, ['t1']);
    const result = await orgHierarchyService.move(TEAM, null);

    const [, update] = mockOrgUpdateOne.mock.calls[0] as [any, any];
    expect(update.$set).toEqual({ parentOrgId: null, tier: 'developer', featureEntitlements: [], quotas: { plugins: 5, seats: 1 } });
    expect(result).toMatchObject({ toParentOrgId: null, tier: 'developer' });
    // A team never held a subscription — billing isn't consulted.
    expect(mockBillingGet).not.toHaveBeenCalled();
  });

  it('team → standalone is refused when its members exceed the default tier\'s seat preset', async () => {
    members.set(TEAM, ['t1', 't2']); // developer preset: 1 seat
    await expect(orgHierarchyService.move(TEAM, null)).rejects.toThrow('ORG_SEAT_LIMIT');
  });

  it('root without teams → team under a root: seeded exactly like a created team', async () => {
    members.set(SOLO, ['s1']);
    await orgHierarchyService.move(SOLO, ROOT_A);
    expect(String(mockBillingGet.mock.calls[0][0])).toBe(`/billing/subscriptions/by-org/${SOLO}/billable`);

    const [, update] = mockOrgUpdateOne.mock.calls[0] as [any, any];
    expect(update.$set).toEqual({
      parentOrgId: ROOT_A,
      tier: 'team',
      featureEntitlements: ['sso'],
      quotas: { plugins: -1, seats: -1, eventRetentionDays: -1, doraRetentionDays: -1 },
    });
  });
});

describe('move — a root being nested must have no billable subscription', () => {
  beforeEach(() => { members.set(SOLO, ['s1']); });

  it('refuses while billing reports a billable subscription', async () => {
    mockBillingGet.mockResolvedValueOnce({ statusCode: 200, body: { data: { billable: true } } });
    await expect(orgHierarchyService.move(SOLO, ROOT_A)).rejects.toThrow('ORG_MOVE_BILLED');
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
  });

  it.each([
    ['a billing error', { statusCode: 500, body: {} }],
    ['an unreachable billing service', null],
    ['an answer without the flag', { statusCode: 200, body: { data: {} } }],
  ])('fails closed on %s', async (_label, resp) => {
    mockBillingGet.mockResolvedValueOnce(resp);
    await expect(orgHierarchyService.move(SOLO, ROOT_A)).rejects.toThrow('ORG_MOVE_BILLING_UNVERIFIED');
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
  });
});
