// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `partitionAssignableRoles` — the security boundary of the invitation's Role
 * grant.
 *
 * An invitation is a bearer token delivered by email. Letting it name Roles is
 * what gives every Role template an onboarding path (before this, hiring a
 * billing person meant inviting them as ADMIN and demoting, or inviting as
 * member and remembering to assign later). It also makes the invitation a FIFTH
 * grant path for the restricted permission classes, alongside custom-Role
 * authoring, Role assignment, token issue and the route gates — so it has to
 * refuse exactly what those refuse.
 *
 * Four gates, each with a case here: org scope, the Super Admin Role, the
 * system-org carve-out, and the actor's own ceiling.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

let roleFilter: Record<string, unknown> | undefined;
let roleDocs: Array<Record<string, unknown>> = [];
const mockRoleFind = jest.fn((filter: Record<string, unknown>) => {
  roleFilter = filter;
  return { session: () => ({ select: () => ({ lean: async () => roleDocs }) }) };
});

jest.unstable_mockModule('../src/models/index.js', () => ({
  Role: { find: (f: Record<string, unknown>) => mockRoleFind(f), findOne: () => ({ session: () => ({ select: () => ({ lean: async () => null }) }) }) },
  RoleAssignment: { updateOne: async () => ({}), bulkWrite: async () => ({}), find: () => ({ session: () => ({ select: () => ({ lean: async () => [] }) }) }) },
  User: {},
  UserOrganization: {},
}));

const { partitionAssignableRoles } = await import('../src/services/roles-service.js');
const {
  RL_ROLE_NOT_FOUND, RL_SUPERADMIN_ROLE_NOT_INVITABLE,
  RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN, RL_ASSIGN_EXCEEDS_CEILING,
} = await import('../src/services/roles-errors.js');

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const R1 = '111111111111111111111111';
const R2 = '222222222222222222222222';

/** An org admin: holds the whole org-assignable bundle, so no fine ceiling applies. */
const ADMIN = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };
/** A delegate: `roles:manage` and nothing else. */
const DELEGATE = { isSuperAdmin: false, isOrgAdmin: false, permissions: ['roles:manage'] };
const SUPERADMIN = { isSuperAdmin: true, isOrgAdmin: false, permissions: [] as string[] };

beforeEach(() => {
  jest.clearAllMocks();
  roleFilter = undefined;
  roleDocs = [];
});

describe('partitionAssignableRoles', () => {
  it('reads nothing and returns empty for no roleIds', async () => {
    expect(await partitionAssignableRoles(ORG as never, undefined, ADMIN)).toEqual({ eligible: [], rejected: [] });
    expect(await partitionAssignableRoles(ORG as never, [], ADMIN)).toEqual({ eligible: [], rejected: [] });
    expect(mockRoleFind).not.toHaveBeenCalled();
  });

  // GATE 1. A Role id is not a capability: one from another org must not resolve
  // here, which the query's own `organizationId` guarantees.
  it('scopes the lookup to the org, so a foreign Role is simply not found', async () => {
    roleDocs = [];
    const out = await partitionAssignableRoles(ORG as never, [R1], ADMIN);
    expect(roleFilter?.organizationId).toBe(ORG);
    expect(out.eligible).toEqual([]);
    expect(out.rejected).toEqual([{ roleId: R1, reason: RL_ROLE_NOT_FOUND }]);
  });

  it('rejects a malformed id without putting it in the query', async () => {
    const out = await partitionAssignableRoles(ORG as never, ['not-an-objectid'], ADMIN);
    expect(out.rejected).toEqual([{ roleId: 'not-an-objectid', reason: RL_ROLE_NOT_FOUND }]);
    expect(mockRoleFind).not.toHaveBeenCalled();
  });

  // GATE 2. The flag is granted by `POST /admin/users/:id/grants` behind a
  // step-up earned by a second factor. An emailed bearer token must not reach
  // the same grant — and a permission ceiling would not stop it, because what
  // the Super Admin Role confers is `grantsRole`, not a permission list.
  it('refuses the Super Admin Role — even for a superadmin actor', async () => {
    roleDocs = [{ _id: R1, grantsRole: 'superadmin', permissions: [] }];
    for (const actor of [SUPERADMIN, ADMIN]) {
      const out = await partitionAssignableRoles(ORG as never, [R1], actor);
      expect(out.eligible).toEqual([]);
      expect(out.rejected).toEqual([{ roleId: R1, reason: RL_SUPERADMIN_ROLE_NOT_INVITABLE }]);
    }
  });

  // GATE 3a. The system-org carve-out, inherited from `assertActorMayAssignRole`
  // — the same guard the Role-membership API applies, which is the point: an
  // invitation must not grant what an assignment would refuse.
  it('refuses a Role carrying a system-org-only permission unless the actor is a superadmin', async () => {
    roleDocs = [{ _id: R1, grantsRole: 'member', permissions: ['impersonation:open'] }];

    const asAdmin = await partitionAssignableRoles(ORG as never, [R1], ADMIN);
    expect(asAdmin.rejected).toEqual([{ roleId: R1, reason: RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN }]);

    const asSuper = await partitionAssignableRoles(ORG as never, [R1], SUPERADMIN);
    expect(asSuper.rejected).toEqual([]);
    expect(asSuper.eligible).toHaveLength(1);
  });

  // GATE 3b. The delegate ceiling: you cannot invite into a Role granting what
  // you do not hold. Otherwise `invitations:manage` + `roles:manage` would be a
  // self-service promotion.
  it('refuses a Role granting permissions the actor does not hold', async () => {
    roleDocs = [{ _id: R1, grantsRole: 'member', permissions: ['roles:manage', 'org_kms:write'] }];
    const out = await partitionAssignableRoles(ORG as never, [R1], DELEGATE);
    expect(out.rejected).toEqual([{ roleId: R1, reason: RL_ASSIGN_EXCEEDS_CEILING }]);
  });

  it('admits a Role entirely within the delegate ceiling', async () => {
    roleDocs = [{ _id: R1, grantsRole: 'member', permissions: ['roles:manage'] }];
    const out = await partitionAssignableRoles(ORG as never, [R1], DELEGATE);
    expect(out.rejected).toEqual([]);
    expect(out.eligible).toHaveLength(1);
  });

  it('admits any org-assignable Role for an org admin, who holds the whole bundle', async () => {
    roleDocs = [{ _id: R1, grantsRole: 'member', permissions: ['org_kms:write', 'billing:manage'] }];
    const out = await partitionAssignableRoles(ORG as never, [R1], ADMIN);
    expect(out.rejected).toEqual([]);
    expect(out.eligible).toHaveLength(1);
  });

  it('collapses duplicates and partitions a mixed batch', async () => {
    roleDocs = [
      { _id: R1, grantsRole: 'member', permissions: ['roles:manage'] },
      { _id: R2, grantsRole: 'superadmin', permissions: [] },
    ];
    const out = await partitionAssignableRoles(ORG as never, [R1, R1, R2], DELEGATE);
    expect(out.eligible).toHaveLength(1);
    expect(out.rejected).toEqual([{ roleId: R2, reason: RL_SUPERADMIN_ROLE_NOT_INVITABLE }]);
    // One read for the whole batch, deduped before the query.
    expect(mockRoleFind).toHaveBeenCalledTimes(1);
    expect((roleFilter?._id as { $in: unknown[] }).$in).toHaveLength(2);
  });
});
