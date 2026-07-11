// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for payment providers and provider factory.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

// Mock Mongoose Subscription model. findOne returns a promise that also has a
// chainable `.sort()` (the provider does `findOne(...).sort({createdAt:-1})`),
// so both `await findOne(...)` and `await findOne(...).sort(...)` resolve.
const mockFindOne = jest.fn();
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    findOne: (...args: unknown[]) => {
      const p = Promise.resolve(mockFindOne(...args));
      return Object.assign(p, { sort: () => p });
    },
  },
}));

// Mock AWS SDK clients
const mockMeteringSend = jest.fn();
const mockEntitlementSend = jest.fn();
jest.unstable_mockModule('@aws-sdk/client-marketplace-metering', () => ({
  MarketplaceMeteringClient: jest.fn().mockImplementation(() => ({ send: mockMeteringSend })),
  ResolveCustomerCommand: jest.fn(),
  // Echo the input so tests can assert on the ProductCode + UsageRecords sent.
  BatchMeterUsageCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));
jest.unstable_mockModule('@aws-sdk/client-marketplace-entitlement-service', () => ({
  MarketplaceEntitlementServiceClient: jest.fn().mockImplementation(() => ({ send: mockEntitlementSend })),
  GetEntitlementsCommand: jest.fn(),
}));

// Mock Stripe SDK
const mockStripeCustomersCreate = jest.fn();
const mockStripeCustomersRetrieve = jest.fn();
const mockStripeSubscriptionsCreate = jest.fn();
const mockStripeSubscriptionsUpdate = jest.fn();
const mockStripeSubscriptionsRetrieve = jest.fn();
const mockStripePaymentMethodsList = jest.fn();
const mockStripePortalCreate = jest.fn();
jest.unstable_mockModule('stripe', () => {
  const StripeMock = jest.fn().mockImplementation(() => ({
    customers: { create: mockStripeCustomersCreate, retrieve: mockStripeCustomersRetrieve },
    subscriptions: {
      create: mockStripeSubscriptionsCreate,
      update: mockStripeSubscriptionsUpdate,
      retrieve: mockStripeSubscriptionsRetrieve,
    },
    paymentMethods: { list: mockStripePaymentMethodsList },
    billingPortal: { sessions: { create: mockStripePortalCreate } },
  }));
  return { default: StripeMock };
});

const { AWSMarketplaceProvider } = await import('../src/providers/aws-marketplace-provider.js');
const { StripeProvider } = await import('../src/providers/stripe-provider.js');
const { StubPaymentProvider } = await import('../src/providers/stub-provider.js');

type AWSMarketplaceProvider = InstanceType<typeof AWSMarketplaceProvider>;
type StripeProvider = InstanceType<typeof StripeProvider>;

// StubPaymentProvider

describe('StubPaymentProvider', () => {
  const provider = new StubPaymentProvider();

  it('createCustomer returns stub customer ID', async () => {
    const id = await provider.createCustomer('org-1', 'user@example.com');
    expect(id).toBe('stub_cus_org-1');
  });

  it('createSubscription returns stub external IDs', async () => {
    const result = await provider.createSubscription('cus-1', 'pro', 'monthly');
    expect(result.externalId).toMatch(/^stub_sub_/);
    expect(result.externalCustomerId).toBe('cus-1');
  });

  it('cancelSubscription resolves without error', async () => {
    await expect(provider.cancelSubscription('sub-1')).resolves.toBeUndefined();
  });

  it('updateSubscription resolves without error', async () => {
    await expect(provider.updateSubscription('sub-1', 'enterprise')).resolves.toBeUndefined();
  });

  it('reactivateSubscription resolves without error', async () => {
    await expect(provider.reactivateSubscription('sub-1')).resolves.toBeUndefined();
  });
});

// AWSMarketplaceProvider

describe('AWSMarketplaceProvider', () => {
  const marketplaceConfig = {
    productCode: 'test-product',
    region: 'us-east-1',
    snsTopicArn: 'arn:aws:sns:us-east-1:123456789:test-topic',
    dimensionToPlanMap: { developer: 'developer', pro: 'pro', team: 'team', enterprise: 'enterprise' },
    bundleToDimensionMap: { seat_pack: 'seats', pipeline_pack: 'pipelines' },
  };

  let provider: AWSMarketplaceProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new AWSMarketplaceProvider(marketplaceConfig);
  });

  describe('createCustomer', () => {
    it('returns stored customer identifier when marketplace subscription exists', async () => {
      mockFindOne.mockResolvedValue({
        metadata: { provider: 'aws-marketplace', awsCustomerIdentifier: 'cust-abc-123' },
      });

      const result = await provider.createCustomer('org-1', 'user@test.com');
      expect(result).toBe('cust-abc-123');
      expect(mockFindOne).toHaveBeenCalledWith({
        'orgId': 'org-1',
        'metadata.provider': 'aws-marketplace',
      });
    });

    it('throws when no marketplace subscription found', async () => {
      mockFindOne.mockResolvedValue(null);

      await expect(provider.createCustomer('org-1', 'user@test.com'))
        .rejects.toThrow('AWS Marketplace customers must register through the Marketplace');
    });

    it('throws when subscription exists but has no customer identifier', async () => {
      mockFindOne.mockResolvedValue({ metadata: { provider: 'aws-marketplace' } });

      await expect(provider.createCustomer('org-1', 'user@test.com'))
        .rejects.toThrow('AWS Marketplace customers must register through the Marketplace');
    });
  });

  describe('createSubscription', () => {
    it('returns subscription references when customer has active entitlement', async () => {
      mockEntitlementSend.mockResolvedValue({
        Entitlements: [{
          Dimension: 'pro',
          Value: { BooleanValue: true },
        }],
      });

      const result = await provider.createSubscription('cust-abc-123', 'pro', 'monthly');
      expect(result.externalId).toBe('aws_sub_cust-abc-123');
      expect(result.externalCustomerId).toBe('cust-abc-123');
    });

    it('throws when no active entitlement found', async () => {
      mockEntitlementSend.mockResolvedValue({ Entitlements: [] });

      await expect(provider.createSubscription('cust-abc-123', 'pro', 'monthly'))
        .rejects.toThrow('No active AWS Marketplace entitlement found');
    });

    it('succeeds with warning when requested plan differs from entitlement', async () => {
      mockEntitlementSend.mockResolvedValue({
        Entitlements: [{
          Dimension: 'developer',
          Value: { BooleanValue: true },
        }],
      });

      const result = await provider.createSubscription('cust-abc-123', 'pro', 'monthly');
      // Should still succeed — marketplace is source of truth
      expect(result.externalId).toBe('aws_sub_cust-abc-123');
    });

    it('throws when entitlement has no enabled value', async () => {
      mockEntitlementSend.mockResolvedValue({
        Entitlements: [{
          Dimension: 'pro',
          Value: { IntegerValue: 0 },
        }],
      });

      await expect(provider.createSubscription('cust-abc-123', 'pro', 'monthly'))
        .rejects.toThrow('No active AWS Marketplace entitlement found');
    });
  });

  describe('SNS-driven operations (no-ops)', () => {
    it('cancelSubscription resolves without error', async () => {
      await expect(provider.cancelSubscription('aws_sub_123')).resolves.toBeUndefined();
    });

    it('updateSubscription resolves without error', async () => {
      await expect(provider.updateSubscription('aws_sub_123', 'pro')).resolves.toBeUndefined();
    });

    it('reactivateSubscription resolves without error', async () => {
      await expect(provider.reactivateSubscription('aws_sub_123')).resolves.toBeUndefined();
    });
  });

  describe('meterAddonUsage (BatchMeterUsage)', () => {
    it('reports mapped add-ons as usage records and returns the metered count', async () => {
      mockMeteringSend.mockResolvedValue({ UnprocessedRecords: [] });
      const ts = new Date('2026-07-07T00:00:00Z');

      const result = await provider.meterAddonUsage('cust-1', [
        { bundleId: 'seat_pack', quantity: 3 },
        { bundleId: 'pipeline_pack', quantity: 2 },
      ], ts);

      expect(result).toEqual({ metered: 2, skipped: [], unprocessed: 0 });
      expect(mockMeteringSend).toHaveBeenCalledTimes(1);
      const sent = (mockMeteringSend.mock.calls[0][0] as { input: { ProductCode: string; UsageRecords: unknown[] } }).input;
      expect(sent.ProductCode).toBe('test-product');
      expect(sent.UsageRecords).toEqual([
        { CustomerIdentifier: 'cust-1', Dimension: 'seats', Quantity: 3, Timestamp: ts },
        { CustomerIdentifier: 'cust-1', Dimension: 'pipelines', Quantity: 2, Timestamp: ts },
      ]);
    });

    it('skips bundles with no dimension mapping (does not meter them)', async () => {
      mockMeteringSend.mockResolvedValue({ UnprocessedRecords: [] });

      const result = await provider.meterAddonUsage('cust-1', [
        { bundleId: 'seat_pack', quantity: 1 },
        { bundleId: 'audit_log', quantity: 1 }, // unmapped
      ]);

      expect(result.skipped).toEqual(['audit_log']);
      expect(result.metered).toBe(1);
      const sent = (mockMeteringSend.mock.calls[0][0] as { input: { UsageRecords: unknown[] } }).input;
      expect(sent.UsageRecords).toHaveLength(1);
    });

    it('does not call AWS when there are no metered records', async () => {
      const result = await provider.meterAddonUsage('cust-1', [
        { bundleId: 'seat_pack', quantity: 0 }, // zero quantity → no-op
        { bundleId: 'audit_log', quantity: 5 }, // unmapped
      ]);

      expect(result).toEqual({ metered: 0, skipped: ['audit_log'], unprocessed: 0 });
      expect(mockMeteringSend).not.toHaveBeenCalled();
    });

    it('counts AWS UnprocessedRecords against the metered total', async () => {
      mockMeteringSend.mockResolvedValue({
        UnprocessedRecords: [{ CustomerIdentifier: 'cust-1', Dimension: 'seats', Quantity: 3 }],
      });

      const result = await provider.meterAddonUsage('cust-1', [{ bundleId: 'seat_pack', quantity: 3 }]);
      expect(result).toEqual({ metered: 0, skipped: [], unprocessed: 1 });
    });

    it('truncates fractional quantities to a non-negative integer', async () => {
      mockMeteringSend.mockResolvedValue({ UnprocessedRecords: [] });
      await provider.meterAddonUsage('cust-1', [{ bundleId: 'seat_pack', quantity: 2.9 }]);
      const sent = (mockMeteringSend.mock.calls[0][0] as { input: { UsageRecords: Array<{ Quantity: number }> } }).input;
      expect(sent.UsageRecords[0].Quantity).toBe(2);
    });
  });
});

// StripeProvider

describe('StripeProvider', () => {
  const stripeConfig = {
    secretKey: 'sk_test_fake',
    webhookSecret: 'whsec_fake',
    priceToPlanMap: {
      developer_monthly: 'price_dev_mo',
      developer_annual: 'price_dev_yr',
      pro_monthly: 'price_pro_mo',
      pro_annual: 'price_pro_yr',
    },
  };

  let provider: StripeProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new StripeProvider(stripeConfig);
  });

  describe('createCustomer', () => {
    it('creates a Stripe customer and returns the ID', async () => {
      mockStripeCustomersCreate.mockResolvedValue({ id: 'cus_stripe_123' });

      const result = await provider.createCustomer('org-1', 'user@test.com');
      expect(result).toBe('cus_stripe_123');
      // Second arg is the Stripe request-options object; undefined when no
      // idempotency key is supplied.
      expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
        email: 'user@test.com',
        metadata: { orgId: 'org-1' },
      }, undefined);
    });

    it('omits email when empty', async () => {
      mockStripeCustomersCreate.mockResolvedValue({ id: 'cus_stripe_456' });

      const result = await provider.createCustomer('org-1', '');
      expect(result).toBe('cus_stripe_456');
      expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
        email: undefined,
        metadata: { orgId: 'org-1' },
      }, undefined);
    });

    it('forwards an idempotency key as Stripe request options when supplied', async () => {
      mockStripeCustomersCreate.mockResolvedValue({ id: 'cus_stripe_789' });

      await provider.createCustomer('org-1', 'user@test.com', 'cust_key_1');
      expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
        email: 'user@test.com',
        metadata: { orgId: 'org-1' },
      }, { idempotencyKey: 'cust_key_1' });
    });
  });

  describe('createSubscription', () => {
    it('creates a Stripe subscription with the correct price', async () => {
      mockStripeSubscriptionsCreate.mockResolvedValue({
        id: 'sub_stripe_789',
        status: 'active',
      });

      const result = await provider.createSubscription('cus_123', 'pro', 'monthly');
      expect(result.externalId).toBe('sub_stripe_789');
      expect(result.externalCustomerId).toBe('cus_123');
      expect(mockStripeSubscriptionsCreate).toHaveBeenCalledWith({
        customer: 'cus_123',
        items: [{ price: 'price_pro_mo' }],
        metadata: { planId: 'pro', interval: 'monthly' },
      }, undefined);
    });

    it('forwards an idempotency key as Stripe request options when supplied', async () => {
      mockStripeSubscriptionsCreate.mockResolvedValue({ id: 'sub_stripe_790', status: 'active' });

      await provider.createSubscription('cus_123', 'pro', 'monthly', 'sub_key_1');
      expect(mockStripeSubscriptionsCreate).toHaveBeenCalledWith({
        customer: 'cus_123',
        items: [{ price: 'price_pro_mo' }],
        metadata: { planId: 'pro', interval: 'monthly' },
      }, { idempotencyKey: 'sub_key_1' });
    });

    it('throws when no price ID configured for plan/interval', async () => {
      await expect(provider.createSubscription('cus_123', 'enterprise', 'monthly'))
        .rejects.toThrow('No Stripe Price ID configured for plan "enterprise"');
    });
  });

  describe('cancelSubscription', () => {
    it('sets cancel_at_period_end on the subscription', async () => {
      mockStripeSubscriptionsUpdate.mockResolvedValue({});

      await provider.cancelSubscription('sub_stripe_789');
      expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith('sub_stripe_789', {
        cancel_at_period_end: true,
      });
    });
  });

  describe('updateSubscription', () => {
    it('replaces the subscription item with the new price', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue({
        items: { data: [{ id: 'si_item_1' }] },
        metadata: { interval: 'monthly' },
      });
      mockStripeSubscriptionsUpdate.mockResolvedValue({});

      await provider.updateSubscription('sub_stripe_789', 'developer');
      expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith('sub_stripe_789', {
        items: [{ id: 'si_item_1', price: 'price_dev_mo' }],
        metadata: { planId: 'developer', interval: 'monthly' },
      });
    });

    it('throws when subscription has no items', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue({
        items: { data: [] },
        metadata: {},
      });

      await expect(provider.updateSubscription('sub_stripe_789', 'pro'))
        .rejects.toThrow('has no items');
    });

    it('throws when no price configured for the new plan', async () => {
      mockStripeSubscriptionsRetrieve.mockResolvedValue({
        items: { data: [{ id: 'si_item_1' }] },
        metadata: { interval: 'monthly' },
      });

      await expect(provider.updateSubscription('sub_stripe_789', 'enterprise'))
        .rejects.toThrow('No Stripe Price ID configured');
    });
  });

  describe('reactivateSubscription', () => {
    it('clears cancel_at_period_end on the subscription', async () => {
      mockStripeSubscriptionsUpdate.mockResolvedValue({});

      await provider.reactivateSubscription('sub_stripe_789');
      expect(mockStripeSubscriptionsUpdate).toHaveBeenCalledWith('sub_stripe_789', {
        cancel_at_period_end: false,
      });
    });
  });

  describe('hasPaymentMethod', () => {
    it('returns true when the customer has a default payment method', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue({ invoice_settings: { default_payment_method: 'pm_1' } });
      expect(await provider.hasPaymentMethod('cus_1')).toBe(true);
      expect(mockStripePaymentMethodsList).not.toHaveBeenCalled(); // short-circuits
    });

    it('falls back to listing attached payment methods', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue({ invoice_settings: {} });
      mockStripePaymentMethodsList.mockResolvedValue({ data: [{ id: 'pm_2' }] });
      expect(await provider.hasPaymentMethod('cus_1')).toBe(true);
    });

    it('returns false when there is no default and no attached method', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue({ invoice_settings: {} });
      mockStripePaymentMethodsList.mockResolvedValue({ data: [] });
      expect(await provider.hasPaymentMethod('cus_1')).toBe(false);
    });

    it('returns false for a deleted customer', async () => {
      mockStripeCustomersRetrieve.mockResolvedValue({ deleted: true });
      expect(await provider.hasPaymentMethod('cus_1')).toBe(false);
    });

    it('fails CLOSED (false) when the lookup throws', async () => {
      mockStripeCustomersRetrieve.mockRejectedValue(new Error('network'));
      expect(await provider.hasPaymentMethod('cus_1')).toBe(false);
    });
  });

  describe('createBillingPortalSession', () => {
    it('creates a portal session for the customer and returns its URL', async () => {
      mockStripePortalCreate.mockResolvedValue({ url: 'https://billing.stripe.com/session/abc' });
      const url = await provider.createBillingPortalSession('cus_1', 'https://app/dashboard/billing');
      expect(mockStripePortalCreate).toHaveBeenCalledWith({
        customer: 'cus_1',
        return_url: 'https://app/dashboard/billing',
      });
      expect(url).toBe('https://billing.stripe.com/session/abc');
    });
  });
});
