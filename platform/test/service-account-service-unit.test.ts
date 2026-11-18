// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the service-account lifecycle (services/service-account-service.ts)
 * and its Role assignment surface (services/service-account-roles.ts), with the
 * model layer mocked. The same lifecycle runs against real Mongo in
 * `service-accounts.integration.test.ts`; these suites assert the orchestration
 * without a database:
 *   - create validates name/budget, enforces the per-org cap and name
 *     uniqueness, and rolls the row back when the Role ceiling refuses;
 *   - list/get/delete/revoke shape views and fail with the right codes;
 *   - an exchange fails closed at each step (gone, disabled, IP, org, budget)
 *     and otherwise derives role/permissions/hierarchy from the account's Roles;
 *   - the Role set is replaced through the assignment ceiling, both for what
 *     is added and what is removed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { queryChain } from './helpers/query-chain.js';

type Fn = (...a: unknown[]) => unknown;
type AFn = (...a: unknown[]) => Promise<unknown>;

const ACCOUNT_ID = new Types.ObjectId().toString();
const ORG_ID = 'org-1';

// ServiceAccount model
const mockSaCount = jest.fn<AFn>();
const mockSaExists = jest.fn<AFn>();
const mockSaCreate = jest.fn<AFn>();
const mockSaDeleteOne = jest.fn<AFn>();
const mockSaFind = jest.fn<Fn>();
const mockSaFindOne = jest.fn<Fn>();
const mockSaFindById = jest.fn<Fn>();
const mockSaFindOneAndUpdate = jest.fn<AFn>();
const mockSaUpdateOne = jest.fn<AFn>();
// Organization model
const mockOrgFindById = jest.fn<Fn>();
// Role / RoleAssignment (read by the REAL service-account-roles module)
const mockRoleFind = jest.fn<Fn>();
const mockRaFind = jest.fn<Fn>();
const mockRaDeleteMany = jest.fn<AFn>();
const mockRaInsertMany = jest.fn<AFn>();
// api-key-service
const mockListForSa = jest.fn<AFn>();
const mockListForSas = jest.fn<AFn>();
const mockDeleteForSas = jest.fn<AFn>();
const mockRevokeForSa = jest.fn<AFn>();
// hierarchy
const mockResolveLineage = jest.fn<AFn>();

const mockPublishSaKeys = jest.fn(async (..._a: unknown[]) => 0);
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ serviceAccounts: {} }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: async () => false,
  resolveOrgLineage: (...a: unknown[]) => mockResolveLineage(...a),
}));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ isSsoEntitled: async () => true }));
jest.unstable_mockModule('../src/services/api-key-service.js', () => ({
  apiKeyService: {
    countActiveForServiceAccount: async () => 0,
    createForServiceAccount: async () => ({ key: 'pb_sa_x', view: { id: 'k1' } }),
    listForServiceAccount: (...a: unknown[]) => mockListForSa(...a),
    listForServiceAccounts: (...a: unknown[]) => mockListForSas(...a),
    deleteForServiceAccounts: (...a: unknown[]) => mockDeleteForSas(...a),
    revokeForServiceAccount: (...a: unknown[]) => mockRevokeForSa(...a),
  },
}));
const txSession = { id: 'sa-tx' };
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: async (fn: (s: unknown) => Promise<unknown>) => fn(txSession),
}));
jest.unstable_mockModule('../src/services/service-account-cascade.js', () => ({
  deleteServiceAccountsForOrg: async () => 0,
  revokeServiceAccountKeysForOrg: async () => 0,
  publishServiceAccountKeysRevocation: (...a: unknown[]) => mockPublishSaKeys(...a),
}));
jest.unstable_mockModule('../src/models/organization.js', () => ({
  default: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
}));
jest.unstable_mockModule('../src/models/service-account.js', () => ({
  default: {
    countDocuments: (...a: unknown[]) => mockSaCount(...a),
    exists: (...a: unknown[]) => mockSaExists(...a),
    create: (...a: unknown[]) => mockSaCreate(...a),
    deleteOne: (...a: unknown[]) => mockSaDeleteOne(...a),
    find: (...a: unknown[]) => mockSaFind(...a),
    findOne: (...a: unknown[]) => mockSaFindOne(...a),
    findById: (...a: unknown[]) => mockSaFindById(...a),
    findOneAndUpdate: (...a: unknown[]) => mockSaFindOneAndUpdate(...a),
    updateOne: (...a: unknown[]) => mockSaUpdateOne(...a),
  },
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: { find: (...a: unknown[]) => mockRoleFind(...a) },
  RoleAssignment: {
    find: (...a: unknown[]) => mockRaFind(...a),
    deleteMany: (...a: unknown[]) => mockRaDeleteMany(...a),
    insertMany: (...a: unknown[]) => mockRaInsertMany(...a),
  },
}));

const svc = await import('../src/services/service-account-service.js');
const roles = await import('../src/services/service-account-roles.js');

const ADMIN = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };
const delegate = (permissions: string[]) => ({ isSuperAdmin: false, isOrgAdmin: false, permissions });

const accountDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(ACCOUNT_ID),
  organizationId: ORG_ID,
  name: 'deploy',
  tokenBudget: -1,
  usage: { exchanges: 2, resetAt: new Date(0) },
  disabled: false,
  createdBy: null,
  createdAt: new Date(0),
  ...over,
});

/** Make the account hold these Roles (through the two reads service-account-roles does). */
function holdRoles(list: Array<{ _id: string; name: string; grantsRole: string; permissions: string[] }>, accountId = ACCOUNT_ID) {
  mockRaFind.mockReturnValue(queryChain(list.map((r) => ({ serviceAccountId: accountId, roleId: r._id }))));
  mockRoleFind.mockReturnValue(queryChain(list));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgFindById.mockReturnValue(queryChain({ name: 'Acme', tier: 'pro' }));
  mockSaCount.mockResolvedValue(0);
  mockSaExists.mockResolvedValue(null);
  mockSaCreate.mockImplementation(async (docs: unknown) => (docs as object[]).map((d) => ({ _id: new Types.ObjectId(ACCOUNT_ID), createdAt: new Date(0), ...d })));
  mockSaDeleteOne.mockResolvedValue({});
  mockSaUpdateOne.mockResolvedValue({});
  mockSaFindOne.mockReturnValue(queryChain(accountDoc()));
  mockSaFindById.mockReturnValue(queryChain(accountDoc()));
  mockSaFindOneAndUpdate.mockResolvedValue({ _id: ACCOUNT_ID });
  mockRaFind.mockReturnValue(queryChain([]));
  mockRoleFind.mockReturnValue(queryChain([]));
  mockRaDeleteMany.mockResolvedValue({});
  mockRaInsertMany.mockResolvedValue([]);
  mockListForSa.mockResolvedValue([]);
  mockListForSas.mockResolvedValue(new Map());
  mockDeleteForSas.mockResolvedValue(undefined);
  mockRevokeForSa.mockResolvedValue({ id: 'k1' });
  mockResolveLineage.mockResolvedValue({ rootOrgId: 'root-1', parentOrgId: 'parent-1' });
});

describe('updateServiceAccount — disable', () => {
  it('DISABLING an account publishes a revocation for every live key, so tokens already exchanged stop working on every service', async () => {
    await svc.updateServiceAccount(ORG_ID, ACCOUNT_ID, { disabled: true }, ADMIN);
    expect(mockPublishSaKeys).toHaveBeenCalledTimes(1);
    expect(String(mockPublishSaKeys.mock.calls[0][0])).toBe(ACCOUNT_ID);
  });

  it('publishes nothing for an edit that does not newly disable the account', async () => {
    await svc.updateServiceAccount(ORG_ID, ACCOUNT_ID, { description: 'x' }, ADMIN);
    mockSaFindOne.mockReturnValue(queryChain(accountDoc({ disabled: true })));
    await svc.updateServiceAccount(ORG_ID, ACCOUNT_ID, { disabled: true }, ADMIN);
    expect(mockPublishSaKeys).not.toHaveBeenCalled();
  });
});

describe('createServiceAccount', () => {
  it('creates a normalized account with an unlimited budget by default and no seat', async () => {
    const view = await svc.createServiceAccount(ORG_ID, { name: '  Deploy-Bot ', description: '  ci ' }, { ...ADMIN, userId: new Types.ObjectId().toString(), email: 'a@x.io' });
    expect(view.name).toBe('deploy-bot');
    expect(view.description).toBe('ci');
    expect(view.tokenBudget).toBe(-1);
    expect(view.seatsConsumed).toBe(0);
    expect(view.createdByEmail).toBe('a@x.io');
    const [created] = mockSaCreate.mock.calls[0][0] as Array<{ usage: { resetAt: Date } }>;
    // Created inside the transaction, with its Role set bound to the same session.
    expect(mockSaCreate.mock.calls[0][1]).toEqual({ session: txSession });
    expect(mockRaDeleteMany).toHaveBeenCalledWith(expect.anything(), { session: txSession });
    expect(created.usage.resetAt.getTime()).toBeGreaterThan(Date.now());
    // Empty Role set: the old assignments are cleared and nothing is inserted.
    expect(mockRaDeleteMany).toHaveBeenCalled();
    expect(mockRaInsertMany).not.toHaveBeenCalled();
  });

  it('refuses a missing or soft-deleted org', async () => {
    mockOrgFindById.mockReturnValue(queryChain(null));
    await expect(svc.createServiceAccount(ORG_ID, { name: 'deploy' }, ADMIN)).rejects.toThrow('SA_ORG_NOT_FOUND');
    mockOrgFindById.mockReturnValue(queryChain({ name: 'x', tier: 'pro', deletedAt: new Date() }));
    await expect(svc.createServiceAccount(ORG_ID, { name: 'deploy' }, ADMIN)).rejects.toThrow('SA_ORG_NOT_FOUND');
  });

  it('validates the name and the budget', async () => {
    await expect(svc.createServiceAccount(ORG_ID, { name: 'x' }, ADMIN)).rejects.toThrow('SA_INVALID_NAME');
    await expect(svc.createServiceAccount(ORG_ID, { name: 'deploy', tokenBudget: 0 }, ADMIN)).rejects.toThrow('SA_INVALID_BUDGET');
    await expect(svc.createServiceAccount(ORG_ID, { name: 'deploy', tokenBudget: 1.5 }, ADMIN)).rejects.toThrow('SA_INVALID_BUDGET');
    await expect(svc.createServiceAccount(ORG_ID, { name: 'deploy', tokenBudget: 100 }, ADMIN)).resolves.toMatchObject({ tokenBudget: 100 });
  });

  it('enforces the per-org cap and name uniqueness (including a lost race)', async () => {
    mockSaCount.mockResolvedValue(50);
    await expect(svc.createServiceAccount(ORG_ID, { name: 'deploy' }, ADMIN)).rejects.toThrow('SA_LIMIT');
    mockSaCount.mockResolvedValue(0);
    mockSaExists.mockResolvedValue({ _id: 'x' });
    await expect(svc.createServiceAccount(ORG_ID, { name: 'deploy' }, ADMIN)).rejects.toThrow('SA_NAME_TAKEN');
    mockSaExists.mockResolvedValue(null);
    mockSaCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(svc.createServiceAccount(ORG_ID, { name: 'deploy' }, ADMIN)).rejects.toThrow('SA_NAME_TAKEN');
    mockSaCreate.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.createServiceAccount(ORG_ID, { name: 'deploy' }, ADMIN)).rejects.toThrow('boom');
  });

  it('creates the row and its Roles in ONE transaction, so a ceiling refusal aborts both', async () => {
    // The requested Role doesn't belong to the org: the refusal is thrown INSIDE
    // the transaction (which rolls the row back) — no compensating delete.
    mockRoleFind.mockReturnValue(queryChain([]));
    await expect(svc.createServiceAccount(ORG_ID, { name: 'deploy', roleIds: ['r1'] }, ADMIN)).rejects.toThrow('RL_ROLE_NOT_FOUND');
    expect(mockSaCreate).toHaveBeenCalledWith([expect.objectContaining({ name: 'deploy' })], { session: txSession });
    expect(mockSaDeleteOne).not.toHaveBeenCalled();
  });
});

describe('list / get / delete / revoke', () => {
  it('lists nothing for an empty org without the bulk reads', async () => {
    mockSaFind.mockReturnValue(queryChain([]));
    await expect(svc.listServiceAccounts(ORG_ID)).resolves.toEqual([]);
    expect(mockListForSas).not.toHaveBeenCalled();
  });

  it('lists accounts with their bulk-fetched Roles and keys', async () => {
    const other = new Types.ObjectId().toString();
    mockSaFind.mockReturnValue(queryChain([accountDoc(), accountDoc({ _id: new Types.ObjectId(other), name: 'other', disabled: true, lastUsedAt: new Date(1000) })]));
    holdRoles([{ _id: 'r1', name: 'Deployer', grantsRole: 'member', permissions: ['pipelines:write', 'pipelines:write'] }]);
    mockListForSas.mockResolvedValue(new Map([[ACCOUNT_ID, [{ id: 'k1' }]]]));
    const views = await svc.listServiceAccounts(ORG_ID);
    expect(views).toHaveLength(2);
    expect(views[0].roles.map((r) => r.name)).toEqual(['Deployer']);
    expect(views[0].keys).toEqual([{ id: 'k1' }]);
    expect(views[1].roles).toEqual([]);
    expect(views[1].keys).toEqual([]);
    expect(views[1].disabled).toBe(true);
  });

  it('gets one account, or SA_NOT_FOUND for a bad or missing id', async () => {
    holdRoles([{ _id: 'r1', name: 'Deployer', grantsRole: 'member', permissions: ['pipelines:write'] }]);
    const view = await svc.getServiceAccount(ORG_ID, ACCOUNT_ID);
    expect(view.permissions).toEqual(['pipelines:write']);
    expect(svc.snapshotOf(view)).toEqual({ description: null, roles: ['Deployer'], tokenBudget: -1, disabled: false });
    await expect(svc.getServiceAccount(ORG_ID, 'nope')).rejects.toThrow('SA_NOT_FOUND');
    mockSaFindOne.mockReturnValue(queryChain(null));
    await expect(svc.getServiceAccount(ORG_ID, ACCOUNT_ID)).rejects.toThrow('SA_NOT_FOUND');
  });

  it('deletes the account together with its keys and Role assignments', async () => {
    const view = await svc.deleteServiceAccount(ORG_ID, ACCOUNT_ID);
    expect(view.name).toBe('deploy');
    expect(mockDeleteForSas).toHaveBeenCalled();
    expect(mockRaDeleteMany).toHaveBeenCalledWith({ serviceAccountId: expect.anything() }, { session: undefined });
    expect(mockSaDeleteOne).toHaveBeenCalled();
  });

  it('revokes a key, or SA_KEY_NOT_FOUND', async () => {
    await expect(svc.revokeServiceAccountKey(ORG_ID, ACCOUNT_ID, 'k1')).resolves.toEqual({ id: 'k1' });
    mockRevokeForSa.mockResolvedValue(null);
    await expect(svc.revokeServiceAccountKey(ORG_ID, ACCOUNT_ID, 'k1')).rejects.toThrow('SA_KEY_NOT_FOUND');
  });

  it('reports the billing summary — no seats, its own budget period', async () => {
    mockSaCount.mockResolvedValue(3);
    const summary = await svc.serviceAccountBillingSummary(ORG_ID);
    expect(summary).toMatchObject({ accounts: 3, maxAccounts: 50, seatsConsumed: 0 });
    expect(typeof summary.budgetPeriodDays).toBe('number');
  });
});

describe('createServiceAccountKey — allowlist validation', () => {
  it('accepts bare addresses and in-range CIDRs, and rejects the rest', async () => {
    await expect(svc.createServiceAccountKey(ORG_ID, ACCOUNT_ID, { name: 'k', ipAllowlist: [' 10.0.0.0/8 ', '2001:db8::/32', '203.0.113.7', ''] }, ADMIN)).resolves.toBeDefined();
    for (const bad of ['nope', '10.0.0.0/33', '2001:db8::/129', '10.0.0.0/x']) {
      await expect(svc.createServiceAccountKey(ORG_ID, ACCOUNT_ID, { name: 'k', ipAllowlist: [bad] }, ADMIN)).rejects.toThrow('SA_INVALID_IP_ALLOWLIST');
    }
    const many = Array.from({ length: 33 }, (_, i) => `10.0.0.${i}`);
    await expect(svc.createServiceAccountKey(ORG_ID, ACCOUNT_ID, { name: 'k', ipAllowlist: many }, ADMIN)).rejects.toThrow('SA_INVALID_IP_ALLOWLIST');
  });
});

describe('resolveServiceAccountExchange', () => {
  it('fails closed: bad id, missing account, disabled, IP, org gone, budget', async () => {
    await expect(svc.resolveServiceAccountExchange('nope', undefined, null)).resolves.toEqual({ ok: false, reason: 'account_gone' });
    mockSaFindById.mockReturnValueOnce(queryChain(null));
    await expect(svc.resolveServiceAccountExchange(ACCOUNT_ID, undefined, null)).resolves.toEqual({ ok: false, reason: 'account_gone' });
    mockSaFindById.mockReturnValueOnce(queryChain(accountDoc({ disabled: true })));
    await expect(svc.resolveServiceAccountExchange(ACCOUNT_ID, undefined, null)).resolves.toEqual({ ok: false, reason: 'account_disabled' });
    await expect(svc.resolveServiceAccountExchange(ACCOUNT_ID, '198.51.100.1', ['203.0.113.0/24'])).resolves.toEqual({ ok: false, reason: 'ip_not_allowed' });
    mockOrgFindById.mockReturnValueOnce(queryChain(null));
    await expect(svc.resolveServiceAccountExchange(ACCOUNT_ID, undefined, null)).resolves.toEqual({ ok: false, reason: 'authority_revoked' });
    mockSaFindOneAndUpdate.mockResolvedValueOnce(null);
    await expect(svc.resolveServiceAccountExchange(ACCOUNT_ID, undefined, null)).resolves.toEqual({ ok: false, reason: 'budget_exhausted' });
  });

  it('derives a member context from the account\'s Roles', async () => {
    holdRoles([{ _id: 'r1', name: 'Deployer', grantsRole: 'member', permissions: ['pipelines:write'] }]);
    const result = await svc.resolveServiceAccountExchange(ACCOUNT_ID, '203.0.113.7', ['203.0.113.0/24']);
    expect(result).toMatchObject({
      ok: true,
      context: { id: ACCOUNT_ID, name: 'deploy', organizationId: ORG_ID, organizationName: 'Acme', tier: 'pro', role: 'member', isSuperAdmin: false, rolePermissions: ['pipelines:write'] },
    });
    // The budget consume is the atomic pipeline update.
    expect(mockSaFindOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ disabled: false }), expect.any(Array), expect.objectContaining({ updatePipeline: true }));
  });

  it('maps admin/superadmin Roles and resolves a parented team from its root', async () => {
    holdRoles([{ _id: 'r1', name: 'Root', grantsRole: 'superadmin', permissions: [] }]);
    mockOrgFindById
      .mockReturnValueOnce(queryChain({ tier: 'pro', parentOrgId: 'parent-1', featureEntitlements: ['team'] }))
      .mockReturnValueOnce(queryChain({ featureEntitlements: ['root-feature'] }));
    const result = await svc.resolveServiceAccountExchange(ACCOUNT_ID, undefined, null);
    expect(result).toMatchObject({
      ok: true,
      context: { role: 'admin', isSuperAdmin: true, parentOrganizationId: 'parent-1', rootOrganizationId: 'root-1', featureEntitlements: ['root-feature'] },
    });
    expect((result as unknown as { context: Record<string, unknown> }).context.organizationName).toBeUndefined();
  });

  it('falls back to the team\'s own entitlements when the lineage read fails', async () => {
    holdRoles([{ _id: 'r1', name: 'Admin', grantsRole: 'admin', permissions: [] }]);
    mockOrgFindById.mockReturnValueOnce(queryChain({ name: 'Team', tier: 'pro', parentOrgId: 'parent-1', featureEntitlements: ['team'] }));
    mockResolveLineage.mockRejectedValueOnce(new Error('down'));
    const result = await svc.resolveServiceAccountExchange(ACCOUNT_ID, undefined, null);
    expect(result).toMatchObject({ ok: true, context: { role: 'admin', featureEntitlements: ['team'] } });
  });
});

describe('service-account-roles', () => {
  it('returns no Roles for no accounts or no assignments, and drops a vanished Role', async () => {
    await expect(roles.serviceAccountRolesFor(ORG_ID, [])).resolves.toEqual(new Map());
    expect(mockRaFind).not.toHaveBeenCalled();
    await expect(roles.serviceAccountRoles(ORG_ID, ACCOUNT_ID)).resolves.toEqual([]);
    mockRaFind.mockReturnValue(queryChain([{ serviceAccountId: ACCOUNT_ID, roleId: 'gone' }]));
    mockRoleFind.mockReturnValue(queryChain([]));
    await expect(roles.serviceAccountRoles(ORG_ID, ACCOUNT_ID)).resolves.toEqual([]);
  });

  it('groups Roles by account and keeps only valid permissions', async () => {
    mockRaFind.mockReturnValue(queryChain([
      { serviceAccountId: 'a', roleId: 'r1' },
      { serviceAccountId: 'a', roleId: 'r2' },
      { serviceAccountId: 'b', roleId: 'r1' },
    ]));
    mockRoleFind.mockReturnValue(queryChain([
      { _id: 'r1', name: 'One', grantsRole: 'member', permissions: ['pipelines:write', 'not-a-permission'] },
      { _id: 'r2', name: 'Two', grantsRole: 'member' },
    ]));
    const byAccount = await roles.serviceAccountRolesFor(ORG_ID, ['a', 'b']);
    expect(byAccount.get('a')!.map((r) => r.name)).toEqual(['One', 'Two']);
    expect(byAccount.get('a')![0].permissions).toEqual(['pipelines:write']);
    expect(byAccount.get('a')![1].permissions).toEqual([]);
    expect(byAccount.get('b')!.map((r) => r.id)).toEqual(['r1']);
  });

  it('replaces the Role set, deduplicating the requested ids', async () => {
    mockRoleFind.mockReturnValueOnce(queryChain([{ _id: 'r1', grantsRole: 'member', permissions: ['pipelines:write'] }]));
    await roles.setServiceAccountRoles(ORG_ID, ACCOUNT_ID, ['r1', 'r1'], delegate(['pipelines:write']));
    expect(mockRaDeleteMany).toHaveBeenCalledWith({ serviceAccountId: ACCOUNT_ID, organizationId: ORG_ID }, { session: undefined });
    expect(mockRaInsertMany).toHaveBeenCalledWith([{ serviceAccountId: ACCOUNT_ID, roleId: 'r1', organizationId: ORG_ID }], { session: undefined, ordered: true });
  });

  it('refuses a foreign Role, a superadmin Role for a non-superadmin, and a Role beyond the ceiling', async () => {
    mockRoleFind.mockReturnValueOnce(queryChain([]));
    await expect(roles.setServiceAccountRoles(ORG_ID, ACCOUNT_ID, ['r1'], ADMIN)).rejects.toThrow('RL_ROLE_NOT_FOUND');
    mockRoleFind.mockReturnValueOnce(queryChain([{ _id: 'r1', grantsRole: 'superadmin', permissions: [] }]));
    await expect(roles.setServiceAccountRoles(ORG_ID, ACCOUNT_ID, ['r1'], ADMIN)).rejects.toThrow('RL_REQUIRES_SUPERADMIN');
    mockRoleFind.mockReturnValueOnce(queryChain([{ _id: 'r1', grantsRole: 'member', permissions: ['plugins:write'] }]));
    await expect(roles.setServiceAccountRoles(ORG_ID, ACCOUNT_ID, ['r1'], delegate([]))).rejects.toThrow('RL_ASSIGN_EXCEEDS_CEILING');
    expect(mockRaDeleteMany).not.toHaveBeenCalled();
  });

  it('applies the same ceiling to the Roles being REMOVED', async () => {
    holdRoles([{ _id: 'held', name: 'Super', grantsRole: 'superadmin', permissions: [] }]);
    await expect(roles.setServiceAccountRoles(ORG_ID, ACCOUNT_ID, [], ADMIN)).rejects.toThrow('RL_REQUIRES_SUPERADMIN');
    holdRoles([{ _id: 'held', name: 'Pusher', grantsRole: 'member', permissions: ['plugins:write'] }]);
    await expect(roles.setServiceAccountRoles(ORG_ID, ACCOUNT_ID, [], delegate([]))).rejects.toThrow('RL_ASSIGN_EXCEEDS_CEILING');
    expect(mockRaDeleteMany).not.toHaveBeenCalled();
  });

  it('keeps a held Role that is also requested without re-checking it as a removal', async () => {
    holdRoles([{ _id: 'r1', name: 'Deployer', grantsRole: 'member', permissions: ['pipelines:write'] }]);
    mockRoleFind
      .mockReturnValueOnce(queryChain([{ _id: 'r1', grantsRole: 'member', permissions: ['pipelines:write'] }]))
      .mockReturnValueOnce(queryChain([{ _id: 'r1', name: 'Deployer', grantsRole: 'member', permissions: ['pipelines:write'] }]));
    await roles.setServiceAccountRoles(ORG_ID, ACCOUNT_ID, ['r1'], delegate(['pipelines:write']));
    expect(mockRaInsertMany).toHaveBeenCalled();
  });

  it('clears one account or many', async () => {
    await roles.clearServiceAccountRoles('a');
    expect(mockRaDeleteMany).toHaveBeenLastCalledWith({ serviceAccountId: 'a' }, { session: undefined });
    await roles.clearServiceAccountRoles(['a', 'b']);
    expect(mockRaDeleteMany).toHaveBeenLastCalledWith({ serviceAccountId: { $in: ['a', 'b'] } }, { session: undefined });
  });
});
