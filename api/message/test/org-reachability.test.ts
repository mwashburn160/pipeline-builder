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
import { apiCoreMock } from './helpers/mock-api-core.js';

const SYSTEM_ORG = '000000000000000000000001';

// Control the account-root resolution directly. The real helper builds a
// fetchParentOrgId callback and hands it to resolveRootOrgIdWith; mocking
// resolveRootOrgIdWith lets us assert the allow/deny/fail-closed policy without
// any HTTP. fetchParentOrgId is stubbed but never invoked (the mock ignores the cb).
const mockResolveRoot = jest.fn<(orgId: string, cb: unknown) => Promise<string>>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  SYSTEM_ORG_ID: SYSTEM_ORG,
  fetchParentOrgId: jest.fn(),
  resolveRootOrgIdWith: (orgId: string, cb: unknown) => mockResolveRoot(orgId, cb),
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

const { isRecipientReachable } = await import('../src/helpers/org-reachability.js');

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
