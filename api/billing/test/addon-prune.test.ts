// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for billing-helpers.pruneTierIncludedFeatureAddons — the double-billing
 * fix (docs/billing-bundles.md).
 *
 * A PURE-FEATURE add-on bundle (empty quota `grants`) whose granted feature is
 * now bundled into the destination tier must be dropped on a tier change so the
 * customer stops paying for a feature their tier includes — and because the
 * tier-filtered `/bundles` catalog hides it (its `availableForTiers` excludes the
 * higher tier), they couldn't self-service-remove it. HYBRID bundles that ALSO
 * grant a quota must NOT be pruned (that would strip the paid quota); quota-only
 * packs (seat_pack) are never pruned. No SHIPPED bundle is hybrid today — `sso`
 * was the last one and was withdrawn when SSO became a Team-and-above tier
 * feature — so the hybrid case is exercised with a fixture, because the rule is
 * a property of the prune predicate rather than of any one SKU.
 *
 * The real helper is exercised against the real TIER_FEATURES (from the api-core
 * mock, which mirrors the canonical map) and a fixture bundle catalog served via
 * a mocked pipeline-core Config.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// A realistic fixture catalog: quota packs (no features), pure-feature bundles
// (empty grants + a feature), and a HYBRID (grants a quota AND a feature).
const CATALOG = [
  { id: 'seat_pack', name: 'Seat Pack', description: '', grants: { seats: 5 }, features: [], prices: { monthly: 2500, annual: 25000 }, stackable: true, availableForTiers: ['developer', 'pro', 'team', 'enterprise'], isActive: true, sortOrder: 0 },
  { id: 'pipeline_pack', name: 'Pipeline Pack', description: '', grants: { pipelines: 10 }, features: [], prices: { monthly: 1500, annual: 15000 }, stackable: true, availableForTiers: ['developer', 'pro', 'team', 'enterprise'], isActive: true, sortOrder: 1 },
  { id: 'bulk_operations', name: 'Bulk Operations', description: '', grants: {}, features: ['bulk_operations'], prices: { monthly: 2000, annual: 20000 }, stackable: false, availableForTiers: ['pro'], isActive: true, sortOrder: 2 },
  // HYBRID (fixture-only, see the header): grants a quota in ADDITION to a flag.
  { id: 'hybrid_pack', name: 'Hybrid Pack', description: '', grants: { apiCalls: 100000 }, features: ['team_usage_analytics'], prices: { monthly: 4000, annual: 40000 }, stackable: false, availableForTiers: ['team'], isActive: true, sortOrder: 3 },
  { id: 'advanced_reporting', name: 'Advanced Reporting', description: '', grants: {}, features: ['advanced_reporting'], prices: { monthly: 3000, annual: 30000 }, stackable: false, availableForTiers: ['developer', 'pro', 'team'], isActive: true, sortOrder: 4 },
  // A capacity pack with a FEATURE prerequisite (tier-included on enterprise).
  { id: 'dora_history_pack', name: 'DORA History Pack', description: '', grants: { doraRetentionDays: 365 }, features: [], requiresFeatures: ['advanced_reporting'], prices: { monthly: 3000, annual: 30000 }, stackable: true, maxQuantity: 1, availableForTiers: ['developer', 'pro', 'team', 'enterprise'], isActive: true, sortOrder: 5 },
];

// The prune helper never issues a request, but applyPlanTierChange drives
// syncEntitlements (two `put`s). Resolve them 2xx so that leg succeeds cleanly
// and the only billing_events the helper test sees are its own plan_changed +
// addon_pruned rows.
const mockSafePut = jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({ statusCode: 200 });
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({ put: mockSafePut, get: jest.fn() }),
}));

// billing-helpers loads incCounter from api-server; capture it so the provider
// add-on sync-failure metric can be asserted.
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));

// billing-helpers imports the Mongoose models at module load — stub them so no
// real mongoose/connection is pulled in (the prune helper touches neither).
const mockBillingEventCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/models/billing-event.js', () => ({
  BillingEvent: { create: mockBillingEventCreate },
}));
// syncProviderAddons stamps/clears a durable `metadata.providerAddonSyncPending`
// marker via Subscription.updateOne — capture it to assert the $set/$unset.
const mockSubscriptionUpdateOne = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ modifiedCount: 1 });
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { updateOne: (...args: unknown[]) => mockSubscriptionUpdateOne(...args) },
}));

// billing-helpers now imports the provider factory + service audit client (for the
// auto-prune provider line-item removal + central trail). Stub both with spies so
// finalizePrunedAddons can be asserted without loading the real Stripe/AWS SDKs.
const mockSyncAddons = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => ({ syncAddons: mockSyncAddons }),
}));
const mockAuditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  getAuditClient: () => ({ record: mockAuditRecord }),
}));

// getBundleCatalog reads Config.get('billing').bundles; effectiveEntitlements is
// imported at module top-level (unused by the prune helper) so a stub suffices.
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: (section: string) => (section === 'billing' ? { bundles: CATALOG } : {}) },
  effectiveEntitlements: () => ({ limits: {}, features: [] }),
}));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { quotaService: { host: 'q', port: 1 }, platformService: { host: 'p', port: 1 } },
}));

const { pruneTierIncludedFeatureAddons, getBundleCatalog, syncProviderAddons } = await import('../src/helpers/billing-helpers.js');
const { applyTierIncludedAddonPrune, applyPlanTierChange, finalizePrunedAddons } = await import('../src/helpers/addon-prune.js');

describe('pruneTierIncludedFeatureAddons', () => {
  const catalog = getBundleCatalog();

  it('drops pure-feature add-ons (advanced_reporting + bulk_operations) the new tier now includes, keeping quota packs', () => {
    const addons = [
      { bundleId: 'advanced_reporting', quantity: 1 },
      { bundleId: 'bulk_operations', quantity: 1 },
      { bundleId: 'seat_pack', quantity: 2 },
    ];
    // enterprise includes advanced_reporting AND bulk_operations.
    const { addons: kept, pruned } = pruneTierIncludedFeatureAddons(addons, 'enterprise', catalog);

    // Reduced list (what routes persist + sync) keeps only the quota pack.
    expect(kept).toEqual([{ bundleId: 'seat_pack', quantity: 2 }]);
    expect(pruned.map((p) => p.bundleId).sort()).toEqual(['advanced_reporting', 'bulk_operations']);
    // Each pruned entry carries id + the feature(s) it granted (for the INFO log).
    expect(pruned.find((p) => p.bundleId === 'bulk_operations')?.features).toEqual(['bulk_operations']);
    expect(pruned.find((p) => p.bundleId === 'advanced_reporting')?.features).toEqual(['advanced_reporting']);
  });

  it('does NOT prune a HYBRID bundle (feature AND quota) even when the new tier includes its feature', () => {
    const addons = [
      { bundleId: 'bulk_operations', quantity: 1 },
      { bundleId: 'hybrid_pack', quantity: 1 },
    ];
    // enterprise includes BOTH bulk_operations and team_usage_analytics — but
    // hybrid_pack also grants a quota (apiCalls).
    const { addons: kept, pruned } = pruneTierIncludedFeatureAddons(addons, 'enterprise', catalog);

    // bulk_operations (pure feature) is pruned; hybrid_pack is retained so its
    // apiCalls quota isn't stripped along with the redundant feature.
    expect(kept).toEqual([{ bundleId: 'hybrid_pack', quantity: 1 }]);
    expect(pruned.map((p) => p.bundleId)).toEqual(['bulk_operations']);
  });

  it('never prunes a quota pack (seat_pack) even into the all-inclusive enterprise tier', () => {
    const { addons: kept, pruned } = pruneTierIncludedFeatureAddons(
      [{ bundleId: 'seat_pack', quantity: 3 }], 'enterprise', catalog,
    );
    expect(kept).toEqual([{ bundleId: 'seat_pack', quantity: 3 }]);
    expect(pruned).toHaveLength(0);
  });

  it('keeps a pure-feature add-on the new tier does NOT include (advanced_reporting into pro)', () => {
    // pro does not include advanced_reporting (only enterprise does).
    const { addons: kept, pruned } = pruneTierIncludedFeatureAddons(
      [{ bundleId: 'advanced_reporting', quantity: 1 }], 'pro', catalog,
    );
    expect(kept).toEqual([{ bundleId: 'advanced_reporting', quantity: 1 }]);
    expect(pruned).toHaveLength(0);
  });

  it('keeps an unknown bundle (not in the catalog) and never prunes on the developer tier', () => {
    const addons = [
      { bundleId: 'bulk_operations', quantity: 1 },
      { bundleId: 'mystery_bundle', quantity: 1 },
    ];
    // developer includes no features → nothing is pruned.
    const { addons: kept, pruned } = pruneTierIncludedFeatureAddons(addons, 'developer', catalog);
    expect(kept).toEqual(addons);
    expect(pruned).toHaveLength(0);
  });
});

describe('applyTierIncludedAddonPrune', () => {
  beforeEach(() => jest.clearAllMocks());

  it('mutates subscription.addons to the reduced set and returns the pruned bundles', () => {
    const sub = { addons: [{ bundleId: 'advanced_reporting', quantity: 1 }, { bundleId: 'seat_pack', quantity: 2 }] };
    const pruned = applyTierIncludedAddonPrune(sub, 'enterprise', { orgId: 'org-1', subscriptionId: 'sub-1', source: 'plan_change' });

    expect(sub.addons).toEqual([{ bundleId: 'seat_pack', quantity: 2 }]);
    expect(pruned).toEqual([{ bundleId: 'advanced_reporting', features: ['advanced_reporting'] }]);
  });

  it('drops a pack whose feature prerequisite the new tier no longer provides (enterprise → team)', () => {
    // On enterprise the DORA History Pack rides the tier-included advanced_reporting;
    // team doesn't include it and the account holds no Advanced Reporting add-on.
    const sub = { addons: [{ bundleId: 'dora_history_pack', quantity: 1 }, { bundleId: 'seat_pack', quantity: 2 }] };
    const pruned = applyTierIncludedAddonPrune(sub, 'team', { orgId: 'org-1', subscriptionId: 'sub-1', source: 'plan_change' });

    expect(sub.addons).toEqual([{ bundleId: 'seat_pack', quantity: 2 }]);
    expect(pruned).toEqual([{ bundleId: 'dora_history_pack', features: [] }]);
  });

  it('keeps a feature-prerequisite pack when a held add-on still grants the feature', () => {
    const sub = { addons: [{ bundleId: 'dora_history_pack', quantity: 1 }, { bundleId: 'advanced_reporting', quantity: 1 }] };
    const pruned = applyTierIncludedAddonPrune(sub, 'team', { orgId: 'org-1', subscriptionId: 'sub-1', source: 'plan_change' });

    expect(sub.addons).toEqual([{ bundleId: 'dora_history_pack', quantity: 1 }, { bundleId: 'advanced_reporting', quantity: 1 }]);
    expect(pruned).toEqual([]);
  });

  it('keeps the pack on an upgrade that includes the feature, while pruning the now-redundant add-on', () => {
    const sub = { addons: [{ bundleId: 'dora_history_pack', quantity: 1 }, { bundleId: 'advanced_reporting', quantity: 1 }] };
    const pruned = applyTierIncludedAddonPrune(sub, 'enterprise', { orgId: 'org-1', subscriptionId: 'sub-1', source: 'plan_change' });

    expect(sub.addons).toEqual([{ bundleId: 'dora_history_pack', quantity: 1 }]);
    expect(pruned).toEqual([{ bundleId: 'advanced_reporting', features: ['advanced_reporting'] }]);
  });

  it('leaves addons untouched and returns [] when nothing is tier-included', () => {
    const sub = { addons: [{ bundleId: 'advanced_reporting', quantity: 1 }] };
    // pro does NOT include advanced_reporting.
    const pruned = applyTierIncludedAddonPrune(sub, 'pro', { orgId: 'org-1', subscriptionId: 'sub-1', source: 'plan_change' });

    expect(sub.addons).toEqual([{ bundleId: 'advanced_reporting', quantity: 1 }]);
    expect(pruned).toEqual([]);
  });
});

describe('finalizePrunedAddons', () => {
  beforeEach(() => jest.clearAllMocks());

  const pruned = [{ bundleId: 'advanced_reporting', features: ['advanced_reporting'] }];
  const reduced = [{ bundleId: 'seat_pack', quantity: 2 }];

  it('writes a billing_events addon_pruned row per bundle, records the central audit, and removes the provider line item', async () => {
    await finalizePrunedAddons(pruned, reduced, {
      orgId: 'org-1', subscriptionId: 'sub-1', interval: 'monthly', externalId: 'ext-1', actorId: 'user-1', source: 'plan_change',
    });

    // A billing_events row per pruned bundle (mirrors the addon_removed shape).
    expect(mockBillingEventCreate).toHaveBeenCalledTimes(1);
    expect(mockBillingEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      type: 'subscription_updated',
      subscriptionId: 'sub-1',
      actorId: 'user-1',
      details: expect.objectContaining({ reason: 'addon_pruned', bundleId: 'advanced_reporting', features: ['advanced_reporting'] }),
    }));
    // Central audit trail: dedicated billing.addon.prune action, tagged reason: addon_pruned.
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.addon.prune',
        actorId: 'user-1',
        orgId: 'org-1',
        targetId: 'advanced_reporting',
        details: expect.objectContaining({ reason: 'addon_pruned' }),
      }),
      'billing',
    );
    // Provider line-item removal fires with the REDUCED list (the removal path).
    expect(mockSyncAddons).toHaveBeenCalledWith('ext-1', reduced, 'monthly');
  });

  it('does nothing when the pruned list is empty (no event, audit, or provider call)', async () => {
    await finalizePrunedAddons([], reduced, {
      orgId: 'org-1', subscriptionId: 'sub-1', interval: 'monthly', externalId: 'ext-1', source: 'plan_change',
    });

    expect(mockBillingEventCreate).not.toHaveBeenCalled();
    expect(mockAuditRecord).not.toHaveBeenCalled();
    expect(mockSyncAddons).not.toHaveBeenCalled();
  });

  it('skips the provider call when the subscription has no external id (still records the trail)', async () => {
    await finalizePrunedAddons(pruned, reduced, {
      orgId: 'org-1', subscriptionId: 'sub-1', interval: 'monthly', externalId: undefined, source: 'plan_change',
    });

    expect(mockBillingEventCreate).toHaveBeenCalledTimes(1);
    expect(mockSyncAddons).not.toHaveBeenCalled();
  });

  it('uses actorId "system" on the central trail when no actor is threaded (webhook/SNS path)', async () => {
    await finalizePrunedAddons(pruned, reduced, {
      orgId: 'org-1', subscriptionId: 'sub-1', interval: 'monthly', externalId: 'ext-1', source: 'stripe_plan_change',
    });

    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.addon.prune', actorId: 'system', details: expect.objectContaining({ reason: 'addon_pruned' }) }),
      'billing',
    );
    // The local billing_events row carries no actorId on system paths.
    expect(mockBillingEventCreate).toHaveBeenCalledWith(expect.objectContaining({ actorId: undefined }));
  });
});

// applyPlanTierChange — the shared post-save side-effect runner for the four
// tier-change sites: sync effective entitlements → write the change event →
// finalize the prune (provider line-item removal + central audit). It returns a
// DEFERRED thunk (nothing runs until invoked, so callers run it AFTER save).
describe('applyPlanTierChange', () => {
  beforeEach(() => jest.clearAllMocks());

  function sub() {
    return {
      _id: { toString: () => 'sub-1' },
      orgId: 'org-1',
      interval: 'monthly' as const,
      externalId: 'ext-1',
      addons: [{ bundleId: 'advanced_reporting', quantity: 1 }, { bundleId: 'seat_pack', quantity: 2 }],
    };
  }

  /** Everything the entitlement sync PUT carried, as text — the tier travels in its body. */
  const syncedPayload = () => JSON.stringify(mockSafePut.mock.calls);

  it('does NOT restore the paid tier for a sub whose grace already lapsed', async () => {
    // `past_due` remains MANAGEABLE after the grace downgrade so the customer can
    // fix their billing, and its status does not change — only
    // `gracePeriodDowngradedAt` tells the two halves apart. Without this guard a
    // lapsed customer could change plan and get paid entitlements back for free,
    // permanently, because the drift reconciler skips past_due rows.
    const s = { ...sub(), metadata: { gracePeriodDowngradedAt: new Date().toISOString() } };
    await applyPlanTierChange(s, { tier: 'enterprise' }, {
      oldPlanId: 'pro', newPlanId: 'enterprise', pruned: [], actorId: 'user-1', source: 'plan_change',
    })();

    expect(syncedPayload()).toContain('developer');
    expect(syncedPayload()).not.toContain('enterprise');
  });

  it('lets the SYSADMIN override lift a lapsed sub — a human deliberately granting a tier', async () => {
    const s = { ...sub(), metadata: { gracePeriodDowngradedAt: new Date().toISOString() } };
    await applyPlanTierChange(s, { tier: 'enterprise' }, {
      oldPlanId: 'pro', newPlanId: 'enterprise', pruned: [], actorId: 'admin-1',
      source: 'admin_plan_change', allowLapsedRestore: true,
    })();

    expect(syncedPayload()).toContain('enterprise');
  });

  it('syncs the real tier for a sub that never lapsed', async () => {
    const s = sub();
    await applyPlanTierChange(s, { tier: 'enterprise' }, {
      oldPlanId: 'pro', newPlanId: 'enterprise', pruned: [], actorId: 'user-1', source: 'plan_change',
    })();

    expect(syncedPayload()).toContain('enterprise');
  });

  it('returns a deferred thunk that syncs, writes a plan_changed row, and finalizes the prune', async () => {
    const s = sub();
    const pruned = applyTierIncludedAddonPrune(s, 'enterprise', { orgId: 'org-1', subscriptionId: 'sub-1', source: 'plan_change' });
    const run = applyPlanTierChange(s, { tier: 'enterprise' }, {
      oldPlanId: 'pro', newPlanId: 'enterprise', pruned, actorId: 'user-1', source: 'plan_change',
    });

    // The factory performs NO I/O until the thunk is invoked.
    expect(mockBillingEventCreate).not.toHaveBeenCalled();
    expect(mockSyncAddons).not.toHaveBeenCalled();

    await run();

    // syncEntitlements ran (quota + platform legs via the mocked put).
    expect(mockSafePut).toHaveBeenCalled();
    // plan_changed row, attributed to the acting user.
    expect(mockBillingEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      type: 'plan_changed',
      subscriptionId: 'sub-1',
      actorId: 'user-1',
      details: { oldPlanId: 'pro', newPlanId: 'enterprise' },
    }));
    // Prune finalized: dedicated billing.addon.prune audit + provider removal of
    // the reduced set (the pure-feature bundle dropped, the quota pack kept).
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.addon.prune', targetId: 'advanced_reporting' }),
      'billing',
    );
    expect(mockSyncAddons).toHaveBeenCalledWith('ext-1', [{ bundleId: 'seat_pack', quantity: 2 }], 'monthly');
  });

  it('merges eventDetails into the plan_changed row', async () => {
    const s = { _id: { toString: () => 'sub-2' }, orgId: 'org-2', interval: 'annual' as const, externalId: 'ext-2', addons: [] };
    await applyPlanTierChange(s, { tier: 'pro' }, {
      oldPlanId: 'developer',
      newPlanId: 'pro',
      pruned: [],
      source: 'stripe_plan_change',
      eventDetails: { provider: 'stripe', source: 'stripe_webhook' },
    })();

    expect(mockBillingEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'plan_changed',
      details: { oldPlanId: 'developer', newPlanId: 'pro', provider: 'stripe', source: 'stripe_webhook' },
    }));
  });

  it('honors an event override (interval_changed) instead of plan_changed', async () => {
    const s = { _id: { toString: () => 'sub-3' }, orgId: 'org-3', interval: 'annual' as const, externalId: 'ext-3', addons: [] };
    await applyPlanTierChange(s, { tier: 'pro' }, {
      oldPlanId: 'pro',
      newPlanId: 'pro',
      pruned: [],
      source: 'stripe_plan_change',
      event: { type: 'interval_changed', details: { provider: 'stripe', oldInterval: 'monthly', newInterval: 'annual' } },
    })();

    expect(mockBillingEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      type: 'interval_changed',
      details: { provider: 'stripe', oldInterval: 'monthly', newInterval: 'annual' },
    }));
    expect(mockBillingEventCreate).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'plan_changed' }));
  });
});

// syncProviderAddons — durable providerAddonSyncPending marker + failure metric.
// The provider leg of a prune/add-on change is best-effort; a Stripe failure must
// set a durable marker (so the lifecycle reconciler re-drives the line-item
// removal) + meter the failure, and a success must clear the marker.
describe('syncProviderAddons providerAddonSyncPending marker + metric', () => {
  const addons = [{ bundleId: 'seat_pack', quantity: 2 }];

  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncAddons.mockResolvedValue(undefined);
    mockSubscriptionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it('clears the marker (unset) and emits no metric on a successful provider sync', async () => {
    await syncProviderAddons('ext-1', addons, 'monthly', 'org-1', 'sub-1', 'addon_add');

    expect(mockSyncAddons).toHaveBeenCalledWith('ext-1', addons, 'monthly');
    expect(mockSubscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sub-1' },
      { $unset: { 'metadata.providerAddonSyncPending': '' } },
    );
    expect(mockIncCounter).not.toHaveBeenCalled();
  });

  it('sets the marker + increments the failure counter when the provider sync throws', async () => {
    mockSyncAddons.mockRejectedValueOnce(new Error('stripe 503'));

    // Fail-open: never throws.
    await expect(syncProviderAddons('ext-1', addons, 'monthly', 'org-1', 'sub-1', 'prune')).resolves.toBeUndefined();

    expect(mockSubscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sub-1' },
      { $set: { 'metadata.providerAddonSyncPending': true } },
    );
    expect(mockIncCounter).toHaveBeenCalledWith('billing_provider_addon_sync_failed_total', { source: 'prune' });
  });

  it('does not touch the marker when no subscriptionId is supplied (still meters on failure)', async () => {
    mockSyncAddons.mockRejectedValueOnce(new Error('stripe 503'));

    await syncProviderAddons('ext-1', addons, 'monthly', 'org-1');

    expect(mockSubscriptionUpdateOne).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('billing_provider_addon_sync_failed_total', { source: 'addon_change' });
  });

  it('no-ops entirely (no provider call, no marker, no metric) without an externalId — marketplace stays exempt', async () => {
    await syncProviderAddons(null, addons, 'monthly', 'org-1', 'sub-1', 'addon_add');

    expect(mockSyncAddons).not.toHaveBeenCalled();
    expect(mockSubscriptionUpdateOne).not.toHaveBeenCalled();
    expect(mockIncCounter).not.toHaveBeenCalled();
  });

  it('never throws even if the marker write fails (preserves fail-open contract)', async () => {
    mockSyncAddons.mockRejectedValueOnce(new Error('stripe 503'));
    mockSubscriptionUpdateOne.mockRejectedValueOnce(new Error('mongo down'));

    await expect(syncProviderAddons('ext-1', addons, 'monthly', 'org-1', 'sub-1', 'prune')).resolves.toBeUndefined();
  });
});
