/**
 * Tests for payment providers and provider factory.
 */

jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Mock Mongoose Subscription model
const mockFindOne = jest.fn();
jest.mock('../src/models/subscription', () => ({
  Subscription: { findOne: (...args: unknown[]) => mockFindOne(...args) },
}));

// Mock AWS SDK clients
const mockMeteringSend = jest.fn();
const mockEntitlementSend = jest.fn();
jest.mock('@aws-sdk/client-marketplace-metering', () => ({
  MarketplaceMeteringClient: jest.fn().mockImplementation(() => ({ send: mockMeteringSend })),
  ResolveCustomerCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-marketplace-entitlement-service', () => ({
  MarketplaceEntitlementServiceClient: jest.fn().mockImplementation(() => ({ send: mockEntitlementSend })),
  GetEntitlementsCommand: jest.fn(),
}));

// Mock Stripe SDK
const mockStripeCustomersCreate = jest.fn();
const mockStripeSubscriptionsCreate = jest.fn();
const mockStripeSubscriptionsUpdate = jest.fn();
const mockStripeSubscriptionsRetrieve = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    customers: { create: mockStripeCustomersCreate },
    subscriptions: {
      create: mockStripeSubscriptionsCreate,
      update: mockStripeSubscriptionsUpdate,
      retrieve: mockStripeSubscriptionsRetrieve,
    },
  }));
});

import { AWSMarketplaceProvider } from '../src/providers/aws-marketplace-provider';
import { StripeProvider } from '../src/providers/stripe-provider';
import { StubPaymentProvider } from '../src/providers/stub-provider';

// ---------------------------------------------------------------------------
// StubPaymentProvider
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// AWSMarketplaceProvider
// ---------------------------------------------------------------------------

describe('AWSMarketplaceProvider', () => {
  const marketplaceConfig = {
    productCode: 'test-product',
    region: 'us-east-1',
    snsTopicArn: 'arn:aws:sns:us-east-1:123456789:test-topic',
    dimensionToPlanMap: { developer: 'developer', pro: 'pro', unlimited: 'unlimited' },
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
});

// ---------------------------------------------------------------------------
// StripeProvider
// ---------------------------------------------------------------------------

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
      expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
        email: 'user@test.com',
        metadata: { orgId: 'org-1' },
      });
    });

    it('omits email when empty', async () => {
      mockStripeCustomersCreate.mockResolvedValue({ id: 'cus_stripe_456' });

      const result = await provider.createCustomer('org-1', '');
      expect(result).toBe('cus_stripe_456');
      expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
        email: undefined,
        metadata: { orgId: 'org-1' },
      });
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
      });
    });

    it('throws when no price ID configured for plan/interval', async () => {
      await expect(provider.createSubscription('cus_123', 'unlimited', 'monthly'))
        .rejects.toThrow('No Stripe Price ID configured for plan "unlimited"');
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
});
