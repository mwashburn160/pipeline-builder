// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * IdP group → Role mapping (3a): RESOLUTION and the authoring GUARDRAILS.
 *
 * Models are mocked, so what is under test is the policy, not Mongo:
 *   - resolution is case-insensitive, unions the matched rules, and drops Roles
 *     that no longer exist or confer platform-admin;
 *   - a mapping can never grant owner / platform-admin authority;
 *   - a delegate can only map Roles within their own permission ceiling;
 *   - Google is refused with its own code (no group claims exist there);
 *   - editing and deleting apply the ceiling to what the rule ALREADY grants.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

/** Chainable Mongoose query stub: `.session().select().sort().lean()` and await. */
function query(result: unknown) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.session = self; q.select = self; q.sort = self;
  q.lean = async () => result;
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return q;
}

const mappingFind = jest.fn<(...a: unknown[]) => unknown>();
const mappingFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mappingExists = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mappingCount = jest.fn<(...a: unknown[]) => Promise<number>>();
const mappingCreate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mappingDeleteOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const roleFind = jest.fn<(...a: unknown[]) => unknown>();
const idpConfigFindOne = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

jest.unstable_mockModule('../src/models/idp-group-mapping.js', () => ({
  default: {
    find: (...a: unknown[]) => mappingFind(...a),
    findOne: (...a: unknown[]) => mappingFindOne(...a),
    exists: (...a: unknown[]) => mappingExists(...a),
    countDocuments: (...a: unknown[]) => mappingCount(...a),
    create: (...a: unknown[]) => mappingCreate(...a),
    deleteOne: (...a: unknown[]) => mappingDeleteOne(...a),
  },
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: { find: (...a: unknown[]) => roleFind(...a) },
  OrgIdpConfig: { findOne: (...a: unknown[]) => idpConfigFindOne(...a) },
  RoleAssignment: {},
  User: {},
  UserOrganization: {},
}));

jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishSessionSlotRevocation: async () => true,
  publishAccessKeyRevocation: async () => true,
  publishUserRevocation: jest.fn(async () => undefined),
  publishUsersRevocation: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: async (fn: (s: unknown) => Promise<unknown>) => fn({}),
}));

const { idpGroupMappingService } = await import('../src/services/idp-group-mapping-service.js');
const {
  IGM_FORBIDDEN_GRANT, IGM_GROUP_TAKEN, IGM_NOT_CONFIGURED, IGM_NOT_FOUND, IGM_PROVIDER_UNSUPPORTED,
} = await import('../src/services/idp-mapping-errors.js');
const { RL_ASSIGN_EXCEEDS_CEILING, RL_ROLE_NOT_FOUND } = await import('../src/services/roles-errors.js');

const ORG = 'org-1';
const ADMIN = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };
/** A delegate holding only `roles:manage` — the ceiling case. */
const DELEGATE = { isSuperAdmin: false, isOrgAdmin: false, permissions: ['roles:manage'] };

const role = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id, name: id, grantsRole: 'member', permissions: [], ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  idpConfigFindOne.mockReturnValue(query({ provider: 'generic-oidc' }));
  mappingExists.mockResolvedValue(null);
  mappingCount.mockResolvedValue(0);
});

describe('resolveMappedRoles', () => {
  it('matches groups case-insensitively and unions the matched rules', async () => {
    mappingFind.mockReturnValue(query([
      { group: 'Eng', groupKey: 'eng', roleIds: ['r1', 'r2'] },
      { group: 'SRE', groupKey: 'sre', roleIds: ['r2', 'r3'] },
    ]));
    roleFind.mockReturnValue(query([role('r1'), role('r2'), role('r3')]));

    const out = await idpGroupMappingService.resolveMappedRoles(ORG, ['ENG', '  sre ']);
    expect(out.roleIds.sort()).toEqual(['r1', 'r2', 'r3']);
    expect(out.matchedGroups).toEqual(['Eng', 'SRE']);
  });

  it('drops a mapped Role that no longer exists in the org', async () => {
    mappingFind.mockReturnValue(query([{ group: 'eng', groupKey: 'eng', roleIds: ['r1', 'deleted'] }]));
    roleFind.mockReturnValue(query([role('r1')]));
    expect((await idpGroupMappingService.resolveMappedRoles(ORG, ['eng'])).roleIds).toEqual(['r1']);
  });

  it('never resolves a platform-admin Role, even if one is somehow mapped', async () => {
    mappingFind.mockReturnValue(query([{ group: 'eng', groupKey: 'eng', roleIds: ['r1', 'su'] }]));
    roleFind.mockReturnValue(query([role('r1'), role('su', { grantsRole: 'superadmin' })]));
    expect((await idpGroupMappingService.resolveMappedRoles(ORG, ['eng'])).roleIds).toEqual(['r1']);
  });

  it('returns nothing (never a default Role) when the token carries no groups', async () => {
    expect(await idpGroupMappingService.resolveMappedRoles(ORG, [])).toEqual({ roleIds: [], matchedGroups: [] });
    expect(mappingFind).not.toHaveBeenCalled();
  });

  it('returns nothing when no rule matches the groups', async () => {
    mappingFind.mockReturnValue(query([]));
    expect(await idpGroupMappingService.resolveMappedRoles(ORG, ['unmapped'])).toEqual({ roleIds: [], matchedGroups: [] });
  });
});

describe('create (guardrails)', () => {
  it('refuses a Google config with the provider-specific code', async () => {
    idpConfigFindOne.mockReturnValue(query({ provider: 'google' }));
    await expect(idpGroupMappingService.create(ORG, 'u1', { group: 'eng', roleIds: ['r1'] }, ADMIN))
      .rejects.toThrow(IGM_PROVIDER_UNSUPPORTED);
    expect(mappingCreate).not.toHaveBeenCalled();
  });

  it('refuses when the org has no IdP configured at all', async () => {
    idpConfigFindOne.mockReturnValue(query(null));
    await expect(idpGroupMappingService.create(ORG, 'u1', { group: 'eng', roleIds: ['r1'] }, ADMIN))
      .rejects.toThrow(IGM_NOT_CONFIGURED);
  });

  it('refuses a Role that confers owner/platform-admin authority — for an ORG ADMIN too', async () => {
    roleFind.mockReturnValue(query([role('su', { grantsRole: 'superadmin' })]));
    await expect(idpGroupMappingService.create(ORG, 'u1', { group: 'eng', roleIds: ['su'] }, ADMIN))
      .rejects.toThrow(IGM_FORBIDDEN_GRANT);
  });

  it('refuses a Role outside a delegate\'s own permission ceiling', async () => {
    roleFind.mockReturnValue(query([role('r1', { permissions: ['members:manage'] })]));
    await expect(idpGroupMappingService.create(ORG, 'u1', { group: 'eng', roleIds: ['r1'] }, DELEGATE))
      .rejects.toThrow(RL_ASSIGN_EXCEEDS_CEILING);
  });

  it('allows a delegate to map a Role they DO hold every permission of', async () => {
    roleFind.mockReturnValue(query([role('r1', { permissions: ['roles:manage'] })]));
    mappingCreate.mockResolvedValue({ _id: 'm1', group: 'eng', roleIds: ['r1'], updatedAt: new Date(0) });
    const out = await idpGroupMappingService.create(ORG, 'u1', { group: 'eng', roleIds: ['r1'] }, DELEGATE);
    expect(out.group).toBe('eng');
    expect(out.roleIds).toEqual(['r1']);
  });

  it('refuses a Role id that belongs to another org', async () => {
    roleFind.mockReturnValue(query([])); // scoped query returns nothing
    await expect(idpGroupMappingService.create(ORG, 'u1', { group: 'eng', roleIds: ['other-org-role'] }, ADMIN))
      .rejects.toThrow(RL_ROLE_NOT_FOUND);
  });

  it('refuses a duplicate group (case-insensitively, via the stored key)', async () => {
    roleFind.mockReturnValue(query([role('r1')]));
    mappingExists.mockResolvedValue({ _id: 'm1' });
    await expect(idpGroupMappingService.create(ORG, 'u1', { group: 'ENG', roleIds: ['r1'] }, ADMIN))
      .rejects.toThrow(IGM_GROUP_TAKEN);
    expect(mappingExists).toHaveBeenCalledWith({ orgId: ORG, groupKey: 'eng' });
  });

  it('normalizes the group into a lowercase match key', async () => {
    roleFind.mockReturnValue(query([role('r1')]));
    mappingCreate.mockResolvedValue({ _id: 'm1', group: 'Platform Engineers', roleIds: ['r1'], updatedAt: new Date(0) });
    await idpGroupMappingService.create(ORG, 'u1', { group: '  Platform Engineers ', roleIds: ['r1'] }, ADMIN);
    expect(mappingCreate).toHaveBeenCalledWith(expect.objectContaining({
      group: 'Platform Engineers', groupKey: 'platform engineers',
    }));
  });
});

describe('update / delete (guardrails)', () => {
  const stored = (roleIds: string[]) => ({
    _id: 'm1',
    orgId: ORG,
    group: 'eng',
    groupKey: 'eng',
    roleIds,
    updatedAt: new Date(0),
    save: jest.fn(async () => undefined),
  });

  it('applies the ceiling to what the rule ALREADY grants, before mutating it', async () => {
    const doc = stored(['privileged']);
    mappingFindOne.mockReturnValue(query(doc));
    roleFind.mockReturnValue(query([role('privileged', { permissions: ['billing:manage'] })]));

    await expect(idpGroupMappingService.update(ORG, 'm1', 'u1', { roleIds: ['privileged'] }, DELEGATE))
      .rejects.toThrow(RL_ASSIGN_EXCEEDS_CEILING);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('refuses to delete a rule granting more than the delegate holds', async () => {
    mappingFindOne.mockReturnValue(query(stored(['privileged'])));
    roleFind.mockReturnValue(query([role('privileged', { permissions: ['billing:manage'] })]));
    await expect(idpGroupMappingService.delete(ORG, 'm1', DELEGATE)).rejects.toThrow(RL_ASSIGN_EXCEEDS_CEILING);
    expect(mappingDeleteOne).not.toHaveBeenCalled();
  });

  it('404s on a mapping id from another org (the query is org-scoped)', async () => {
    mappingFindOne.mockReturnValue(query(null));
    await expect(idpGroupMappingService.delete(ORG, 'foreign', ADMIN)).rejects.toThrow(IGM_NOT_FOUND);
  });

  it('deletes a rule an admin is allowed to grant', async () => {
    mappingFindOne.mockReturnValue(query(stored(['r1'])));
    roleFind.mockReturnValue(query([role('r1')]));
    await idpGroupMappingService.delete(ORG, 'm1', ADMIN);
    expect(mappingDeleteOne).toHaveBeenCalledWith({ _id: 'm1' });
  });
});
