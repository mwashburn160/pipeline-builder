// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Just-in-time SSO provisioning (3a, services/sso-jit-service.ts).
 *
 * Every rule the plan names, one test each:
 *   - seats: the pooled check the invitation path runs, and the sign-in REFUSED
 *     (not silently seat-less) when the account is full — pre-flight and inside
 *     the transaction;
 *   - entitlement: JIT turns off with the `sso` entitlement, without withdrawing
 *     memberships or Roles that already exist;
 *   - platform admins are never provisioned;
 *   - the membership is created as a plain member (never owner) and only in the
 *     SSO org;
 *   - manual Role assignments survive a sync; JIT-owned ones don't.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockIsSsoEntitled = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockResolveMappedRoles = jest.fn<(...a: unknown[]) => Promise<{ roleIds: string[]; matchedGroups: string[] }>>();
const mockSeatCapacityAvailable = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockSeatStillWithinCap = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockUserHasSeat = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockSyncMappedRoles = jest.fn<(...a: unknown[]) => Promise<{ added: string[]; removed: string[] }>>();
const mockEnsureBaselineRole = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockRecompute = jest.fn<(...a: unknown[]) => Promise<void>>();
const mockIncCounter = jest.fn();
const mockPublishRevocation = jest.fn<(...a: unknown[]) => Promise<void>>();

const membershipFindOne = jest.fn<(...a: unknown[]) => unknown>();
const membershipCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const userFindOne = jest.fn<(...a: unknown[]) => unknown>();
const userFindById = jest.fn<(...a: unknown[]) => unknown>();
const userUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();

/** Chainable Mongoose query stub. */
function query(result: unknown) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.session = self; q.select = self;
  q.lean = async () => result;
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q;
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  isSsoEntitled: (...a: unknown[]) => mockIsSsoEntitled(...a),
}));

jest.unstable_mockModule('../src/services/idp-group-mapping-service.js', () => ({
  idpGroupMappingService: { resolveMappedRoles: (...a: unknown[]) => mockResolveMappedRoles(...a) },
  MAX_MAPPINGS_PER_ORG: 100,
}));

jest.unstable_mockModule('../src/services/mapped-roles.js', () => ({
  syncMappedRoles: (...a: unknown[]) => mockSyncMappedRoles(...a),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  ensureBaselineRole: (...a: unknown[]) => mockEnsureBaselineRole(...a),
  recomputeUserOrgRole: (...a: unknown[]) => mockRecompute(...a),
}));

jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  seatCapacityAvailable: (...a: unknown[]) => mockSeatCapacityAvailable(...a),
  seatCapacityStillWithinCap: (...a: unknown[]) => mockSeatStillWithinCap(...a),
  userHasSeatInAccount: (...a: unknown[]) => mockUserHasSeat(...a),
}));

jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishSessionSlotRevocation: async () => true,
  publishAccessKeyRevocation: async () => true,
  publishUserRevocation: (...a: unknown[]) => mockPublishRevocation(...a),
  publishUsersRevocation: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {
    findOne: (...a: unknown[]) => userFindOne(...a),
    findById: (...a: unknown[]) => userFindById(...a),
    updateOne: (...a: unknown[]) => userUpdateOne(...a),
  },
  UserOrganization: {
    findOne: (...a: unknown[]) => membershipFindOne(...a),
    create: (...a: unknown[]) => membershipCreate(...a),
  },
}));

jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: mockIncCounter }));

jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: async (fn: (s: unknown) => Promise<unknown>) => fn({}),
}));

const { assertJitSeatAvailable, provisionJitMembership } = await import('../src/services/sso-jit-service.js');
const { JIT_SEAT_LIMIT } = await import('../src/services/idp-mapping-errors.js');

const ORG = 'sso-org';
const user = (over: Record<string, unknown> = {}) => ({ _id: 'u1', tokenVersion: 3, ...over }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsSsoEntitled.mockResolvedValue(true);
  mockResolveMappedRoles.mockResolvedValue({ roleIds: [], matchedGroups: [] });
  mockSeatCapacityAvailable.mockResolvedValue(true);
  mockSeatStillWithinCap.mockResolvedValue(true);
  mockUserHasSeat.mockResolvedValue(false);
  mockSyncMappedRoles.mockResolvedValue({ added: [], removed: [] });
  membershipFindOne.mockReturnValue(query(null));
  membershipCreate.mockResolvedValue(undefined);
  userFindOne.mockReturnValue(query(null));
  userFindById.mockReturnValue(query({ tokenVersion: 4 }));
  userUpdateOne.mockResolvedValue(undefined);
});

describe('assertJitSeatAvailable (pre-flight, before an account exists)', () => {
  it('refuses the sign-in when the account is at its seat limit', async () => {
    mockSeatCapacityAvailable.mockResolvedValue(false);
    await expect(assertJitSeatAvailable(ORG, 'New@Acme.com')).rejects.toThrow(JIT_SEAT_LIMIT);
  });

  it('skips the check for someone who already holds a seat in the account', async () => {
    userFindOne.mockReturnValue(query({ _id: 'u1' }));
    mockUserHasSeat.mockResolvedValue(true);
    mockSeatCapacityAvailable.mockResolvedValue(false); // full — but no new seat needed
    await expect(assertJitSeatAvailable(ORG, 'member@acme.com')).resolves.toBeUndefined();
  });

  it('looks the caller up by lowercased email (matching the account link rule)', async () => {
    await assertJitSeatAvailable(ORG, 'Mixed@Case.com');
    expect(userFindOne).toHaveBeenCalledWith({ email: 'mixed@case.com' });
  });
});

describe('provisionJitMembership', () => {
  it('adds the membership as a plain MEMBER of the SSO org and applies the Member floor', async () => {
    mockResolveMappedRoles.mockResolvedValue({ roleIds: ['r1'], matchedGroups: ['eng'] });
    mockSyncMappedRoles.mockResolvedValue({ added: ['r1'], removed: [] });

    const out = await provisionJitMembership({ orgId: ORG, user: user(), groups: ['eng'] });

    expect(out).toMatchObject({ membershipCreated: true, matchedGroups: ['eng'], rolesAdded: ['r1'] });
    expect(membershipCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ userId: 'u1', organizationId: ORG, role: 'member' })],
      expect.anything(),
    );
    expect(mockEnsureBaselineRole).toHaveBeenCalled();
    // …and only ever in the SSO org.
    expect(mockSyncMappedRoles).toHaveBeenCalledWith(ORG, 'u1', ['r1'], expect.anything());
  });

  it('refuses (throws) when the account is over its seat cap', async () => {
    mockSeatCapacityAvailable.mockResolvedValue(false);
    await expect(provisionJitMembership({ orgId: ORG, user: user(), groups: [] }))
      .rejects.toThrow(JIT_SEAT_LIMIT);
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it('refuses when the POST-write re-check finds the account over cap (concurrent sign-in)', async () => {
    mockSeatStillWithinCap.mockResolvedValue(false);
    await expect(provisionJitMembership({ orgId: ORG, user: user(), groups: [] }))
      .rejects.toThrow(JIT_SEAT_LIMIT);
  });

  it('consumes no seat for someone already active elsewhere in the account', async () => {
    mockUserHasSeat.mockResolvedValue(true);
    mockSeatCapacityAvailable.mockResolvedValue(false); // full account
    const out = await provisionJitMembership({ orgId: ORG, user: user(), groups: [] });
    expect(out.membershipCreated).toBe(true);
    expect(mockSeatCapacityAvailable).not.toHaveBeenCalled();
  });

  it('is OFF when the org is not sso-entitled, and withdraws nothing', async () => {
    mockIsSsoEntitled.mockResolvedValue(false);
    const out = await provisionJitMembership({ orgId: ORG, user: user(), groups: ['eng'] });
    expect(out.skipped).toBe('not-entitled');
    expect(membershipCreate).not.toHaveBeenCalled();
    expect(mockSyncMappedRoles).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('platform_sso_jit_refused_total', { reason: 'not_entitled' });
  });

  it('never provisions a platform administrator', async () => {
    const out = await provisionJitMembership({ orgId: ORG, user: user({ isSuperAdmin: true }), groups: ['eng'] });
    expect(out.skipped).toBe('platform-admin');
    expect(mockIsSsoEntitled).not.toHaveBeenCalled();
    expect(membershipCreate).not.toHaveBeenCalled();
  });

  it('leaves a DEACTIVATED membership alone rather than silently reactivating it', async () => {
    membershipFindOne.mockReturnValue(query({ isActive: false }));
    const out = await provisionJitMembership({ orgId: ORG, user: user(), groups: ['eng'] });
    expect(out.skipped).toBe('membership-inactive');
    expect(mockSyncMappedRoles).not.toHaveBeenCalled();
  });

  it('syncs Roles for an EXISTING member without touching the membership row', async () => {
    membershipFindOne.mockReturnValue(query({ isActive: true }));
    mockResolveMappedRoles.mockResolvedValue({ roleIds: ['r2'], matchedGroups: ['sre'] });
    mockSyncMappedRoles.mockResolvedValue({ added: ['r2'], removed: ['r1'] });

    const out = await provisionJitMembership({ orgId: ORG, user: user(), groups: ['sre'] });

    expect(out).toMatchObject({ membershipCreated: false, rolesAdded: ['r2'], rolesRemoved: ['r1'] });
    expect(membershipCreate).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('platform_sso_jit_provisioned_total', { outcome: 'updated' });
  });

  it('refreshes the in-memory tokenVersion it bumped, so the new session is valid', async () => {
    mockSyncMappedRoles.mockResolvedValue({ added: ['r1'], removed: [] });
    userFindById.mockReturnValue(query({ tokenVersion: 9 }));
    const u = user();
    await provisionJitMembership({ orgId: ORG, user: u, groups: ['eng'] });
    expect((u as unknown as { tokenVersion: number }).tokenVersion).toBe(9);
    expect(mockPublishRevocation).toHaveBeenCalledWith('u1');
  });

  it('bumps nothing on a steady-state sign-in (already a member, Roles unchanged)', async () => {
    membershipFindOne.mockReturnValue(query({ isActive: true }));
    const u = user();
    const out = await provisionJitMembership({ orgId: ORG, user: u, groups: ['eng'] });
    expect(out).toMatchObject({ membershipCreated: false, rolesAdded: [], rolesRemoved: [] });
    expect(userUpdateOne).not.toHaveBeenCalled();
    expect((u as unknown as { tokenVersion: number }).tokenVersion).toBe(3);
    expect(mockPublishRevocation).not.toHaveBeenCalled();
  });
});
