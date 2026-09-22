// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Nobody mints a service-account credential more powerful than themselves
 * (services/service-account-service.ts):
 *   - issuing a KEY for an account, or RE-ENABLING one, hands out the account's
 *     existing Roles — so the actor must pass the assignment ceiling for each;
 *   - a `scim`-scoped key needs org admin (or `members:manage` + `roles:manage`)
 *     on an SSO-entitled org; a `registry:push` key needs `plugins:write`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';
import { apiCoreMock } from './helpers/mock-api-core.js';

const ACCOUNT_ID = new Types.ObjectId().toString();
let accountRoles: Array<{ id: string; name: string; grantsRole: string; permissions: string[] }> = [];
let ssoEntitled = true;
let accountDoc: Record<string, unknown> = {};
const mockCreateForSa = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ key: 'pb_sa_x', view: { id: 'k1' } }));
const mockSaUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { serviceAccounts: {} } }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ isAncestorOrg: async () => false, resolveOrgLineage: async (id: string) => ({ rootOrgId: id }) }));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ isSsoEntitled: async () => ssoEntitled }));
jest.unstable_mockModule('../src/services/api-key-service.js', () => ({
  apiKeyService: {
    countActiveForServiceAccount: async () => 0,
    createForServiceAccount: (...a: unknown[]) => mockCreateForSa(...a),
    listForServiceAccount: async () => [],
  },
}));
jest.unstable_mockModule('../src/services/service-account-roles.js', () => ({
  serviceAccountRoles: async () => accountRoles,
  serviceAccountRolesFor: async () => new Map([[ACCOUNT_ID, accountRoles]]),
  setServiceAccountRoles: async () => undefined,
  clearServiceAccountRoles: async () => undefined,
}));
jest.unstable_mockModule('../src/services/service-account-cascade.js', () => ({
  deleteServiceAccountsForOrg: async () => 0,
  revokeServiceAccountKeysForOrg: async () => 0,
}));
jest.unstable_mockModule('../src/models/organization.js', () => ({ default: { findById: () => ({ select: () => ({ lean: async () => ({}) }) }) } }));
jest.unstable_mockModule('../src/models/service-account.js', () => ({
  default: {
    findOne: () => ({ lean: async () => ({ _id: new Types.ObjectId(ACCOUNT_ID), name: 'deploy', organizationId: 'org-1', createdAt: new Date(0), ...accountDoc }) }),
    updateOne: (...a: unknown[]) => mockSaUpdateOne(...a),
  },
}));

const { createServiceAccountKey, updateServiceAccount } = await import('../src/services/service-account-service.js');

const delegate = (permissions: string[]) => ({ isSuperAdmin: false, isOrgAdmin: false, permissions });
const ADMIN = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] };
const mint = (actor: unknown, scope?: string) =>
  createServiceAccountKey('org-1', ACCOUNT_ID, { name: 'k', expiresInSeconds: 3600, ...(scope ? { scope: scope as never } : {}) }, actor as never);

beforeEach(() => {
  jest.clearAllMocks();
  accountRoles = [];
  ssoEntitled = true;
  accountDoc = {};
});

describe('issuing a key — the account\'s Roles through the assignment ceiling', () => {
  it('REFUSES a delegate who does not hold what the account\'s Roles grant', async () => {
    accountRoles = [{ id: 'r1', name: 'Deployer', grantsRole: 'member', permissions: ['pipelines:write', 'plugins:write'] }];
    await expect(mint(delegate(['service_accounts:manage', 'pipelines:write']))).rejects.toThrow('RL_ASSIGN_EXCEEDS_CEILING');
    expect(mockCreateForSa).not.toHaveBeenCalled();
  });

  it('lets a delegate holding every granted permission, and an org admin, through', async () => {
    accountRoles = [{ id: 'r1', name: 'Deployer', grantsRole: 'member', permissions: ['pipelines:write'] }];
    await expect(mint(delegate(['service_accounts:manage', 'pipelines:write']))).resolves.toBeDefined();
    await expect(mint(ADMIN)).resolves.toBeDefined();
  });

  it('refuses a superadmin-granting Role to anyone but a platform superadmin', async () => {
    accountRoles = [{ id: 'r1', name: 'Super', grantsRole: 'superadmin', permissions: [] }];
    await expect(mint(ADMIN)).rejects.toThrow('RL_REQUIRES_SUPERADMIN');
  });
});

describe('issuing a SCOPED key — the capability\'s own rule', () => {
  it('scim: refuses a delegate without members:manage + roles:manage', async () => {
    await expect(mint(delegate(['service_accounts:manage', 'members:manage']), 'scim')).rejects.toThrow('SA_SCOPE_NOT_PERMITTED');
  });

  it('scim: allows members:manage + roles:manage, or an org admin — only on an SSO-entitled org', async () => {
    await expect(mint(delegate(['service_accounts:manage', 'members:manage', 'roles:manage']), 'scim')).resolves.toBeDefined();
    await expect(mint(ADMIN, 'scim')).resolves.toBeDefined();
    ssoEntitled = false;
    await expect(mint(ADMIN, 'scim')).rejects.toThrow('SA_SCOPE_NOT_PERMITTED');
  });

  it('registry:push: needs plugins:write', async () => {
    await expect(mint(delegate(['service_accounts:manage']), 'registry:push')).rejects.toThrow('SA_SCOPE_NOT_PERMITTED');
    await expect(mint(delegate(['service_accounts:manage', 'plugins:write']), 'registry:push')).resolves.toBeDefined();
  });
});

describe('re-enabling an account — the same ceiling as issuing a key for it', () => {
  it('REFUSES a delegate re-enabling an account whose Roles exceed them, and changes nothing', async () => {
    accountDoc = { disabled: true };
    accountRoles = [{ id: 'r1', name: 'Admin', grantsRole: 'admin', permissions: ['members:manage'] }];
    await expect(updateServiceAccount('org-1', ACCOUNT_ID, { disabled: false }, delegate(['service_accounts:manage'])))
      .rejects.toThrow('RL_ASSIGN_EXCEEDS_CEILING');
    expect(mockSaUpdateOne).not.toHaveBeenCalled();
  });

  it('does not apply the ceiling to DISABLING (containment is always allowed)', async () => {
    accountRoles = [{ id: 'r1', name: 'Admin', grantsRole: 'admin', permissions: ['members:manage'] }];
    await updateServiceAccount('org-1', ACCOUNT_ID, { disabled: true }, delegate(['service_accounts:manage']));
    expect(mockSaUpdateOne).toHaveBeenCalled();
  });
});
