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
 * grant a quota (e.g. `sso`→idpConfigs) must NOT be pruned (that would strip the
 * paid quota); quota-only packs (seat_pack) are never pruned.
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
  { id: 'audit_log', name: 'Audit Log', description: '', grants: {}, features: ['audit_log'], prices: { monthly: 2000, annual: 20000 }, stackable: false, availableForTiers: ['pro'], isActive: true, sortOrder: 2 },
  // HYBRID: SSO grants a quota (idpConfigs) in ADDITION to its feature flag.
  { id: 'sso', name: 'SSO / IdP', description: '', grants: { idpConfigs: 5 }, features: ['sso'], prices: { monthly: 4000, annual: 40000 }, stackable: false, availableForTiers: ['pro'], isActive: true, sortOrder: 3 },
  { id: 'advanced_reporting', name: 'Advanced Reporting', description: '', grants: {}, features: ['advanced_reporting'], prices: { monthly: 3000, annual: 30000 }, stackable: false, availableForTiers: ['developer', 'pro', 'team'], isActive: true, sortOrder: 4 },
];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // billing-helpers + quota-client link createSafeClient at module load; the
  // prune helper never issues a request, so a bare stub is enough.
  createSafeClient: () => ({ put: jest.fn(), get: jest.fn() }),
}));

// billing-helpers loads incCounter from api-server; stub it (no metrics registry).
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({ incCounter: jest.fn() }));

// billing-helpers imports the Mongoose models at module load — stub them so no
// real mongoose/connection is pulled in (the prune helper touches neither).
const mockBillingEventCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/models/billing-event.js', () => ({
  BillingEvent: { create: mockBillingEventCreate },
}));
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: { updateOne: jest.fn() },
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

const { pruneTierIncludedFeatureAddons, getBundleCatalog, applyTierIncludedAddonPrune, finalizePrunedAddons } = await import('../src/helpers/billing-helpers.js');

describe('pruneTierIncludedFeatureAddons', () => {
  const catalog = getBundleCatalog();

  it('drops pure-feature add-ons (advanced_reporting + audit_log) the new tier now includes, keeping quota packs', () => {
    const addons = [
      { bundleId: 'advanced_reporting', quantity: 1 },
      { bundleId: 'audit_log', quantity: 1 },
      { bundleId: 'seat_pack', quantity: 2 },
    ];
    // enterprise includes advanced_reporting AND audit_log.
    const { addons: kept, pruned } = pruneTierIncludedFeatureAddons(addons, 'enterprise', catalog);

    // Reduced list (what routes persist + sync) keeps only the quota pack.
    expect(kept).toEqual([{ bundleId: 'seat_pack', quantity: 2 }]);
    expect(pruned.map((p) => p.bundleId).sort()).toEqual(['advanced_reporting', 'audit_log']);
    // Each pruned entry carries id + the feature(s) it granted (for the INFO log).
    expect(pruned.find((p) => p.bundleId === 'audit_log')?.features).toEqual(['audit_log']);
    expect(pruned.find((p) => p.bundleId === 'advanced_reporting')?.features).toEqual(['advanced_reporting']);
  });

  it('does NOT prune a HYBRID bundle (sso grants idpConfigs) even when the new tier includes its feature', () => {
    const addons = [
      { bundleId: 'audit_log', quantity: 1 },
      { bundleId: 'sso', quantity: 1 },
    ];
    // team includes BOTH audit_log and sso — but sso also grants a quota.
    const { addons: kept, pruned } = pruneTierIncludedFeatureAddons(addons, 'team', catalog);

    // audit_log (pure feature) is pruned; sso (hybrid) is retained so its
    // idpConfigs quota isn't stripped.
    expect(kept).toEqual([{ bundleId: 'sso', quantity: 1 }]);
    expect(pruned.map((p) => p.bundleId)).toEqual(['audit_log']);
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
      { bundleId: 'audit_log', quantity: 1 },
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
    // Central audit trail: reuses billing.addon.remove, tagged reason: addon_pruned.
    expect(mockAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.addon.remove',
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
      expect.objectContaining({ action: 'billing.addon.remove', actorId: 'system', details: expect.objectContaining({ reason: 'addon_pruned' }) }),
      'billing',
    );
    // The local billing_events row carries no actorId on system paths.
    expect(mockBillingEventCreate).toHaveBeenCalledWith(expect.objectContaining({ actorId: undefined }));
  });
});
