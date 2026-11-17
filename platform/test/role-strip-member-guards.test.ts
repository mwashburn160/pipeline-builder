// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `assertActorMayStripMemberRoles` — the guards `removeUserFromRole` enforces,
 * applied to EVERY Role a person holds when their membership ends (remove) or
 * is suspended (deactivate).
 *
 * The bug: `removeMember` ran `RoleAssignment.deleteMany` with no checks, so a
 * `members:manage`-only "People Manager" could strip an admin (or a superadmin,
 * or an org's last admin) just by removing the person.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRaFind = jest.fn<AnyFn>();
const mockRaAggregate = jest.fn<AnyFn>();
const mockRoleFind = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => ({
  default: { Types: { ObjectId: class {} } },
  Types: { ObjectId: class {} },
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ recomputeUserOrgRole: jest.fn(async () => undefined) }));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: jest.fn(async () => undefined),
  publishUsersRevocation: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  PersonalAccessToken: {},
  UserPreferences: {},
  Role: { find: (...a: unknown[]) => mockRoleFind(...a) },
  RoleAssignment: {
    find: (...a: unknown[]) => mockRaFind(...a),
    aggregate: (...a: unknown[]) => mockRaAggregate(...a),
  },
  User: {},
  UserOrganization: {},
}));

const { assertActorMayStripMemberRoles } = await import('../src/services/role-crud.js');
const {
  RL_ASSIGN_EXCEEDS_CEILING, RL_LAST_PRIVILEGED_MEMBER, RL_REQUIRES_SUPERADMIN,
} = await import('../src/services/roles-errors.js');

/** A query chain resolving to `rows` whatever order `.select()` / `.session()` / `.lean()` come in. */
const q = (rows: unknown) => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.session = () => chain;
  chain.lean = () => Promise.resolve(rows);
  chain.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, ko);
  return chain;
};

type RoleRow = { _id: string; grantsRole: 'member' | 'admin' | 'superadmin'; permissions: string[] };
const MEMBER: RoleRow = { _id: 'r-member', grantsRole: 'member', permissions: ['pipelines:read'] };
const ADMIN_ROLE: RoleRow = { _id: 'r-admin', grantsRole: 'admin', permissions: ['members:manage', 'roles:manage', 'org_settings:write'] };
const SUPER_ROLE: RoleRow = { _id: 'r-super', grantsRole: 'superadmin', permissions: ['orgs:manage'] };

/** The target holds `held`; each privileged Role has `members` human holders. */
function holds(held: RoleRow[], members = 2) {
  mockRaFind.mockImplementation((filter: { roleId?: unknown }) =>
    q(filter.roleId !== undefined ? [{ roleId: filter.roleId }] : held.map((r) => ({ roleId: r._id }))));
  mockRoleFind.mockImplementation((filter: { grantsRole?: unknown; _id: { $in: string[] } }) => {
    const rows = held.filter((r) => filter._id.$in.includes(r._id));
    return q(filter.grantsRole !== undefined ? rows.filter((r) => r.grantsRole !== 'member').map((r) => ({ _id: r._id })) : rows);
  });
  mockRaAggregate.mockImplementation(() => q(held.filter((r) => r.grantsRole !== 'member').map((r) => ({ _id: r._id, members }))));
}

const session = { id: 'test-session' } as any;
const orgAdmin = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };
const peopleManager = { isSuperAdmin: false, isOrgAdmin: false, permissions: ['members:manage', 'pipelines:read'] };
const superadmin = { isSuperAdmin: true, isOrgAdmin: false, permissions: [] as string[] };

beforeEach(() => { jest.clearAllMocks(); });

describe('assertActorMayStripMemberRoles', () => {
  it('refuses a members:manage-only delegate removing an ADMIN (permission ceiling)', async () => {
    holds([MEMBER, ADMIN_ROLE]);
    await expect(assertActorMayStripMemberRoles('org-1', 'admin-1', peopleManager, session))
      .rejects.toThrow(RL_ASSIGN_EXCEEDS_CEILING);
  });

  it('lets the same delegate remove a plain member (every Role within their ceiling)', async () => {
    holds([MEMBER]);
    await expect(assertActorMayStripMemberRoles('org-1', 'm-1', peopleManager, session))
      .resolves.toEqual({ heldSuperadmin: false });
    // Member-only Roles revoke nothing — no lockout count needed.
    expect(mockRaAggregate).not.toHaveBeenCalled();
  });

  it('lets an org admin remove an admin when another admin remains', async () => {
    holds([MEMBER, ADMIN_ROLE], 2);
    await expect(assertActorMayStripMemberRoles('org-1', 'admin-1', orgAdmin, session)).resolves.toEqual({ heldSuperadmin: false });
  });

  it('refuses to empty the org\'s last admin Role, even for an org admin', async () => {
    holds([MEMBER, ADMIN_ROLE], 1);
    await expect(assertActorMayStripMemberRoles('org-1', 'admin-1', orgAdmin, session))
      .rejects.toThrow(RL_LAST_PRIVILEGED_MEMBER);
  });

  it('a superadmin-granting Role needs a platform superadmin (RL_REQUIRES_SUPERADMIN)', async () => {
    holds([SUPER_ROLE]);
    await expect(assertActorMayStripMemberRoles('system', 'sa-1', orgAdmin, session))
      .rejects.toThrow(RL_REQUIRES_SUPERADMIN);
  });

  it('reports a held superadmin Role so the caller can re-derive User.isSuperAdmin', async () => {
    holds([SUPER_ROLE], 3);
    await expect(assertActorMayStripMemberRoles('system', 'sa-1', superadmin, session))
      .resolves.toEqual({ heldSuperadmin: true });
  });

  it('is a no-op for someone holding no Role in the org', async () => {
    holds([]);
    await expect(assertActorMayStripMemberRoles('org-1', 'u-1', peopleManager, session)).resolves.toEqual({ heldSuperadmin: false });
    expect(mockRoleFind).not.toHaveBeenCalled();
  });
});
