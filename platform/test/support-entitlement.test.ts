// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Support entitlement: the pooled-allowance / own-org-ownership split.
 *
 * The decision this encodes is subtle enough that it already produced one bug in
 * review. Contacts POOL subtree-wide — an account buys them once and may spend
 * them anywhere beneath its root, exactly like seats. Ownership does NOT: a team
 * designates its own contacts and reassigns cases only among them, so that a
 * pooled *allowance* never becomes pooled *data* (one team's support cases
 * readable by a sibling).
 *
 * So two fields answer two different questions, and they differ for exactly the
 * case that matters — a team with none of its own contacts inside an account
 * with allowance to spare:
 *
 *   limit / used / canDesignate -> SUBTREE: is there room under the pooled cap?
 *   ownOrgContacts / canOpenCase -> OWN ORG: is there anyone here who may own
 *                                  a case raised here?
 *
 * `canOpenCase` was first written off the SUBTREE count. That would have let any
 * team in a healthy account open cases it then had no legitimate owner for,
 * which is the regression these tests exist to prevent.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  SUPPORT_FEATURE_FLAGS: ['support_standard', 'support_priority', 'support_premium'],
}));
jest.unstable_mockModule('mongoose', () => {
  const api = { Types: { ObjectId: class {} } };
  return { ...api, default: api };
});
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (id: string) => id }));
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  resolveOrgLineage: async () => ({ rootOrgId: 'root' }),
  // The account is root + two teams; `team-a` is the org writing in.
  expandOrgScope: async () => ['root', 'team-a', 'team-b'],
}));

const mockOrgFindById = jest.fn<(...a: unknown[]) => unknown>();
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
}));

/** Counts keyed by the scope the caller passed, so the two reads are distinguishable. */
const mockCount = jest.fn<(ids: readonly string[]) => Promise<number>>();
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  countActiveSupportContacts: (ids: readonly string[]) => mockCount(ids),
}));

const { supportEntitlement } = await import('../src/helpers/support-entitlement.js');

/** `findById(...).select(...).session(...).lean()` — the chain the helper uses. */
const orgDoc = (doc: unknown) => mockOrgFindById.mockReturnValue({
  select: () => ({ session: () => ({ lean: () => Promise.resolve(doc) }) }),
});

/** Subtree count vs own-org count, chosen by the scope length. */
const counts = (subtree: number, ownOrg: number) =>
  mockCount.mockImplementation(async (ids) => (ids.length > 1 ? subtree : ownOrg));

beforeEach(() => {
  mockOrgFindById.mockReset();
  mockCount.mockReset();
});

describe('both halves are required to grant anything', () => {
  it('denies when a baseline is held but the allowance is 0', async () => {
    // The flag says WHAT response was bought; the allowance says HOW MANY people
    // may invoke it. A flag alone is a half-synced account, not an entitlement.
    orgDoc({ quotas: { supportContacts: 0 }, featureEntitlements: ['support_standard'] });
    await expect(supportEntitlement('team-a')).resolves.toMatchObject({
      level: 'support_standard', limit: 0, canDesignate: false, canOpenCase: false,
    });
  });

  it('reports NO premium when the upgrade is held with no baseline at all', async () => {
    // Premium is an upgrade with nothing to upgrade here. Reporting it as a
    // premium entitlement would let a half-synced account look like one that
    // bought 24x7 — which is the strongest claim in the catalog.
    orgDoc({
      quotas: { supportContacts: 0, supportPremiumContacts: 2 },
      featureEntitlements: ['support_premium'],
    });
    await expect(supportEntitlement('team-a')).resolves.toMatchObject({
      level: null, premium: false, canOpenCase: false,
    });
  });

  it('denies when an allowance exists but no level is held', async () => {
    orgDoc({ quotas: { supportContacts: 5 }, featureEntitlements: ['sso'] });
    await expect(supportEntitlement('team-a')).resolves.toMatchObject({
      level: null, canDesignate: false, canOpenCase: false,
    });
  });

  it('does not even count contacts when it is going to deny', async () => {
    // Cheap guard against a future refactor making a denial do DB work.
    orgDoc({ quotas: { supportContacts: 0 }, featureEntitlements: [] });
    await supportEntitlement('team-a');
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('treats a missing org as no entitlement rather than throwing', async () => {
    orgDoc(null);
    await expect(supportEntitlement('gone')).resolves.toMatchObject({ level: null, canOpenCase: false });
  });
});

describe('the two scopes', () => {
  it('counts the SUBTREE for the cap and THIS ORG for ownership', async () => {
    orgDoc({ quotas: { supportContacts: 5 }, featureEntitlements: ['support_standard'] });
    counts(4, 1);
    const e = await supportEntitlement('team-a');
    expect(e).toMatchObject({ limit: 5, used: 4, ownOrgContacts: 1, canDesignate: true, canOpenCase: true });
    // Both reads really happened, with different scopes.
    expect(mockCount).toHaveBeenCalledWith(['root', 'team-a', 'team-b']);
    expect(mockCount).toHaveBeenCalledWith(['team-a']);
  });

  it('THE REGRESSION: a team with spare account allowance but NO contacts of its own cannot open a case', async () => {
    // Sibling teams hold all 3 contacts. Keying `canOpenCase` off the subtree
    // count would return true here and produce a case with no legitimate owner.
    orgDoc({ quotas: { supportContacts: 5 }, featureEntitlements: ['support_standard'] });
    counts(3, 0);
    await expect(supportEntitlement('team-a')).resolves.toMatchObject({
      used: 3, ownOrgContacts: 0, canDesignate: true, canOpenCase: false,
    });
  });

  it('an account AT its cap can still open cases, it just cannot nominate anyone', async () => {
    // The inverse confusion: `canOpenCase` must not be "room under the cap",
    // or a fully-subscribed account would be locked out of its own support.
    orgDoc({ quotas: { supportContacts: 2 }, featureEntitlements: ['support_priority'] });
    counts(2, 2);
    await expect(supportEntitlement('team-a')).resolves.toMatchObject({
      canDesignate: false, canOpenCase: true,
    });
  });

  it('unlimited (-1) allows designation without a cap comparison', async () => {
    orgDoc({ quotas: { supportContacts: -1 }, featureEntitlements: ['support_standard'] });
    counts(99, 1);
    await expect(supportEntitlement('team-a')).resolves.toMatchObject({
      limit: -1, canDesignate: true, canOpenCase: true,
    });
  });
});

describe('baseline precedence, and the upgrade beside it', () => {
  it('picks priority over standard when both baselines are held', async () => {
    // The two BASELINES are mutually exclusive both at purchase and in
    // `effectiveEntitlements`, so holding both is a sync drift. Resolving to the
    // better one means a mis-synced account is never silently served WORSE than
    // it paid for.
    orgDoc({ quotas: { supportContacts: 3 }, featureEntitlements: ['support_standard', 'support_priority'] });
    counts(1, 1);
    await expect(supportEntitlement('team-a')).resolves.toMatchObject({ level: 'support_priority' });
  });

  it('never resolves `level` TO premium, because premium is not a baseline', async () => {
    // The regression this prevents: treating premium as "the best level held"
    // would make every contact of a one-upgrade account look premium, handing
    // 24x7 to people it was not bought for.
    orgDoc({
      quotas: { supportContacts: 3, supportPremiumContacts: 1 },
      featureEntitlements: ['support_standard', 'support_premium'],
    });
    counts(1, 1);
    await expect(supportEntitlement('team-a')).resolves.toMatchObject({
      level: 'support_standard', premium: true, premiumLimit: 1,
    });
  });

  it('reports the upgrade ONLY when both its flag and its cap are present', async () => {
    // Same both-halves rule the baseline has: the flag says the upgrade was
    // bought, the cap says how many contacts it covers.
    orgDoc({
      quotas: { supportContacts: 3, supportPremiumContacts: 0 },
      featureEntitlements: ['support_standard', 'support_premium'],
    });
    counts(1, 1);
    await expect(supportEntitlement('team-a')).resolves.toMatchObject({ premium: false });

    orgDoc({
      quotas: { supportContacts: 3, supportPremiumContacts: 2 },
      featureEntitlements: ['support_standard'],
    });
    counts(1, 1);
    await expect(supportEntitlement('team-a')).resolves.toMatchObject({ premium: false, premiumLimit: 2 });
  });
});
