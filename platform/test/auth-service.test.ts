// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for AuthService.register + switchActiveOrg.
 *
 * The transaction body is exercised via a `withMongoTransaction` stub that
 * simply invokes the callback with a fake session — the model layer is fully
 * mocked, so what we assert is the ORCHESTRATION: dup-check short-circuits,
 * the `system`-org privileged branch sets tier/quotas/id, and a mid-flight
 * model failure propagates out (nothing downstream of the failure runs — the
 * real tx would abort, leaving no partial user/org/membership).
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockUserExists = jest.fn<(...a: unknown[]) => unknown>();
const mockUserFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUserSave = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUserUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockOrgCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockOrgUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockOrgFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUserOrgCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUserOrgFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockSeedDefaultGroups = jest.fn<(...a: unknown[]) => Promise<unknown>>();

// A recording constructor for `new User(...)`. Captures the last-constructed
// instance so tests can inspect what register() built.
let lastUser: any;
class MockUser {
  _id = { toString: () => 'user-1' };
  save = mockUserSave;
  [k: string]: unknown;
  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
    lastUser = this;
  }
  static exists = (...a: unknown[]) => mockUserExists(...a);
  static findOne = (...a: unknown[]) => mockUserFindOne(...a);
  static updateOne = (...a: unknown[]) => mockUserUpdateOne(...a);
  static findById = (...a: unknown[]) => mockUserFindById(...a);
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  SYSTEM_ORG_SLUG: 'system',
  SYSTEM_ORG_ID: '000000000000000000000001',
  QUOTA_TIERS: {
    enterprise: { limits: { plugins: -1, pipelines: -1, apiCalls: -1, aiCalls: -1, seats: -1, storage: -1 } },
  },
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { auth: { verificationTokenTtlMs: 1000 } },
}));

jest.unstable_mockModule('../src/helpers/org-id.js', () => ({
  toOrgId: (v: unknown) => v,
}));

jest.unstable_mockModule('../src/services/roles-service.js', () => ({
  seedDefaultRoles: (...a: unknown[]) => mockSeedDefaultGroups(...a),
}));

jest.unstable_mockModule('../src/utils/token.js', () => ({
  hashRefreshToken: (t: string) => `hash:${t}`,
}));

// Invoke the callback with a fake session — no real Mongo. This mirrors the
// real wrapper's contract closely enough for orchestration assertions: on
// throw, the error propagates (the real driver aborts the tx).
const fakeSession = { id: 'sess' };
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (fn: (s: unknown) => Promise<unknown>) => fn(fakeSession),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  User: MockUser,
  Organization: {
    create: (...a: unknown[]) => mockOrgCreate(...a),
    updateOne: (...a: unknown[]) => mockOrgUpdateOne(...a),
    find: (...a: unknown[]) => mockOrgFind(...a),
  },
  UserOrganization: {
    create: (...a: unknown[]) => mockUserOrgCreate(...a),
    findOne: (...a: unknown[]) => mockUserOrgFindOne(...a),
  },
}));

const { authService, DUPLICATE_CREDENTIALS, RESERVED_ORG_NAME } = await import('../src/services/auth-service.js');

const ORIGINAL_BOOTSTRAP_EMAILS = process.env.BOOTSTRAP_SUPERADMIN_EMAILS;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no operator-authorized emails, so 'system' is a reserved name that
  // no self-serve caller may claim.
  delete process.env.BOOTSTRAP_SUPERADMIN_EMAILS;
  lastUser = undefined;
  mockUserSave.mockResolvedValue(undefined);
  mockUserUpdateOne.mockResolvedValue(undefined);
  mockSeedDefaultGroups.mockResolvedValue(undefined);
  mockUserOrgCreate.mockResolvedValue(undefined);
  // Default: org.create echoes a doc with an _id/name derived from the input.
  mockOrgCreate.mockImplementation(async (arr: any) => {
    const data = arr[0];
    return [{ _id: data._id ?? { toString: () => 'org-1' }, name: data.name }];
  });
  mockOrgUpdateOne.mockResolvedValue(undefined);
});

afterAll(() => {
  if (ORIGINAL_BOOTSTRAP_EMAILS === undefined) delete process.env.BOOTSTRAP_SUPERADMIN_EMAILS;
  else process.env.BOOTSTRAP_SUPERADMIN_EMAILS = ORIGINAL_BOOTSTRAP_EMAILS;
});

describe('AuthService.register', () => {
  const base = { username: 'Alice', email: 'Alice@Example.com', password: 'Password1' };

  it('throws DUPLICATE_CREDENTIALS when email/username already exists (no org created)', async () => {
    mockUserExists.mockReturnValue({ session: () => Promise.resolve({ _id: 'dupe' }) });

    await expect(authService.register(base)).rejects.toThrow(DUPLICATE_CREDENTIALS);
    expect(mockOrgCreate).not.toHaveBeenCalled();
    expect(mockUserOrgCreate).not.toHaveBeenCalled();
    expect(mockSeedDefaultGroups).not.toHaveBeenCalled();
  });

  it('creates a normal org (owner membership + default groups) for a non-system name', async () => {
    mockUserExists.mockReturnValue({ session: () => Promise.resolve(null) });

    const result = await authService.register({ ...base, organizationName: 'Acme Corp', planId: 'pro' });

    expect(result).toMatchObject({
      email: 'Alice@Example.com',
      role: 'owner',
      organizationName: 'Acme Corp',
      planId: 'pro',
    });
    // Non-system org: no privileged fields set.
    const orgData = (mockOrgCreate.mock.calls[0] as any)[0][0];
    expect(orgData.name).toBe('Acme Corp');
    expect(orgData.isSystem).toBeUndefined();
    expect(orgData.tier).toBeUndefined();
    // Owner membership + groups seeded, tx used to build all three atomically.
    expect(mockUserOrgCreate).toHaveBeenCalledTimes(1);
    expect(mockSeedDefaultGroups).toHaveBeenCalledTimes(1);
    expect(mockUserSave).toHaveBeenCalledTimes(1);
  });

  it('falls back to the username when no (or too-short) org name is given', async () => {
    mockUserExists.mockReturnValue({ session: () => Promise.resolve(null) });

    const result = await authService.register({ ...base, organizationName: 'x' });
    const orgData = (mockOrgCreate.mock.calls[0] as any)[0][0];
    expect(orgData.name).toBe('Alice');
    expect(result.organizationName).toBe('Alice');
  });

  it('REJECTS a self-serve "system" org registration (no privileged branch, no org created)', async () => {
    // SECURITY (privilege-escalation regression): a self-serve caller whose email
    // is NOT operator-authorized must NOT be able to claim the reserved 'system'
    // org — otherwise the first anonymous POST /auth/register with
    // organizationName:'system' would seed SYSTEM_ORG_ID + isSuperAdmin.
    mockUserExists.mockReturnValue({ session: () => Promise.resolve(null) });

    await expect(authService.register({ ...base, organizationName: 'System' }))
      .rejects.toThrow(RESERVED_ORG_NAME);

    // Nothing privileged happened: no org, no membership, no superadmin seeding.
    expect(mockOrgCreate).not.toHaveBeenCalled();
    expect(mockUserOrgCreate).not.toHaveBeenCalled();
    expect(mockSeedDefaultGroups).not.toHaveBeenCalled();
  });

  it('allows the privileged system-org path ONLY for an operator-authorized email (bootstrap preserved)', async () => {
    // The controlled superadmin bootstrap (BOOTSTRAP_SUPERADMIN_EMAILS) must still
    // be able to create the system org — that's the LEGITIMATE path to the first
    // platform superadmin. base.email is 'Alice@Example.com'.
    process.env.BOOTSTRAP_SUPERADMIN_EMAILS = 'alice@example.com';
    mockUserExists.mockReturnValue({ session: () => Promise.resolve(null) });

    const result = await authService.register({ ...base, organizationName: 'System' });

    const orgData = (mockOrgCreate.mock.calls[0] as any)[0][0];
    expect(orgData.isSystem).toBe(true);
    expect(orgData.tier).toBe('enterprise');
    expect(orgData._id).toBe('000000000000000000000001');
    expect(orgData.slug).toBe('system');
    expect(orgData.quotas).toMatchObject({ aiCalls: -1, seats: -1 });
    expect(result.planId).toBe('enterprise');
    // seedDefaultGroups is told this is the system org (bootstraps superadmin).
    expect((mockSeedDefaultGroups.mock.calls[0] as any)[2]).toEqual({ isSystemOrg: true });
  });

  it('propagates a mid-transaction failure and does not run later steps (tx aborts)', async () => {
    mockUserExists.mockReturnValue({ session: () => Promise.resolve(null) });
    mockUserOrgCreate.mockRejectedValue(new Error('duplicate owner index'));

    await expect(authService.register(base)).rejects.toThrow('duplicate owner index');
    // Membership insert failed → user.save() and group seeding never happened.
    expect(mockUserSave).not.toHaveBeenCalled();
    expect(mockSeedDefaultGroups).not.toHaveBeenCalled();
  });
});

describe('AuthService.findOrCreateOAuthUser — reserved system org', () => {
  beforeEach(() => {
    // No existing OAuth/email match → the auto-create branch runs.
    mockUserFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
    // Username-probe: the candidate is otherwise free.
    mockUserExists.mockResolvedValue(false);
  });

  it('folds a self-serve identity that normalizes to "system" into a NORMAL namespaced org', async () => {
    // SECURITY (privilege-escalation regression): an unauthorized federated
    // identity whose name normalizes to 'system' must NOT auto-create the
    // privileged system org. The org must be a plain namespaced org — no fixed
    // SYSTEM_ORG_ID, no isSystem, no isSystemOrg seeding (which flags superadmin).
    await authService.findOrCreateOAuthUser('google', {
      id: 'oauth-1', email: 'evil@example.com', name: 'System',
    });

    const orgData = (mockOrgCreate.mock.calls[0] as any)[0][0];
    expect(orgData.name).not.toBe('system');
    expect(orgData.isSystem).toBeUndefined();
    expect(orgData._id).toBeUndefined();
    // seedDefaultRoles told this is NOT the system org → no superadmin bootstrap.
    expect((mockSeedDefaultGroups.mock.calls[0] as any)[2]).toEqual({ isSystemOrg: false });
  });

  it('allows the system org for an operator-authorized OAuth email (bootstrap preserved)', async () => {
    process.env.BOOTSTRAP_SUPERADMIN_EMAILS = 'ops@example.com';

    await authService.findOrCreateOAuthUser('google', {
      id: 'oauth-2', email: 'ops@example.com', name: 'System',
    });

    const orgData = (mockOrgCreate.mock.calls[0] as any)[0][0];
    expect(orgData.isSystem).toBe(true);
    expect(orgData._id).toBe('000000000000000000000001');
    expect((mockSeedDefaultGroups.mock.calls[0] as any)[2]).toEqual({ isSystemOrg: true });
  });
});

describe('AuthService pending-billing marker (paid-signup fail-open)', () => {
  it('setPendingBillingPlan writes the planId + stamps `since` only on first set', async () => {
    await authService.setPendingBillingPlan('org-42', 'pro');

    expect(mockOrgUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockOrgUpdateOne.mock.calls[0] as any;
    expect(filter).toEqual({ _id: 'org-42' });
    // Aggregation-pipeline update: sets planId and keeps the original `since`
    // (only fills it when absent) so retries don't reset the marker age.
    expect(Array.isArray(update)).toBe(true);
    expect(update[0].$set.pendingBillingPlanId).toBe('pro');
    expect(update[0].$set.pendingBillingSince).toEqual({ $ifNull: ['$pendingBillingSince', '$$NOW'] });
  });

  it('clearPendingBillingPlan unsets both marker fields', async () => {
    await authService.clearPendingBillingPlan('org-42');

    const [filter, update] = mockOrgUpdateOne.mock.calls[0] as any;
    expect(filter).toEqual({ _id: 'org-42' });
    expect(update).toEqual({ $unset: { pendingBillingPlanId: '', pendingBillingSince: '' } });
  });

  it('listPendingBillingOrgs returns {orgId, planId} for every marked org', async () => {
    mockOrgFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([
          { _id: { toString: () => 'org-a' }, pendingBillingPlanId: 'pro' },
          { _id: { toString: () => 'org-b' }, pendingBillingPlanId: 'team' },
        ]),
      }),
    });

    const result = await authService.listPendingBillingOrgs();

    // Scan targets only orgs that actually carry the marker.
    expect((mockOrgFind.mock.calls[0] as any)[0]).toEqual({
      pendingBillingPlanId: { $exists: true, $ne: null },
    });
    expect(result).toEqual([
      { orgId: 'org-a', planId: 'pro' },
      { orgId: 'org-b', planId: 'team' },
    ]);
  });
});

describe('AuthService.switchActiveOrg', () => {
  it('re-issues (returns the user) only after confirming an ACTIVE membership', async () => {
    const userDoc = { _id: 'user-1', isSuperAdmin: true };
    mockUserOrgFindOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'm1', isActive: true }) });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve(userDoc) });

    const result = await authService.switchActiveOrg('user-1', 'org-9');

    expect(result).toBe(userDoc);
    // Membership filter is active-scoped.
    expect((mockUserOrgFindOne.mock.calls[0] as any)[0]).toMatchObject({
      userId: 'user-1',
      organizationId: 'org-9',
      isActive: true,
    });
    expect(mockUserUpdateOne).toHaveBeenCalledWith(
      { _id: 'user-1' },
      { $set: { lastActiveOrgId: 'org-9' } },
    );
  });

  it('returns null and never mutates lastActiveOrgId when membership is absent/inactive', async () => {
    mockUserOrgFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const result = await authService.switchActiveOrg('user-1', 'org-forbidden');

    expect(result).toBeNull();
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
    expect(mockUserFindById).not.toHaveBeenCalled();
  });
});

describe('AuthService.markEmailVerifiedById', () => {
  function userDoc(overrides: Record<string, unknown> = {}) {
    return {
      _id: { toString: () => 'u1' },
      email: 'admin@internal',
      isEmailVerified: false,
      emailVerificationToken: 'x',
      emailVerificationExpires: new Date(),
      save: mockUserSave,
      ...overrides,
    };
  }

  it('marks an unverified user verified, clears the token, and saves', async () => {
    const doc = userDoc();
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve(doc) });

    const result = await authService.markEmailVerifiedById('u1');

    expect(result).toBe(doc);
    expect(doc.isEmailVerified).toBe(true);
    expect(doc.emailVerificationToken).toBeUndefined();
    expect(doc.emailVerificationExpires).toBeUndefined();
    expect(mockUserSave).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — an already-verified user is not re-saved', async () => {
    const doc = userDoc({ isEmailVerified: true });
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve(doc) });

    const result = await authService.markEmailVerifiedById('u1');

    expect(result).toBe(doc);
    expect(mockUserSave).not.toHaveBeenCalled();
  });

  it('returns null when the user id does not resolve', async () => {
    mockUserFindById.mockReturnValue({ select: () => Promise.resolve(null) });
    expect(await authService.markEmailVerifiedById('missing')).toBeNull();
    expect(mockUserSave).not.toHaveBeenCalled();
  });
});
