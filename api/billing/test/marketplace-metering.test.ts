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

// Pass-through tenant-context wrapper (real one is AsyncLocalStorage-backed).
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  runWithTenantContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

const mockSubscriptionFindOne = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSubscriptionFind = jest.fn<(...args: unknown[]) => unknown>();
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    findOne: (...args: unknown[]) => mockSubscriptionFindOne(...args),
    find: (...args: unknown[]) => mockSubscriptionFind(...args),
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
const mockConfig = { billingProvider: 'aws-marketplace' as string, meteringEnabled: true, meteringIntervalMs: 3600000 };
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
    expect(mockMeterAddonUsage).toHaveBeenCalledWith('cust-aws', [{ bundleId: 'seat_pack', quantity: 2 }]);
    expect(out).toEqual({ status: 'metered', result: { metered: 1, skipped: [], unprocessed: 0 } });
  });

  it('falls back to externalCustomerId when metadata has no aws identifier', async () => {
    mockSubscriptionFindOne.mockResolvedValue(activeSub({ metadata: {} }));
    await reportMarketplaceAddonUsage('org-1');
    expect(mockMeterAddonUsage).toHaveBeenCalledWith('cust-ext', expect.anything());
  });

  it('returns an error outcome (does not throw) when metering fails', async () => {
    mockSubscriptionFindOne.mockResolvedValue(activeSub());
    mockMeterAddonUsage.mockRejectedValue(new Error('throttled'));
    const out = await reportMarketplaceAddonUsage('org-1');
    expect(out).toEqual({ status: 'error', error: 'Error: throttled' });
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
