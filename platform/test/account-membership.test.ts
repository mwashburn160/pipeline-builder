// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `helpers/account-membership.ts` — where a person stands relative to an
 * ACCOUNT (root + subtree), and the consent rule for a DIRECT member add.
 *
 * The bug this pins: an org admin could add ANY platform user by id/email as an
 * immediately-active member, with nothing for them to accept (SCIM refuses
 * exactly this), and then remove them — which, before the org-scoped
 * revocation fix, signed them out everywhere. A direct add is now allowed only
 * for someone already in the account or at a domain the account has verified;
 * anyone else needs an invitation.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockResolveLineage = jest.fn<AnyFn>();
const mockExpandScope = jest.fn<AnyFn>();
const mockUoExists = jest.fn<AnyFn>();
const mockOwnsVerifiedDomain = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  resolveOrgLineage: (...a: unknown[]) => mockResolveLineage(...a),
  expandOrgScope: (...a: unknown[]) => mockExpandScope(...a),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: string) => v }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  UserOrganization: { exists: (...a: unknown[]) => mockUoExists(...a) },
}));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  emailDomain: (email: string) => email.split('@')[1]?.toLowerCase() ?? null,
  ownsVerifiedDomain: (...a: unknown[]) => mockOwnsVerifiedDomain(...a),
}));

const { assertDirectAddConsented, hasMembershipInAccount, hasMembershipOutsideAccount } =
  await import('../src/helpers/account-membership.js');
const { OM_CONSENT_REQUIRED } = await import('../src/services/org-members-errors.js');

/** `UserOrganization.exists(...)` — awaitable directly AND via `.session()`. */
const existsResolving = (hit: unknown) => {
  const p = Promise.resolve(hit);
  return Object.assign(p, { session: () => p });
};

const ADMIN = { isSuperAdmin: false, isOrgAdmin: true, permissions: [] as string[] };
const SUPERADMIN = { isSuperAdmin: true, isOrgAdmin: false, permissions: [] as string[] };

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveLineage.mockResolvedValue({ rootOrgId: 'root' });
  mockExpandScope.mockResolvedValue(['root', 'team-a', 'team-b']);
  mockUoExists.mockReturnValue(existsResolving(null));
  mockOwnsVerifiedDomain.mockResolvedValue(false);
});

describe('hasMembershipInAccount', () => {
  it('looks across the ROOT\'s whole subtree, not just the target team', async () => {
    mockUoExists.mockReturnValue(existsResolving({ _id: 'm' }));
    await expect(hasMembershipInAccount('u1', 'team-a')).resolves.toBe(true);
    expect(mockResolveLineage).toHaveBeenCalledWith('team-a');
    expect(mockExpandScope).toHaveBeenCalledWith('root');
    expect(mockUoExists).toHaveBeenCalledWith({ userId: 'u1', organizationId: { $in: ['root', 'team-a', 'team-b'] } });
  });
});

describe('hasMembershipOutsideAccount', () => {
  it('is true when the person belongs to an org outside the account', async () => {
    mockUoExists.mockReturnValue(existsResolving({ _id: 'elsewhere' }));
    await expect(hasMembershipOutsideAccount('u1', 'team-a')).resolves.toBe(true);
    expect(mockUoExists).toHaveBeenCalledWith({ userId: 'u1', organizationId: { $nin: ['root', 'team-a', 'team-b'] } });
  });

  it('is false when every membership is inside the account', async () => {
    await expect(hasMembershipOutsideAccount('u1', 'team-a')).resolves.toBe(false);
  });

  it('FAILS CLOSED (true → ask for consent) when the account cannot be resolved', async () => {
    mockResolveLineage.mockRejectedValue(new Error('db down'));
    await expect(hasMembershipOutsideAccount('u1', 'team-a')).resolves.toBe(true);
    expect(mockUoExists).not.toHaveBeenCalled();
  });
});

describe('assertDirectAddConsented', () => {
  const victim = { _id: 'u1', email: 'victim@other-tenant.example', isEmailVerified: true };

  it('refuses a platform user who is not in the account, at an unverified domain', async () => {
    await expect(assertDirectAddConsented({ user: victim, orgId: 'team-a', actor: ADMIN }))
      .rejects.toThrow(OM_CONSENT_REQUIRED);
    expect(mockOwnsVerifiedDomain).toHaveBeenCalledWith('team-a', 'other-tenant.example');
  });

  it('allows someone already in the account (they accepted entry once)', async () => {
    mockUoExists.mockReturnValue(existsResolving({ _id: 'm' }));
    await expect(assertDirectAddConsented({ user: victim, orgId: 'team-a', actor: ADMIN })).resolves.toBeUndefined();
    // No need to consult domains at all.
    expect(mockOwnsVerifiedDomain).not.toHaveBeenCalled();
  });

  it('allows an address at a domain the account has VERIFIED (the SCIM authority rule)', async () => {
    mockOwnsVerifiedDomain.mockResolvedValue(true);
    await expect(assertDirectAddConsented({ user: { _id: 'u2', email: 'new@acme.example', isEmailVerified: true }, orgId: 'team-a', actor: ADMIN }))
      .resolves.toBeUndefined();
  });

  it('refuses an UNVERIFIED account even at a verified domain (pre-hijack: invite instead)', async () => {
    // An unverified account is an unproven claim on the address — anyone can
    // register one on a victim's email. SSO linking refuses it; so does this.
    mockOwnsVerifiedDomain.mockResolvedValue(true);
    await expect(assertDirectAddConsented({ user: { _id: 'u2', email: 'new@acme.example', isEmailVerified: false }, orgId: 'team-a', actor: ADMIN }))
      .rejects.toThrow(OM_CONSENT_REQUIRED);
    await expect(assertDirectAddConsented({ user: { _id: 'u2', email: 'new@acme.example' }, orgId: 'team-a', actor: ADMIN }))
      .rejects.toThrow(OM_CONSENT_REQUIRED);
  });

  it('refuses when the user has no email to judge a domain by', async () => {
    await expect(assertDirectAddConsented({ user: { _id: 'u3' }, orgId: 'team-a', actor: ADMIN }))
      .rejects.toThrow(OM_CONSENT_REQUIRED);
  });

  it('lets a platform superadmin through (the operator)', async () => {
    await expect(assertDirectAddConsented({ user: victim, orgId: 'team-a', actor: SUPERADMIN })).resolves.toBeUndefined();
    expect(mockUoExists).not.toHaveBeenCalled();
  });
});
