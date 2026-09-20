// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `findDiscoverableOrgsForUser` — discovery annotated with where the CALLER
 * already stands.
 *
 * `GET /auth/onboarding/domain-orgs` used to return a bare eligibility list,
 * which made the join flow write-only: a user who filed a request had nowhere
 * to learn its outcome, and one whose request was approved was still offered
 * "Request access" for an org they had already joined. These cover the
 * annotation, the id-spelling normalization across the three stores involved,
 * and that the plain eligibility read is untouched (`requestOrAutoJoin` still
 * re-runs it, so a leaked annotation there would be an authorization input).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Types } from 'mongoose';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockDomainFind = jest.fn<(...a: unknown[]) => unknown>();
const mockOrgFind = jest.fn<(...a: unknown[]) => unknown>();
const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
const mockJoinFind = jest.fn<(...a: unknown[]) => unknown>();
const mockUserOrgFind = jest.fn<(...a: unknown[]) => unknown>();
const mockResolveLineage = jest.fn<(...a: unknown[]) => Promise<{ rootOrgId: string }>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));
jest.unstable_mockModule('dns', () => ({ promises: { resolveTxt: jest.fn() } }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  OrgDomain: { find: (...a: unknown[]) => mockDomainFind(...a) },
  JoinRequest: { find: (...a: unknown[]) => mockJoinFind(...a) },
  Organization: { find: (...a: unknown[]) => mockOrgFind(...a), findById: (...a: unknown[]) => mockOrgFindById(...a) },
  UserOrganization: { find: (...a: unknown[]) => mockUserOrgFind(...a) },
  User: {},
}));
jest.unstable_mockModule('../src/utils/email.js', () => ({
  emailService: { sendJoinRequestReceived: jest.fn(), sendJoinRequestDecision: jest.fn() },
}));
jest.unstable_mockModule('../src/helpers/in-app-notify.js', () => ({ sendInAppNotification: jest.fn() }));
jest.unstable_mockModule('../src/utils/mongo-tx.js', () => ({
  withMongoTransaction: (fn: (s: unknown) => Promise<unknown>) => fn({}),
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ resolveOrgLineage: (...a: unknown[]) => mockResolveLineage(...a) }));
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({ emailDomain: (e: string) => (e.includes('@') ? e.split('@')[1].toLowerCase() : null) }));
jest.unstable_mockModule('../src/helpers/seats.js', () => ({
  seatCapacityAvailable: jest.fn(), seatCapacityStillWithinCap: jest.fn(), userHasSeatInAccount: jest.fn(),
}));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
jest.unstable_mockModule('../src/services/roles-service.js', () => ({ ensureBaselineRole: jest.fn() }));

const { orgDomainService } = await import('../src/services/org-domain-service.js');

const USER = { _id: new Types.ObjectId('0123456789abcdef01234567'), email: 'jane@acme.com' };

/** Two verified, joinable domains → two candidate orgs. */
const twoDomains = () => ({
  lean: () => Promise.resolve([
    { orgId: 'org-1', domain: 'acme.com', autoJoin: 'request' },
    { orgId: 'org-2', domain: 'acme.com', autoJoin: 'auto' },
  ]),
});

const selectLean = (rows: unknown) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveLineage.mockImplementation(async (orgId) => ({ rootOrgId: String(orgId) }));
  mockOrgFindById.mockReturnValue(selectLean({ tier: 'team', deletedAt: null }));
  mockDomainFind.mockReturnValue(twoDomains());
  mockOrgFind.mockReturnValue(selectLean([
    { _id: 'org-1', name: 'Acme', deletedAt: null },
    { _id: 'org-2', name: 'Acme Labs', deletedAt: null },
  ]));
  mockJoinFind.mockReturnValue(selectLean([]));
  mockUserOrgFind.mockReturnValue(selectLean([]));
});

describe('findDiscoverableOrgsForUser', () => {
  it('leaves an untouched org bare, so the UI still offers the join', async () => {
    const orgs = await orgDomainService.findDiscoverableOrgsForUser(USER);
    expect(orgs).toEqual([
      { orgId: 'org-1', orgName: 'Acme', autoJoin: 'request' },
      { orgId: 'org-2', orgName: 'Acme Labs', autoJoin: 'auto' },
    ]);
  });

  it('marks a pending request and an active membership on the right orgs', async () => {
    mockJoinFind.mockReturnValue(selectLean([{ orgId: 'org-1', status: 'pending' }]));
    mockUserOrgFind.mockReturnValue(selectLean([{ organizationId: 'org-2' }]));

    const orgs = await orgDomainService.findDiscoverableOrgsForUser(USER);
    expect(orgs[0]).toMatchObject({ orgId: 'org-1', requestStatus: 'pending' });
    expect(orgs[0].isMember).toBeUndefined();
    expect(orgs[1]).toMatchObject({ orgId: 'org-2', isMember: true });
    expect(orgs[1].requestStatus).toBeUndefined();
  });

  it('carries a refused request through, since the backend will not re-open it', async () => {
    mockJoinFind.mockReturnValue(selectLean([{ orgId: 'org-1', status: 'denied' }]));
    const orgs = await orgDomainService.findDiscoverableOrgsForUser(USER);
    expect(orgs[0].requestStatus).toBe('denied');
  });

  it('matches ids across the three stores regardless of hex case', async () => {
    mockJoinFind.mockReturnValue(selectLean([{ orgId: 'ORG-1', status: 'pending' }]));
    mockUserOrgFind.mockReturnValue(selectLean([{ organizationId: 'ORG-2' }]));
    const orgs = await orgDomainService.findDiscoverableOrgsForUser(USER);
    expect(orgs[0].requestStatus).toBe('pending');
    expect(orgs[1].isMember).toBe(true);
  });

  it('short-circuits both caller-scoped reads when nothing is discoverable', async () => {
    mockDomainFind.mockReturnValue({ lean: () => Promise.resolve([]) });
    expect(await orgDomainService.findDiscoverableOrgsForUser(USER)).toEqual([]);
    expect(mockJoinFind).not.toHaveBeenCalled();
    expect(mockUserOrgFind).not.toHaveBeenCalled();
  });

  it('keeps the plain eligibility read unannotated', async () => {
    mockJoinFind.mockReturnValue(selectLean([{ orgId: 'org-1', status: 'pending' }]));
    const orgs = await orgDomainService.findDiscoverableOrgsByEmail(USER.email);
    expect(orgs[0]).toEqual({ orgId: 'org-1', orgName: 'Acme', autoJoin: 'request' });
    expect(mockJoinFind).not.toHaveBeenCalled();
  });
});
