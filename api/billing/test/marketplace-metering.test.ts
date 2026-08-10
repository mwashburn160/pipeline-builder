// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for reportMarketplaceAddonUsage — resolves an account's Marketplace
 * customer + add-on set and hands off to the provider's BatchMeterUsage. The
 * provider and its AWS clients are mocked; this covers the skip/dispatch/error
 * branches of the report helper, not the AWS call itself (see providers.test.ts).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// createScheduler is constructed at module load; start() invokes run() so the
// cadence tests can assert the cycle's effects (the interval itself is api-core's
// concern). Capture the scheduler so tests can drive start/stop.
const schedulerStart = jest.fn();
const schedulerStop = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createScheduler: (opts: { run: () => Promise<void> }) => ({
    start: () => { schedulerStart(); void opts.run(); },
    stop: () => { schedulerStop(); },
  }),
}));

// incCounter (metrics) comes from api-server — stub so no real registry loads.
const mockIncCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));

// Pass-through tenant-context wrapper (real one is AsyncLocalStorage-backed).
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

// Credit realization collaborators — stub so this suite covers the cycle's own
// orchestration (planning is unit-tested in marketplace-credit.test).
const mockCreateBillingEvent = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/helpers/billing-helpers.js', () => ({ createBillingEvent: (...a: unknown[]) => mockCreateBillingEvent(...a) }));
const mockGrantPeriodicCredits = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/helpers/discount-helpers.js', () => ({ grantPeriodicCredits: (...a: unknown[]) => mockGrantPeriodicCredits(...a) }));
const mockGrantRecurringPromotions = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/helpers/promotion-engine.js', () => ({ grantRecurringPromotions: (...a: unknown[]) => mockGrantRecurringPromotions(...a) }));
const mockRecordMarketplaceConsumption = jest.fn<(...a: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/helpers/billing-ledger.js', () => ({ recordMarketplaceConsumption: (...a: unknown[]) => mockRecordMarketplaceConsumption(...a) }));
const mockAuditRecord = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({ getAuditClient: () => ({ record: mockAuditRecord }) }));

const mockSubscriptionFindOne = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSubscriptionFind = jest.fn<(...args: unknown[]) => unknown>();
const mockSubscriptionFindOneAndUpdate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSubscriptionFindById = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    findOne: (...args: unknown[]) => mockSubscriptionFindOne(...args),
    find: (...args: unknown[]) => mockSubscriptionFind(...args),
    findOneAndUpdate: (...args: unknown[]) => mockSubscriptionFindOneAndUpdate(...args),
    findById: (...args: unknown[]) => mockSubscriptionFindById(...args),
  },
}));

// The provider must be a real AWSMarketplaceProvider *instance* for the helper's
// `instanceof` guard, but with meterAddonUsage stubbed. Mock the module's class
// with one whose prototype method we control.
const mockMeterAddonUsage = jest.fn<(...args: unknown[]) => Promise<unknown>>();
class FakeAWSMarketplaceProvider {
  meterAddonUsage(...args: unknown[]) { return mockMeterAddonUsage(...args); }
}
jest.unstable_mockModule('../src/providers/aws-marketplace-provider.js', () => ({
  AWSMarketplaceProvider: FakeAWSMarketplaceProvider,
}));

const mockGetPaymentProvider = jest.fn<() => unknown>();
jest.unstable_mockModule('../src/providers/provider-factory.js', () => ({
  getPaymentProvider: () => mockGetPaymentProvider(),
}));

// Config gates — mutate per test.
const mockConfig = {
  billingProvider: 'aws-marketplace' as string,
  meteringEnabled: true,
  meteringIntervalMs: 3600000,
  marketplace: {
    creditsEnabled: false,
    meteringEnabled: true,
    bundleToDimensionMap: { seat_pack: 'seats' } as Record<string, string>,
    dimensionPriceMap: { seats: 1000 } as Record<string, number>,
    drawdownDryRun: false,
  },
};
jest.unstable_mockModule('../src/config.js', () => ({ config: mockConfig }));

const { reportMarketplaceAddonUsage, reportAllMarketplaceAddonUsage, startMarketplaceMetering, stopMarketplaceMetering } =
  await import('../src/helpers/marketplace-metering.js');

/** Wire Subscription.find(...).select(...).lean() to resolve the given rows. */
function findResolves(rows: unknown[]) {
  mockSubscriptionFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(rows) }) });
}

const activeSub = (over: Record<string, unknown> = {}) => ({
  orgId: 'org-1',
  status: 'active',
  externalCustomerId: 'cust-ext',
  metadata: { awsCustomerIdentifier: 'cust-aws' },
  addons: [{ bundleId: 'seat_pack', quantity: 2 }],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.billingProvider = 'aws-marketplace';
  mockConfig.meteringEnabled = true;
  mockConfig.marketplace.creditsEnabled = false; // credit realization off unless a test opts in
  mockConfig.marketplace.drawdownDryRun = false;
  mockConfig.marketplace.bundleToDimensionMap = { seat_pack: 'seats' };
  mockConfig.marketplace.dimensionPriceMap = { seats: 1000 };
  mockGetPaymentProvider.mockReturnValue(new FakeAWSMarketplaceProvider());
  mockMeterAddonUsage.mockResolvedValue({ metered: 1, skipped: [], unprocessed: 0 });
});

describe('reportMarketplaceAddonUsage', () => {
  it('skips when the billing provider is not aws-marketplace', async () => {
    mockConfig.billingProvider = 'stripe';
    const out = await reportMarketplaceAddonUsage('org-1');
    expect(out).toEqual({ status: 'skipped', reason: 'not-marketplace' });
    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
  });

  it('skips when there is no active subscription', async () => {
    mockSubscriptionFindOne.mockResolvedValue(null);
    const out = await reportMarketplaceAddonUsage('org-1');
    expect(out).toEqual({ status: 'skipped', reason: 'no-subscription' });
  });

  it('skips when no Marketplace customer identifier is resolvable', async () => {
    mockSubscriptionFindOne.mockResolvedValue(activeSub({ externalCustomerId: undefined, metadata: {} }));
    const out = await reportMarketplaceAddonUsage('org-1');
    expect(out).toEqual({ status: 'skipped', reason: 'no-customer' });
  });

  it('skips when the account has no add-ons', async () => {
    mockSubscriptionFindOne.mockResolvedValue(activeSub({ addons: [] }));
    const out = await reportMarketplaceAddonUsage('org-1');
    expect(out).toEqual({ status: 'skipped', reason: 'no-addons' });
  });

  it('skips when the resolved provider is not the Marketplace provider', async () => {
    mockSubscriptionFindOne.mockResolvedValue(activeSub());
    mockGetPaymentProvider.mockReturnValue({ notAProvider: true });
    const out = await reportMarketplaceAddonUsage('org-1');
    expect(out).toEqual({ status: 'skipped', reason: 'provider-mismatch' });
  });

  it('meters using the awsCustomerIdentifier and the current add-on set', async () => {
    mockSubscriptionFindOne.mockResolvedValue(activeSub());
    const out = await reportMarketplaceAddonUsage('org-1');
    expect(mockMeterAddonUsage).toHaveBeenCalledWith('cust-aws', [{ bundleId: 'seat_pack', quantity: 2 }], expect.any(Date));
    expect(out).toEqual({ status: 'metered', result: { metered: 1, skipped: [], unprocessed: 0 } });
  });

  it('falls back to externalCustomerId when metadata has no aws identifier', async () => {
    mockSubscriptionFindOne.mockResolvedValue(activeSub({ metadata: {} }));
    await reportMarketplaceAddonUsage('org-1');
    expect(mockMeterAddonUsage).toHaveBeenCalledWith('cust-ext', expect.anything(), expect.any(Date));
  });

  it('returns an error outcome (does not throw) when metering fails', async () => {
    mockSubscriptionFindOne.mockResolvedValue(activeSub());
    mockMeterAddonUsage.mockRejectedValue(new Error('throttled'));
    const out = await reportMarketplaceAddonUsage('org-1');
    expect(out).toEqual({ status: 'error', error: 'Error: throttled' });
  });
});

describe('reportMarketplaceAddonUsage — usage-credit realization', () => {
  const creditSub = (over: Record<string, unknown> = {}) => activeSub({
    _id: { toString: () => 'sub-1' },
    interval: 'monthly',
    creditBalanceCents: 3000,
    addons: [{ bundleId: 'seat_pack', quantity: 3 }],
    ...over,
  });

  // Route the two atomic claims by their query shape.
  function claims({ period, hour }: { period?: unknown; hour?: unknown }) {
    mockSubscriptionFindOneAndUpdate.mockImplementation((query: any) => {
      if (query['metadata.lastCreditPeriod']) return Promise.resolve(period ?? null);
      if (query['metadata.lastDrawdownHour']) return Promise.resolve(hour ?? null);
      return Promise.resolve(null);
    });
  }

  beforeEach(() => { mockConfig.marketplace.creditsEnabled = true; });

  it('withholds units, draws the credit down once, records consumption, emits credit_consumed', async () => {
    mockSubscriptionFindOne.mockResolvedValue(creditSub());
    mockSubscriptionFindById.mockResolvedValue(creditSub()); // period already granted → reload
    claims({ period: null, hour: { creditBalanceCents: 0 } });

    await reportMarketplaceAddonUsage('org-1', new Date('2026-07-29T14:00:00Z'));

    // $30 credit @ $10/seat withholds all 3 → report quantity 0.
    expect(mockMeterAddonUsage).toHaveBeenCalledWith('cust-aws', [{ bundleId: 'seat_pack', quantity: 0 }], expect.any(Date));
    // B1: consumption recorded on a per-period BillingInvoice row (dashboard visibility).
    expect(mockRecordMarketplaceConsumption).toHaveBeenCalledWith('org-1', '2026-07', new Date(Date.UTC(2026, 6, 1)), new Date(Date.UTC(2026, 7, 1)), 3000);
    // B2: the drawdown update decrements the balance but does NOT $push a per-hour creditLedger entry.
    const hourUpdate = mockSubscriptionFindOneAndUpdate.mock.calls.find((c: any) => c[0]['metadata.lastDrawdownHour'])?.[1] as any;
    expect(hourUpdate.$push).toBeUndefined();
    expect(hourUpdate.$inc).toEqual({ creditBalanceCents: -3000 });
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-1', 'credit_consumed', { consumedCents: 3000, dimensions: 1 }, 'sub-1');
    expect(mockCreateBillingEvent).toHaveBeenCalledWith('org-1', 'credit_exhausted', { previousCents: 3000 }, 'sub-1');
    expect(mockIncCounter).toHaveBeenCalledWith('billing_marketplace_credit_consumed_total', {});
  });

  it('does NOT draw down twice in the same hour (atomic hour claim lost → no event)', async () => {
    mockSubscriptionFindOne.mockResolvedValue(creditSub());
    mockSubscriptionFindById.mockResolvedValue(creditSub());
    claims({ period: null, hour: null }); // hour already claimed by another cycle/pod

    await reportMarketplaceAddonUsage('org-1');
    expect(mockMeterAddonUsage).toHaveBeenCalled(); // still reports (AWS dedupes)
    expect(mockCreateBillingEvent).not.toHaveBeenCalledWith('org-1', 'credit_consumed', expect.anything(), expect.anything());
  });

  it('does NOT draw down when any record was unprocessed (all-or-nothing)', async () => {
    mockSubscriptionFindOne.mockResolvedValue(creditSub());
    mockSubscriptionFindById.mockResolvedValue(creditSub());
    claims({ period: null, hour: { creditBalanceCents: 0 } });
    mockMeterAddonUsage.mockResolvedValue({ metered: 0, skipped: [], unprocessed: 1 });

    await reportMarketplaceAddonUsage('org-1');
    expect(mockSubscriptionFindOneAndUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ 'metadata.lastDrawdownHour': expect.anything() }), expect.anything(), expect.anything(),
    );
    expect(mockCreateBillingEvent).not.toHaveBeenCalledWith('org-1', 'credit_consumed', expect.anything(), expect.anything());
  });

  it('dry-run reports FULL quantities and touches nothing', async () => {
    mockConfig.marketplace.drawdownDryRun = true;
    mockSubscriptionFindOne.mockResolvedValue(creditSub());
    mockSubscriptionFindById.mockResolvedValue(creditSub());
    claims({ period: null });

    await reportMarketplaceAddonUsage('org-1');
    expect(mockMeterAddonUsage).toHaveBeenCalledWith('cust-aws', [{ bundleId: 'seat_pack', quantity: 3 }], expect.any(Date));
    expect(mockCreateBillingEvent).not.toHaveBeenCalledWith('org-1', 'credit_consumed', expect.anything(), expect.anything());
  });

  it('re-grants recurring/combo credits once per period (winner runs grantPeriodicCredits)', async () => {
    const granted = creditSub({ save: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined) });
    mockSubscriptionFindOne.mockResolvedValue(creditSub());
    claims({ period: granted, hour: { creditBalanceCents: 0 } });

    await reportMarketplaceAddonUsage('org-1', new Date('2026-07-29T14:00:00Z'));
    expect(mockGrantPeriodicCredits).toHaveBeenCalledWith(granted, '2026-07'); // monthly period key
    expect(granted.save).toHaveBeenCalled();
  });

  it('warns + counts an unrealizable balance (credit but no priced meterable dimension)', async () => {
    mockConfig.marketplace.dimensionPriceMap = {}; // seats now unpriced
    mockSubscriptionFindOne.mockResolvedValue(creditSub());
    mockSubscriptionFindById.mockResolvedValue(creditSub());
    claims({ period: null });

    await reportMarketplaceAddonUsage('org-1');
    expect(mockIncCounter).toHaveBeenCalledWith('billing_marketplace_credit_unrealizable_total', {});
    expect(mockMeterAddonUsage).toHaveBeenCalledWith('cust-aws', [{ bundleId: 'seat_pack', quantity: 3 }], expect.any(Date));
    expect(mockCreateBillingEvent).not.toHaveBeenCalledWith('org-1', 'credit_consumed', expect.anything(), expect.anything());
  });
});

describe('reportAllMarketplaceAddonUsage (metering cycle)', () => {
  it('queries only active Marketplace subs that carry add-ons', async () => {
    findResolves([]);
    await reportAllMarketplaceAddonUsage();
    expect(mockSubscriptionFind).toHaveBeenCalledWith({
      'status': 'active',
      'metadata.provider': 'aws-marketplace',
      'addons': { $exists: true, $ne: [] },
    });
  });

  it('reports each account and tallies metered/errors, isolating per-account failure', async () => {
    findResolves([{ orgId: 'org-1' }, { orgId: 'org-2' }, { orgId: 'org-3' }]);
    // org-1 meters ok, org-2 throws (→ error outcome), org-3 meters ok.
    mockSubscriptionFindOne
      .mockResolvedValueOnce(activeSub({ orgId: 'org-1' }))
      .mockResolvedValueOnce(activeSub({ orgId: 'org-2' }))
      .mockResolvedValueOnce(activeSub({ orgId: 'org-3' }));
    mockMeterAddonUsage
      .mockResolvedValueOnce({ metered: 1, skipped: [], unprocessed: 0 })
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({ metered: 1, skipped: [], unprocessed: 0 });

    const summary = await reportAllMarketplaceAddonUsage();
    expect(summary).toEqual({ accounts: 3, metered: 2, errors: 1 });
    expect(mockMeterAddonUsage).toHaveBeenCalledTimes(3);
  });

  it('is a no-op summary when no Marketplace accounts have add-ons', async () => {
    findResolves([]);
    const summary = await reportAllMarketplaceAddonUsage();
    expect(summary).toEqual({ accounts: 0, metered: 0, errors: 0 });
  });
});

describe('startMarketplaceMetering (scheduler gating)', () => {
  it('starts and runs a cycle when provider=aws-marketplace and metering enabled', async () => {
    findResolves([]);
    startMarketplaceMetering();
    expect(schedulerStart).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionFind).toHaveBeenCalled(); // run() fired on start
  });

  it('does NOT start when metering is disabled', () => {
    mockConfig.meteringEnabled = false;
    startMarketplaceMetering();
    expect(schedulerStart).not.toHaveBeenCalled();
  });

  it('does NOT start for a non-Marketplace provider', () => {
    mockConfig.billingProvider = 'stripe';
    startMarketplaceMetering();
    expect(schedulerStart).not.toHaveBeenCalled();
  });

  it('stop() is safe to call', () => {
    stopMarketplaceMetering();
    expect(schedulerStop).toHaveBeenCalled();
  });
});
