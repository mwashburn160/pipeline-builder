// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct unit tests for `isRecipientReachable` — the cross-tenant SEND gate for
 * message creation. Every route test stubs this helper, so its real
 * allow / deny / FAIL-CLOSED-on-throw behavior was never exercised. These tests
 * drive it directly.
 *
 * Reachable IFF the recipient is the caller's OWN org, the SYSTEM support org, or
 * within the caller's ACCOUNT (shared root org). Own-org and system-org are
 * decided with NO network call; a cross-org recipient resolves both roots and a
 * lookup failure DENIES (a transport error must never open a cross-tenant path).
 *
 * The conversation-`*` broadcast guard (#20) is a route-level check (a
 * conversation can never target '*'), tested in routes.test.ts — '*' never
 * reaches this helper.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const SYSTEM_ORG = '000000000000000000000001';

// Control the account-root resolution directly. The real helper builds a
// fetchParentOrgId callback and hands it to resolveRootOrgIdWith; mocking
// resolveRootOrgIdWith lets us assert the allow/deny/fail-closed policy without
// any HTTP. fetchParentOrgId is stubbed but never invoked (the mock ignores the cb).
const mockResolveRoot = jest.fn<(orgId: string, cb: unknown) => Promise<string>>();
// Platform membership probe backing `isTargetUserReachable`.
const mockFetchMembership = jest.fn<(orgId: string, userId: string, opts: unknown) => Promise<boolean | undefined>>();
// Platform subtree listing + name enrichment backing `listReachableOrgs`.
const mockFetchDescendants = jest.fn<(orgId: string, opts: unknown) => Promise<string[] | undefined>>();
const mockResolveOrgNames = jest.fn<(ids: Iterable<string>) => Promise<Map<string, string>>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  SYSTEM_ORG_ID: SYSTEM_ORG,
  fetchParentOrgId: jest.fn(),
  resolveRootOrgIdWith: (orgId: string, cb: unknown) => mockResolveRoot(orgId, cb),
  fetchOrgMembership: (orgId: string, userId: string, opts: unknown) => mockFetchMembership(orgId, userId, opts),
  fetchOrgDescendants: (orgId: string, opts: unknown) => mockFetchDescendants(orgId, opts),
}));

jest.unstable_mockModule('../src/helpers/org-names.js', () => ({
  resolveOrgNames: (ids: Iterable<string>) => mockResolveOrgNames(ids),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

const { isRecipientReachable, isTargetUserReachable, listReachableOrgs } = await import('../src/helpers/org-reachability.js');

describe('isRecipientReachable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('allow (no network lookup)', () => {
    it('allows the caller\'s OWN org (case-insensitive) without resolving roots', async () => {
      const ok = await isRecipientReachable('ORG-1', 'org-1');
      expect(ok).toBe(true);
      expect(mockResolveRoot).not.toHaveBeenCalled();
    });

    it('allows the SYSTEM support org without resolving roots', async () => {
      const ok = await isRecipientReachable('org-1', SYSTEM_ORG);
      expect(ok).toBe(true);
      expect(mockResolveRoot).not.toHaveBeenCalled();
    });
  });

  describe('allow (same account root)', () => {
    it('allows a cross-org recipient that shares the caller\'s root org', async () => {
      // Both sides resolve to the same account root → same account → reachable.
      mockResolveRoot.mockResolvedValue('root-1');

      const ok = await isRecipientReachable('team-a', 'team-b');

      expect(ok).toBe(true);
      expect(mockResolveRoot).toHaveBeenCalledTimes(2);
      expect(mockResolveRoot).toHaveBeenCalledWith('team-a', expect.any(Function));
      expect(mockResolveRoot).toHaveBeenCalledWith('team-b', expect.any(Function));
    });
  });

  describe('deny (different account root)', () => {
    it('denies a cross-org recipient in a different account', async () => {
      mockResolveRoot.mockImplementation(async (orgId: string) =>
        orgId === 'team-a' ? 'root-a' : 'root-b');

      const ok = await isRecipientReachable('team-a', 'unrelated-victim');

      expect(ok).toBe(false);
    });
  });

  describe('fail-closed on lookup error', () => {
    it('DENIES when a root resolution throws (transport error must not open a cross-tenant path)', async () => {
      mockResolveRoot.mockRejectedValue(new Error('platform unreachable'));

      const ok = await isRecipientReachable('team-a', 'team-b');

      expect(ok).toBe(false);
    });

    it('DENIES when only one side\'s resolution throws', async () => {
      mockResolveRoot.mockImplementation(async (orgId: string) => {
        if (orgId === 'team-b') throw new Error('boom');
        return 'root-a';
      });

      const ok = await isRecipientReachable('team-a', 'team-b');

      expect(ok).toBe(false);
    });
  });
});

describe('isTargetUserReachable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows when platform confirms active membership (and lowercases the org)', async () => {
    mockFetchMembership.mockResolvedValue(true);

    const ok = await isTargetUserReachable('ORG-1', 'user-42');

    expect(ok).toBe(true);
    expect(mockFetchMembership).toHaveBeenCalledWith('org-1', 'user-42', expect.any(Object));
  });

  it('rejects only on a DEFINITIVE not-a-member (false)', async () => {
    mockFetchMembership.mockResolvedValue(false);

    const ok = await isTargetUserReachable('org-1', 'ghost');

    expect(ok).toBe(false);
  });

  it('FAILS OPEN on an indeterminate lookup (undefined)', async () => {
    // This is a correctness guard, not an authz boundary, so an unknown result
    // must not block a legitimate send.
    mockFetchMembership.mockResolvedValue(undefined);

    const ok = await isTargetUserReachable('org-1', 'user-42');

    expect(ok).toBe(true);
  });

  it('FAILS OPEN when the lookup throws (transport error)', async () => {
    mockFetchMembership.mockRejectedValue(new Error('platform unreachable'));

    const ok = await isTargetUserReachable('org-1', 'user-42');

    expect(ok).toBe(true);
  });
});

describe('listReachableOrgs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveOrgNames.mockImplementation(async (ids) =>
      new Map([...ids].filter((id) => id !== 'team-x').map((id) => [id, `Name ${id}`])));
  });

  it('a team sees its whole account: the root (isTeam false) and every team (isTeam true)', async () => {
    mockResolveRoot.mockResolvedValue('root-1');
    mockFetchDescendants.mockResolvedValue(['root-1', 'team-a', 'team-b']);

    const orgs = await listReachableOrgs('TEAM-A');

    expect(mockResolveRoot).toHaveBeenCalledWith('team-a', expect.any(Function));
    // Descendants are read with a token scoped to the ROOT (platform access check).
    expect(mockFetchDescendants).toHaveBeenCalledWith('root-1', expect.objectContaining({ authOrgId: 'root-1' }));
    expect(orgs).toEqual([
      { orgId: 'root-1', name: 'Name root-1', isTeam: false },
      { orgId: 'team-a', name: 'Name team-a', isTeam: true },
      { orgId: 'team-b', name: 'Name team-b', isTeam: true },
    ]);
  });

  it('every listed org passes the send gate (same root)', async () => {
    mockResolveRoot.mockResolvedValue('root-1');
    mockFetchDescendants.mockResolvedValue(['root-1', 'team-a']);
    const orgs = await listReachableOrgs('team-a');
    for (const o of orgs) expect(await isRecipientReachable('team-a', o.orgId)).toBe(true);
  });

  it('a flat org lists only itself (no teams)', async () => {
    mockResolveRoot.mockResolvedValue('org-1');
    mockFetchDescendants.mockResolvedValue(undefined);

    expect(await listReachableOrgs('org-1')).toEqual([{ orgId: 'org-1', name: 'Name org-1', isTeam: false }]);
  });

  it('falls back to the raw id when a name is unresolved', async () => {
    mockResolveRoot.mockResolvedValue('root-1');
    mockFetchDescendants.mockResolvedValue(['root-1', 'team-x']);

    const orgs = await listReachableOrgs('root-1');
    expect(orgs[1]).toEqual({ orgId: 'team-x', name: 'team-x', isTeam: true });
  });

  it('degrades to the caller org alone when the hierarchy lookup fails', async () => {
    mockResolveRoot.mockRejectedValue(new Error('platform down'));

    expect(await listReachableOrgs('team-a')).toEqual([{ orgId: 'team-a', name: 'Name team-a', isTeam: false }]);
    expect(mockFetchDescendants).not.toHaveBeenCalled();
  });
});
