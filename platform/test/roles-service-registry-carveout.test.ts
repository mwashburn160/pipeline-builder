// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry carve-out (Tier 3): a user-authored CUSTOM Role must NOT be able to
 * grant the superadmin-only registry permissions (`registry:read`/`registry:write`).
 * createRole/updateRole validate the requested permission set with
 * `isOrgAssignablePermission` and reject a non-assignable permission with the
 * typed error `RL_PERMISSION_NOT_ASSIGNABLE`; org-assignable permissions are
 * accepted. (Built-in Role seeds are exempt — they never pass through this path.)
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRoleFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockRoleCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishUserRevocation: jest.fn(async () => undefined),
  publishUsersRevocation: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (cb: (s: unknown) => unknown) => cb({ id: 'test-session' }),
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: {
    findOne: (...a: unknown[]) => mockRoleFindOne(...a),
    create: (...a: unknown[]) => mockRoleCreate(...a),
  },
  RoleAssignment: {},
  User: {},
  UserOrganization: {},
}));

const { createRole, RL_PERMISSION_NOT_ASSIGNABLE, RL_INVALID_PERMISSION, RL_PERMISSION_EXCEEDS_CEILING } =
  await import('../src/services/roles-service.js');

// These tests exercise the invalid / not-assignable gates, which fire
// regardless of the actor's ceiling. A superadmin actor bypasses the ceiling so
// only those gates are under test here.
const SUPERADMIN_ACTOR = { permissions: [] as string[], isSuperAdmin: true };

/** Role.findOne(...).select('_id').lean() → doc|null (name-clash check). */
const noNameClash = () => mockRoleFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });

beforeEach(() => {
  jest.clearAllMocks();
  noNameClash();
  mockRoleCreate.mockImplementation(async (doc: any) => ({ _id: 'role-1', ...doc }));
});

describe('createRole registry carve-out', () => {
  it('rejects a superadmin-only permission (registry:write)', async () => {
    await expect(
      createRole('org-1', { name: 'Builders', permissions: ['pipelines:write', 'registry:write'] }, SUPERADMIN_ACTOR),
    ).rejects.toThrow(RL_PERMISSION_NOT_ASSIGNABLE);
    // Rejected during validation — never reaches the create.
    expect(mockRoleCreate).not.toHaveBeenCalled();
  });

  it('rejects registry:read too', async () => {
    await expect(
      createRole('org-1', { name: 'Readers', permissions: ['registry:read'] }, SUPERADMIN_ACTOR),
    ).rejects.toThrow(RL_PERMISSION_NOT_ASSIGNABLE);
  });

  it('accepts an org-assignable permission set', async () => {
    const role = await createRole('org-1', { name: 'Builders', permissions: ['pipelines:read', 'pipelines:write'] }, SUPERADMIN_ACTOR);
    expect(mockRoleCreate).toHaveBeenCalledTimes(1);
    const created = mockRoleCreate.mock.calls[0][0] as { permissions: string[]; grantsRole: string; system: boolean };
    expect(created.permissions).toEqual(['pipelines:read', 'pipelines:write']);
    expect(created.grantsRole).toBe('member'); // custom Roles never confer a base role
    expect(created.system).toBe(false);
    expect(role.permissions).toEqual(['pipelines:read', 'pipelines:write']);
  });

  it('still rejects an unknown permission with RL_INVALID_PERMISSION', async () => {
    await expect(
      createRole('org-1', { name: 'Bogus', permissions: ['not:a:permission'] }, SUPERADMIN_ACTOR),
    ).rejects.toThrow(RL_INVALID_PERMISSION);
  });
});

/**
 * Permission ceiling (self-escalation guard): a non-superadmin actor may only
 * grant permissions they THEMSELVES hold. A delegated `roles:manage` holder must
 * not be able to mint a Role bundling `members:manage`/`org:settings` and
 * self-assign it. Superadmins bypass the ceiling.
 */
describe('createRole permission ceiling', () => {
  // A delegated actor who can manage roles + write pipelines, but is NOT an org
  // admin — they do NOT hold members:manage.
  const DELEGATE_ACTOR = { permissions: ['roles:manage', 'pipelines:write'], isSuperAdmin: false };

  it('rejects granting a permission the actor lacks (members:manage)', async () => {
    await expect(
      createRole('org-1', { name: 'Escalate', permissions: ['members:manage'] }, DELEGATE_ACTOR),
    ).rejects.toThrow(RL_PERMISSION_EXCEEDS_CEILING);
    // Rejected during validation — never reaches the create.
    expect(mockRoleCreate).not.toHaveBeenCalled();
  });

  it('rejects a set that mixes a held and an unheld permission', async () => {
    await expect(
      createRole('org-1', { name: 'Mixed', permissions: ['pipelines:write', 'members:manage'] }, DELEGATE_ACTOR),
    ).rejects.toThrow(RL_PERMISSION_EXCEEDS_CEILING);
    expect(mockRoleCreate).not.toHaveBeenCalled();
  });

  it('allows granting a subset of the actor\'s own permissions', async () => {
    const role = await createRole('org-1', { name: 'Builders', permissions: ['pipelines:write'] }, DELEGATE_ACTOR);
    expect(mockRoleCreate).toHaveBeenCalledTimes(1);
    expect(role.permissions).toEqual(['pipelines:write']);
  });

  it('lets a superadmin grant any org-assignable permission the actor does not "hold"', async () => {
    // Superadmin carries no explicit permissions claim but bypasses the ceiling.
    const role = await createRole('org-1', { name: 'OrgAdmins', permissions: ['members:manage'] }, SUPERADMIN_ACTOR);
    expect(mockRoleCreate).toHaveBeenCalledTimes(1);
    expect(role.permissions).toEqual(['members:manage']);
  });
});
