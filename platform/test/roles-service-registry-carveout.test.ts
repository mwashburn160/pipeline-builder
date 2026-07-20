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

const { createRole, RL_PERMISSION_NOT_ASSIGNABLE, RL_INVALID_PERMISSION } =
  await import('../src/services/roles-service.js');

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
      createRole('org-1', { name: 'Builders', permissions: ['pipelines:write', 'registry:write'] }),
    ).rejects.toThrow(RL_PERMISSION_NOT_ASSIGNABLE);
    // Rejected during validation — never reaches the create.
    expect(mockRoleCreate).not.toHaveBeenCalled();
  });

  it('rejects registry:read too', async () => {
    await expect(
      createRole('org-1', { name: 'Readers', permissions: ['registry:read'] }),
    ).rejects.toThrow(RL_PERMISSION_NOT_ASSIGNABLE);
  });

  it('accepts an org-assignable permission set', async () => {
    const role = await createRole('org-1', { name: 'Builders', permissions: ['pipelines:read', 'pipelines:write'] });
    expect(mockRoleCreate).toHaveBeenCalledTimes(1);
    const created = mockRoleCreate.mock.calls[0][0] as { permissions: string[]; grantsRole: string; system: boolean };
    expect(created.permissions).toEqual(['pipelines:read', 'pipelines:write']);
    expect(created.grantsRole).toBe('member'); // custom Roles never confer a base role
    expect(created.system).toBe(false);
    expect(role.permissions).toEqual(['pipelines:read', 'pipelines:write']);
  });

  it('still rejects an unknown permission with RL_INVALID_PERMISSION', async () => {
    await expect(
      createRole('org-1', { name: 'Bogus', permissions: ['not:a:permission'] }),
    ).rejects.toThrow(RL_INVALID_PERMISSION);
  });
});
