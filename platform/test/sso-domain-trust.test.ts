// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SSO domain trust (helpers/sso-enforcement.ts).
 *
 * An org's own IdP can sign ANY email as verified, so what an org's SSO may do
 * with an address is bounded by the domains it has PROVEN it owns (DNS):
 *   - an SSO identity on an unverified domain never reaches an account,
 *   - a team may use a domain its account root verified,
 *   - Google-issued identities are trusted as-is (Google owns the address),
 *   - listing a domain in `allowedEmailDomains` without verifying it can't
 *     force that domain's users through SSO (no `gmail.com` lockout).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockDomainExists = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockResolveLineage = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindEnabledOrgIdsByDomain = jest.fn<(...a: unknown[]) => Promise<string[]>>();
const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  resolveUserFeatures: () => ['sso'],
  sendError: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  resolveOrgLineage: (...a: unknown[]) => mockResolveLineage(...a),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  OrgDomain: { exists: (...a: unknown[]) => mockDomainExists(...a) },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
}));
jest.unstable_mockModule('../src/services/org-idp-service.js', () => ({
  orgIdpService: {
    findEnabledOrgIdsByDomain: (...a: unknown[]) => mockFindEnabledOrgIdsByDomain(...a),
    findByOrg: async () => ({ provider: 'generic-oidc' }),
  },
}));

const { assertSsoIdentityTrusted, findSsoEnforcementForEmail, GOOGLE_ISSUER } =
  await import('../src/helpers/sso-enforcement.js');

/** OrgDomain.exists honouring the `{ domain, verified, orgId: { $in } }` filter. */
function verifiedDomains(rows: Array<{ orgId: string; domain: string }>) {
  mockDomainExists.mockImplementation(async (filter: any) =>
    rows.some((r) => r.domain === filter.domain && filter.verified === true && filter.orgId.$in.includes(r.orgId))
      ? { _id: 'd' } : null);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveLineage.mockImplementation(async (orgId: unknown) => ({ rootOrgId: orgId }));
  mockOrgFindById.mockReturnValue({ select: () => ({ lean: async () => ({ tier: 'enterprise' }) }) });
  verifiedDomains([]);
});

describe('assertSsoIdentityTrusted', () => {
  it('REFUSES an admin-run IdP vouching for a domain the org has not verified', async () => {
    verifiedDomains([{ orgId: 'victim-org', domain: 'victim.com' }]);
    await expect(assertSsoIdentityTrusted('attacker-org', { issuer: 'https://idp.attacker.test', email: 'ceo@victim.com' }))
      .rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
  });

  it('accepts an identity on a domain the org verified', async () => {
    verifiedDomains([{ orgId: 'org-1', domain: 'acme.com' }]);
    await expect(assertSsoIdentityTrusted('org-1', { issuer: 'https://idp.acme.com', email: 'u@ACME.com' }))
      .resolves.toBeUndefined();
  });

  it("accepts a team's identity on a domain its account root verified", async () => {
    mockResolveLineage.mockResolvedValue({ parentOrgId: 'root', rootOrgId: 'root' });
    verifiedDomains([{ orgId: 'root', domain: 'acme.com' }]);
    await expect(assertSsoIdentityTrusted('team', { issuer: 'https://idp.acme.com', email: 'u@acme.com' }))
      .resolves.toBeUndefined();
  });

  it('fails closed to the org\'s own domains when the lineage cannot be read', async () => {
    mockResolveLineage.mockRejectedValue(new Error('mongo down'));
    verifiedDomains([{ orgId: 'root', domain: 'acme.com' }]);
    await expect(assertSsoIdentityTrusted('team', { issuer: 'https://idp.acme.com', email: 'u@acme.com' }))
      .rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
  });

  it('trusts Google, which owns the addresses it signs', async () => {
    await expect(assertSsoIdentityTrusted('org-1', { issuer: GOOGLE_ISSUER, email: 'someone@gmail.com' }))
      .resolves.toBeUndefined();
    expect(mockDomainExists).not.toHaveBeenCalled();
  });
});

describe('findSsoEnforcementForEmail', () => {
  it('does NOT force SSO for a domain the org only listed, never verified', async () => {
    mockFindEnabledOrgIdsByDomain.mockResolvedValue(['squatter-org']);
    await expect(findSsoEnforcementForEmail('anyone@gmail.com')).resolves.toBeNull();
  });

  it('forces SSO for a domain the org verified', async () => {
    mockFindEnabledOrgIdsByDomain.mockResolvedValue(['squatter-org', 'org-1']);
    verifiedDomains([{ orgId: 'org-1', domain: 'acme.com' }]);
    // `protocol` rides along so a caller knows which sign-in flow to start (#4).
    await expect(findSsoEnforcementForEmail('u@acme.com')).resolves.toEqual({ orgId: 'org-1', protocol: 'oidc', provider: 'generic-oidc' });
  });
});
