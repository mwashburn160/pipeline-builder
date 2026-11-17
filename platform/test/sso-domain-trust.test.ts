// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SSO domain trust (helpers/sso-enforcement.ts).
 *
 * An org's own IdP can sign ANY email as verified, so what an org's SSO may do
 * with an address is bounded by the domains it has PROVEN it owns (DNS):
 *   - an SSO identity on an unverified domain never reaches an account,
 *   - a team may use a domain its account root verified ONLY when the root
 *     shared it with teams (`sharedWithTeams`) — never by default,
 *   - Google-issued identities are trusted as-is (Google owns the address),
 *   - listing a domain in `allowedEmailDomains` without verifying it can't
 *     force that domain's users through SSO (no `gmail.com` lockout);
 *   - an enabled IdP only OFFERS SSO; the org's "SSO required" policy is what
 *     refuses every other sign-in, and org OWNERS are exempt (break-glass).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockDomainExists = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockResolveLineage = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindCandidates = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();
const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockDomainOwner = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockUserFindOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockOwnerExists = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  resolveUserFeatures: () => ['sso'],
  sendError: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  isAncestorOrg: async () => false,
  resolveOrgLineage: (...a: unknown[]) => mockResolveLineage(...a),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  OrgDomain: {
    exists: (...a: unknown[]) => mockDomainExists(...a),
    findOne: (...a: unknown[]) => ({ select: () => ({ lean: () => mockDomainOwner(...a) }) }),
  },
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  User: { findOne: (...a: unknown[]) => ({ select: () => ({ lean: () => mockUserFindOne(...a) }) }) },
  UserOrganization: { exists: (...a: unknown[]) => mockOwnerExists(...a) },
}));
jest.unstable_mockModule('../src/services/org-idp-service.js', () => ({
  orgIdpService: {
    findEnabledCandidatesForDomain: (...a: unknown[]) => mockFindCandidates(...a),
  },
}));

const {
  assertSsoIdentityTrusted,
  hasVerifiedDomain,
  mayAutoProvisionMembership,
  ownsVerifiedDomain,
  findSsoCoverageForEmail,
  findSsoEnforcementForEmail,
  unverifiedDomains,
  GOOGLE_ISSUER,
} = await import('../src/helpers/sso-enforcement.js');

const OIDC = { protocol: 'oidc', provider: 'generic-oidc' } as const;

/** One enabled IdP candidate, as the service returns it. */
function candidate(orgId: string, over: Record<string, unknown> = {}) {
  return { orgId, protocol: 'oidc', provider: 'generic-oidc', ssoRequired: true, allowedEmailDomains: [], ...over };
}

/** OrgDomain.exists honouring the trust filter: `{ domain?, verified, organizationId }`
 *  or `{ domain?, verified, $or: [{ organizationId }, { organizationId, sharedWithTeams: true }] }`. */
type DomainRow = { organizationId: string; domain: string; sharedWithTeams?: boolean };
function verifiedDomains(rows: DomainRow[]) {
  const matchesScope = (r: DomainRow, scope: any) =>
    r.organizationId === scope.organizationId && (scope.sharedWithTeams !== true || r.sharedWithTeams === true);
  mockDomainExists.mockImplementation(async (filter: any) =>
    rows.some((r) => (filter.domain === undefined || r.domain === filter.domain)
      && filter.verified === true
      && (filter.$or ? filter.$or.some((scope: any) => matchesScope(r, scope)) : matchesScope(r, filter)))
      ? { _id: 'd' } : null);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveLineage.mockImplementation(async (orgId: unknown) => ({ rootOrgId: orgId }));
  mockOrgFindById.mockReturnValue({ select: () => ({ lean: async () => ({ tier: 'enterprise' }) }) });
  verifiedDomains([]);
  mockDomainOwner.mockResolvedValue(null);
  mockUserFindOne.mockResolvedValue(null);
  mockOwnerExists.mockResolvedValue(null);
  mockFindCandidates.mockResolvedValue([]);
});

describe('assertSsoIdentityTrusted', () => {
  it('REFUSES an admin-run IdP vouching for a domain the org has not verified', async () => {
    verifiedDomains([{ organizationId: 'victim-org', domain: 'victim.com' }]);
    await expect(assertSsoIdentityTrusted('attacker-org', { issuer: 'https://idp.attacker.test', email: 'ceo@victim.com' }, OIDC))
      .rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
  });

  it('accepts an identity on a domain the org verified', async () => {
    verifiedDomains([{ organizationId: 'org-1', domain: 'acme.com' }]);
    await expect(assertSsoIdentityTrusted('org-1', { issuer: 'https://idp.acme.com', email: 'u@ACME.com' }, OIDC))
      .resolves.toBeUndefined();
  });

  it('REFUSES a team IdP asserting a ROOT-domain email by default (no root-account takeover)', async () => {
    mockResolveLineage.mockResolvedValue({ parentOrgId: 'root', rootOrgId: 'root' });
    verifiedDomains([{ organizationId: 'root', domain: 'rootcorp.com' }]);
    await expect(assertSsoIdentityTrusted('team', { issuer: 'https://idp.team.test', email: 'owner@rootcorp.com' }, OIDC))
      .rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
    await expect(assertSsoIdentityTrusted('team', { issuer: 'https://idp.team.test', email: 'owner@rootcorp.com' }, { protocol: 'saml' }))
      .rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
  });

  it("accepts a team's identity on a root domain once the root SHARED it with teams", async () => {
    mockResolveLineage.mockResolvedValue({ parentOrgId: 'root', rootOrgId: 'root' });
    verifiedDomains([{ organizationId: 'root', domain: 'acme.com', sharedWithTeams: true }]);
    await expect(assertSsoIdentityTrusted('team', { issuer: 'https://idp.acme.com', email: 'u@acme.com' }, OIDC))
      .resolves.toBeUndefined();
  });

  it("accepts a team's identity on a domain the TEAM itself verified", async () => {
    mockResolveLineage.mockResolvedValue({ parentOrgId: 'root', rootOrgId: 'root' });
    verifiedDomains([{ organizationId: 'team', domain: 'team.acme.io' }]);
    await expect(assertSsoIdentityTrusted('team', { issuer: 'https://idp.acme.com', email: 'u@team.acme.io' }, OIDC))
      .resolves.toBeUndefined();
  });

  it('a root\'s sharing flag never matters for the root itself', async () => {
    verifiedDomains([{ organizationId: 'root', domain: 'acme.com' }]);
    await expect(ownsVerifiedDomain('root', 'acme.com')).resolves.toBe(true);
  });

  it('fails closed to the org\'s own domains when the lineage cannot be read', async () => {
    mockResolveLineage.mockRejectedValue(new Error('mongo down'));
    verifiedDomains([{ organizationId: 'root', domain: 'acme.com', sharedWithTeams: true }]);
    await expect(assertSsoIdentityTrusted('team', { issuer: 'https://idp.acme.com', email: 'u@acme.com' }, OIDC))
      .rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
  });

  it('trusts Google, which owns the addresses it signs — via the google provider only', async () => {
    await expect(assertSsoIdentityTrusted('org-1', { issuer: GOOGLE_ISSUER, email: 'someone@gmail.com' }, { protocol: 'oidc', provider: 'google' }))
      .resolves.toBeUndefined();
    expect(mockDomainExists).not.toHaveBeenCalled();
  });

  it('REFUSES a SAML IdP whose entityId is Google\'s issuer asserting a foreign-domain email', async () => {
    verifiedDomains([{ organizationId: 'victim-org', domain: 'victim.com' }]);
    await expect(assertSsoIdentityTrusted('attacker-org', { issuer: 'https://accounts.google.com', email: 'ceo@victim.com' }, { protocol: 'saml' }))
      .rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
  });

  it('REFUSES a generic OIDC IdP whose discovery document claims Google\'s issuer', async () => {
    await expect(assertSsoIdentityTrusted('attacker-org', { issuer: GOOGLE_ISSUER, email: 'ceo@victim.com' }, OIDC))
      .rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
  });

  it('REFUSES the google provider when the issuer is not Google\'s', async () => {
    await expect(assertSsoIdentityTrusted('attacker-org', { issuer: 'https://idp.attacker.test', email: 'ceo@victim.com' }, { protocol: 'oidc', provider: 'google' }))
      .rejects.toThrow('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
  });
});

describe('findSsoEnforcementForEmail — the "SSO required" policy', () => {
  it('does NOT force SSO for a domain the org only listed, never verified', async () => {
    mockFindCandidates.mockResolvedValue([candidate('squatter-org', { allowedEmailDomains: ['gmail.com'] })]);
    await expect(findSsoEnforcementForEmail('anyone@gmail.com')).resolves.toBeNull();
  });

  it('forces SSO for a verified domain when the org REQUIRES it', async () => {
    mockDomainOwner.mockResolvedValue({ organizationId: 'org-1' });
    mockFindCandidates.mockResolvedValue([candidate('squatter-org'), candidate('org-1')]);
    verifiedDomains([{ organizationId: 'org-1', domain: 'acme.com' }]);
    // `protocol` rides along so a caller knows which sign-in flow to start.
    await expect(findSsoEnforcementForEmail('u@acme.com')).resolves.toEqual({ orgId: 'org-1', protocol: 'oidc', provider: 'generic-oidc' });
    // The verified-domain owner is what the candidate lookup is keyed on.
    expect(mockFindCandidates).toHaveBeenCalledWith('acme.com', ['org-1']);
  });

  it('only OFFERS SSO (no enforcement) when the policy is off', async () => {
    mockDomainOwner.mockResolvedValue({ organizationId: 'org-1' });
    mockFindCandidates.mockResolvedValue([candidate('org-1', { ssoRequired: false })]);
    verifiedDomains([{ organizationId: 'org-1', domain: 'acme.com' }]);
    await expect(findSsoEnforcementForEmail('u@acme.com')).resolves.toBeNull();
    await expect(findSsoCoverageForEmail('u@acme.com')).resolves.toMatchObject({ orgId: 'org-1', required: false });
  });

  it('exempts the org OWNER (break-glass) — but not other members', async () => {
    mockDomainOwner.mockResolvedValue({ organizationId: 'org-1' });
    mockFindCandidates.mockResolvedValue([candidate('org-1')]);
    verifiedDomains([{ organizationId: 'org-1', domain: 'acme.com' }]);
    mockUserFindOne.mockResolvedValue({ _id: 'u-owner' });
    mockOwnerExists.mockImplementation(async (filter: any) =>
      (filter.userId === 'u-owner' && filter.role === 'owner' && filter.organizationId.$in.includes('org-1') ? { _id: 'm' } : null));
    await expect(findSsoEnforcementForEmail('owner@acme.com')).resolves.toBeNull();

    mockUserFindOne.mockResolvedValue({ _id: 'u-member' });
    await expect(findSsoEnforcementForEmail('member@acme.com')).resolves.toMatchObject({ orgId: 'org-1' });
  });

  it('exempts an owner of the account ROOT of a team whose IdP requires SSO', async () => {
    mockResolveLineage.mockImplementation(async (orgId: unknown) => (orgId === 'team' ? { parentOrgId: 'root', rootOrgId: 'root' } : { rootOrgId: orgId }));
    mockDomainOwner.mockResolvedValue({ organizationId: 'root' });
    mockFindCandidates.mockResolvedValue([candidate('team', { allowedEmailDomains: ['acme.com'] })]);
    verifiedDomains([{ organizationId: 'root', domain: 'acme.com', sharedWithTeams: true }]);
    mockUserFindOne.mockResolvedValue({ _id: 'u-root-owner' });
    mockOwnerExists.mockImplementation(async (filter: any) => (filter.organizationId.$in.includes('root') ? { _id: 'm' } : null));
    await expect(findSsoEnforcementForEmail('boss@acme.com')).resolves.toBeNull();
  });

  it('skips a candidate whose pinned allowed-domain list excludes the domain', async () => {
    mockDomainOwner.mockResolvedValue({ organizationId: 'org-1' });
    mockFindCandidates.mockResolvedValue([candidate('org-1', { allowedEmailDomains: ['other.com'] })]);
    verifiedDomains([{ organizationId: 'org-1', domain: 'acme.com' }]);
    await expect(findSsoCoverageForEmail('u@acme.com')).resolves.toBeNull();
  });

  it('prefers a config that REQUIRES SSO over one that merely offers it', async () => {
    mockDomainOwner.mockResolvedValue({ organizationId: 'root' });
    mockResolveLineage.mockImplementation(async (orgId: unknown) => (orgId === 'root' ? { rootOrgId: 'root' } : { parentOrgId: 'root', rootOrgId: 'root' }));
    mockFindCandidates.mockResolvedValue([candidate('root', { ssoRequired: false }), candidate('team', { allowedEmailDomains: ['acme.com'] })]);
    verifiedDomains([{ organizationId: 'root', domain: 'acme.com', sharedWithTeams: true }]);
    await expect(findSsoCoverageForEmail('u@acme.com')).resolves.toMatchObject({ orgId: 'team', required: true });
  });

  it('a team IdP does NOT cover (or lock out) an UNSHARED root domain — the root\'s own IdP does', async () => {
    mockDomainOwner.mockResolvedValue({ organizationId: 'root' });
    mockResolveLineage.mockImplementation(async (orgId: unknown) => (orgId === 'root' ? { rootOrgId: 'root' } : { parentOrgId: 'root', rootOrgId: 'root' }));
    mockFindCandidates.mockResolvedValue([candidate('team', { allowedEmailDomains: ['acme.com'] }), candidate('root', { ssoRequired: false })]);
    verifiedDomains([{ organizationId: 'root', domain: 'acme.com' }]);
    await expect(findSsoCoverageForEmail('u@acme.com')).resolves.toMatchObject({ orgId: 'root', required: false });
  });
});

describe('unverifiedDomains', () => {
  it('names the domains the org cannot vouch for', async () => {
    verifiedDomains([{ organizationId: 'org-1', domain: 'acme.com' }]);
    await expect(unverifiedDomains('org-1', ['acme.com', 'gmail.com'])).resolves.toEqual(['gmail.com']);
  });
});

describe('hasVerifiedDomain', () => {
  it('counts the org\'s own verified domains', async () => {
    verifiedDomains([{ organizationId: 'org-1', domain: 'acme.com' }]);
    await expect(hasVerifiedDomain('org-1')).resolves.toBe(true);
    await expect(hasVerifiedDomain('org-2')).resolves.toBe(false);
  });

  it('counts a root domain for a team only when shared', async () => {
    mockResolveLineage.mockResolvedValue({ parentOrgId: 'root', rootOrgId: 'root' });
    verifiedDomains([{ organizationId: 'root', domain: 'acme.com' }]);
    await expect(hasVerifiedDomain('team')).resolves.toBe(false);
    verifiedDomains([{ organizationId: 'root', domain: 'acme.com', sharedWithTeams: true }]);
    await expect(hasVerifiedDomain('team')).resolves.toBe(true);
  });
});

describe('mayAutoProvisionMembership', () => {
  const GOOGLE = { protocol: 'oidc', provider: 'google' } as const;

  it('always allows an admin-run IdP (its domain was already proven by assertSsoIdentityTrusted)', async () => {
    await expect(mayAutoProvisionMembership('org-1', 'u@acme.com', OIDC)).resolves.toBe(true);
    await expect(mayAutoProvisionMembership('org-1', 'u@acme.com', { protocol: 'saml' })).resolves.toBe(true);
    expect(mockDomainExists).not.toHaveBeenCalled();
  });

  it('Google: refuses to create a membership for an arbitrary Google account', async () => {
    await expect(mayAutoProvisionMembership('org-1', 'someone@gmail.com', GOOGLE)).resolves.toBe(false);
  });

  it('Google: allows it on a domain the org verified', async () => {
    verifiedDomains([{ organizationId: 'org-1', domain: 'acme.com' }]);
    await expect(mayAutoProvisionMembership('org-1', 'new@acme.com', GOOGLE)).resolves.toBe(true);
  });

  it('Google on a team: a root domain counts only when shared', async () => {
    mockResolveLineage.mockResolvedValue({ parentOrgId: 'root', rootOrgId: 'root' });
    verifiedDomains([{ organizationId: 'root', domain: 'acme.com' }]);
    await expect(mayAutoProvisionMembership('team', 'new@acme.com', GOOGLE)).resolves.toBe(false);
    verifiedDomains([{ organizationId: 'root', domain: 'acme.com', sharedWithTeams: true }]);
    await expect(mayAutoProvisionMembership('team', 'new@acme.com', GOOGLE)).resolves.toBe(true);
  });

  it('Google: refuses an address with no domain', async () => {
    await expect(mayAutoProvisionMembership('org-1', 'not-an-email', GOOGLE)).resolves.toBe(false);
  });
});
