// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/users` admin views must not leak ANOTHER tenant's org through the target's
 * `lastActiveOrgId`.
 *
 * Each user row's org fields (`organizationId`, `organizationName`, `role`)
 * were built from the target's last-active org — which, for a person who
 * belongs to several orgs, is routinely somebody else's tenant. An org admin
 * listing their own roster therefore learned the id, name and the person's role
 * in an org they have no relationship with. For anyone but a system admin the
 * org fields now describe the target's membership in the CALLER's org only.
 *
 * Runs the REAL controller-helper scope logic and the REAL response shaper;
 * only the service and the hierarchy walk are stubbed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGetUserIdsInOrg = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockList = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockHasMembership = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const mockGetByIdWithOrgs = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUpdateUserById = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockIsAncestorOrg = jest.fn<(...a: unknown[]) => Promise<boolean>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (r: any, status: number, message: string, code?: string) => r.status(status).json({ success: false, message, code }),
  sendSuccess: (r: any, status: number, data: unknown) => r.status(status).json({ success: true, data }),
  isSystemOrgId: () => false,
  validateBulkArray: jest.fn(),
  isValidFeatureFlag: () => true,
  resolveUserFeatures: jest.fn(() => []),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ isAncestorOrg: (...a: unknown[]) => mockIsAncestorOrg(...a) }));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ auth: { passwordMinLength: 8 } }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: () => ({ select: () => ({ lean: async () => null }) }) },
}));
jest.unstable_mockModule('../src/services/index.js', () => ({
  userAdminService: {
    getUserIdsInOrg: (...a: unknown[]) => mockGetUserIdsInOrg(...a),
    list: (...a: unknown[]) => mockList(...a),
    hasMembershipInOrg: (...a: unknown[]) => mockHasMembership(...a),
    getByIdWithOrgs: (...a: unknown[]) => mockGetByIdWithOrgs(...a),
    updateUserById: (...a: unknown[]) => mockUpdateUserById(...a),
    lookupPrimaryOrgId: async () => 'org-mine',
  },
  apiKeyService: {},
}));
jest.unstable_mockModule('../src/utils/validation.js', () => ({
  adminCreateUserSchema: {}, adminUpdateUserSchema: {}, validateBody: (_s: unknown, body: unknown) => body,
}));

const { listAllUsers, getUserById, updateUserById } = await import('../src/controllers/user-admin.js');

const MINE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbbbbbbbbbbbbbbbbbb';

/** An org admin (members:manage) of MINE. */
const ORG_ADMIN = { sub: 'admin-1', role: 'admin', isAdmin: true, organizationId: MINE, permissions: ['members:manage'] };
const SYSADMIN = { sub: 'op', isSuperAdmin: true, permissions: [] };

/** A person in both orgs whose last-active org is the FOREIGN tenant. */
const target = () => ({
  _id: { toString: () => 'u2' },
  username: 'bob',
  email: 'bob@example.com',
  isEmailVerified: true,
  lastActiveOrgId: FOREIGN,
});
const memberships = [
  { organizationId: FOREIGN, role: 'owner' },
  { organizationId: MINE, role: 'member' },
];
const orgNameMap = new Map([[FOREIGN, 'Rival Corp'], [MINE, 'My Org']]);

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  return r;
}
const call = async (handler: unknown, req: Record<string, unknown>) => {
  const r = res();
  await (handler as (q: unknown, s: unknown) => Promise<void>)({ params: {}, query: {}, body: {}, ...req }, r);
  return r;
};
const payload = (r: any) => r.json.mock.calls[0][0].data;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserIdsInOrg.mockResolvedValue(['u2']);
  mockList.mockResolvedValue({ users: [target()], total: 1, membershipsByUser: new Map([['u2', memberships]]), orgNameMap });
  mockHasMembership.mockResolvedValue(true);
  mockIsAncestorOrg.mockResolvedValue(false);
  mockGetByIdWithOrgs.mockResolvedValue({
    user: target(),
    memberships,
    orgMap: new Map([
      [FOREIGN, { _id: FOREIGN, name: 'Rival Corp', slug: 'rival', tier: 'pro' }],
      [MINE, { _id: MINE, name: 'My Org', slug: 'mine', tier: 'developer' }],
    ]),
  });
});

describe('GET /users — org fields come from the caller\'s org only', () => {
  it('an org admin sees the target as a member of THEIR org, not the target\'s last-active (foreign) org', async () => {
    const r = await call(listAllUsers, { user: ORG_ADMIN });
    expect(r.status).toHaveBeenCalledWith(200);
    const [row] = payload(r).users;

    expect(row).toMatchObject({ organizationId: MINE, organizationName: 'My Org', role: 'member' });
    expect(JSON.stringify(row)).not.toContain(FOREIGN);
    expect(JSON.stringify(row)).not.toContain('Rival Corp');
  });

  it('a team-scoped listing describes the target in that team', async () => {
    const TEAM = 'cccccccccccccccccccccccc';
    mockIsAncestorOrg.mockImplementation(async (a, t) => a === MINE && t === TEAM);
    mockList.mockResolvedValue({
      users: [target()],
      total: 1,
      membershipsByUser: new Map([['u2', [...memberships, { organizationId: TEAM, role: 'admin' }]]]),
      orgNameMap: new Map([...orgNameMap, [TEAM, 'Team A']]),
    });
    const r = await call(listAllUsers, { user: ORG_ADMIN, query: { organizationId: TEAM } });
    const [row] = payload(r).users;
    expect(row).toMatchObject({ organizationId: TEAM, organizationName: 'Team A', role: 'admin' });
  });

  it('a system admin still sees each user\'s own last-active org (unchanged)', async () => {
    const r = await call(listAllUsers, { user: SYSADMIN });
    const [row] = payload(r).users;
    expect(row).toMatchObject({ organizationId: FOREIGN, organizationName: 'Rival Corp', role: 'owner' });
  });
});

describe('GET /users/:id — organizationId is the caller\'s org', () => {
  it('an org admin never receives the target\'s foreign lastActiveOrgId', async () => {
    const r = await call(getUserById, { user: ORG_ADMIN, params: { id: 'u2' } });
    expect(r.status).toHaveBeenCalledWith(200);
    const { user } = payload(r);
    expect(user).toMatchObject({ organizationId: MINE, organizationName: 'My Org', role: 'member' });
    expect(user.organizations).toEqual([{ id: MINE, name: 'My Org', role: 'member' }]);
    expect(JSON.stringify(user)).not.toContain(FOREIGN);
  });

  it('a system admin sees the last-active org (unchanged)', async () => {
    const r = await call(getUserById, { user: SYSADMIN, params: { id: 'u2' } });
    const { user } = payload(r);
    expect(user).toMatchObject({ organizationId: FOREIGN, organizationName: 'Rival Corp', role: 'owner' });
  });
});

describe('PATCH /users/:id — the response is scoped like the reads', () => {
  it('an org admin gets organizationId = their org, never the target\'s lastActiveOrgId', async () => {
    mockUpdateUserById.mockResolvedValue({ user: target(), changes: ['role'], organizationName: 'My Org', activeOrgRole: 'member' });
    const r = await call(updateUserById, { user: ORG_ADMIN, params: { id: 'u2' }, body: { role: 'member' } });
    expect(r.status).toHaveBeenCalledWith(200);
    expect(payload(r).user).toMatchObject({ organizationId: MINE });
  });

  it('a system admin gets the target\'s lastActiveOrgId (unchanged)', async () => {
    mockUpdateUserById.mockResolvedValue({ user: target(), changes: ['role'], organizationName: 'Rival Corp', activeOrgRole: 'owner' });
    const r = await call(updateUserById, { user: SYSADMIN, params: { id: 'u2' }, body: { role: 'admin' } });
    expect(payload(r).user).toMatchObject({ organizationId: FOREIGN });
  });
});
