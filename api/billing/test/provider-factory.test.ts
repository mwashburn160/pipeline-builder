// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the payment provider factory.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

// Mock provider implementations so we can identify which one is returned.
jest.unstable_mockModule('../src/providers/aws-marketplace-provider.js', () => ({
  AWSMarketplaceProvider: jest.fn().mockImplementation(() => ({ kind: 'aws' })),
}));
jest.unstable_mockModule('../src/providers/stripe-provider.js', () => ({
  StripeProvider: jest.fn().mockImplementation(() => ({ kind: 'stripe' })),
}));
jest.unstable_mockModule('../src/providers/stub-provider.js', () => ({
  StubPaymentProvider: jest.fn().mockImplementation(() => ({ kind: 'stub' })),
}));

// Mutable config object referenced by the factory.
const mockConfig = {
  billingProvider: 'stub' as string,
  marketplace: {
    productCode: '',
    region: 'us-east-1',
    snsTopicArn: '',
    dimensionToPlanMap: {},
  },
  stripe: {
    secretKey: '',
    webhookSecret: '',
    priceToPlanMap: {},
  },
};

jest.unstable_mockModule('../src/config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

describe('getPaymentProvider', () => {
  beforeEach(() => {
    jest.resetModules();
    mockConfig.billingProvider = 'stub';
    mockConfig.marketplace.productCode = '';
    mockConfig.stripe.secretKey = '';
  });

  it('returns the stub provider when billingProvider is "stub"', async () => {
    mockConfig.billingProvider = 'stub';
    const { getPaymentProvider } = await import('../src/providers/provider-factory.js');
    const provider = getPaymentProvider() as unknown as { kind: string };
    expect(provider.kind).toBe('stub');
  });

  it('returns the stub provider when billingProvider is unknown', async () => {
    mockConfig.billingProvider = 'mystery';
    const { getPaymentProvider } = await import('../src/providers/provider-factory.js');
    const provider = getPaymentProvider() as unknown as { kind: string };
    expect(provider.kind).toBe('stub');
  });

  it('returns the AWS provider when configured', async () => {
    mockConfig.billingProvider = 'aws-marketplace';
    mockConfig.marketplace.productCode = 'prod-abc';
    const { getPaymentProvider } = await import('../src/providers/provider-factory.js');
    const provider = getPaymentProvider() as unknown as { kind: string };
    expect(provider.kind).toBe('aws');
  });

  it('throws when AWS provider is selected without product code', async () => {
    mockConfig.billingProvider = 'aws-marketplace';
    mockConfig.marketplace.productCode = '';
    const { getPaymentProvider } = await import('../src/providers/provider-factory.js');
    expect(() => getPaymentProvider()).toThrow('AWS_MARKETPLACE_PRODUCT_CODE is required');
  });

  it('returns the Stripe provider when configured', async () => {
    mockConfig.billingProvider = 'stripe';
    mockConfig.stripe.secretKey = 'sk_test_x';
    const { getPaymentProvider } = await import('../src/providers/provider-factory.js');
    const provider = getPaymentProvider() as unknown as { kind: string };
    expect(provider.kind).toBe('stripe');
  });

  it('throws when Stripe provider is selected without secret key', async () => {
    mockConfig.billingProvider = 'stripe';
    mockConfig.stripe.secretKey = '';
    const { getPaymentProvider } = await import('../src/providers/provider-factory.js');
    expect(() => getPaymentProvider()).toThrow('STRIPE_SECRET_KEY is required');
  });

  it('caches the result across calls (singleton)', async () => {
    mockConfig.billingProvider = 'stub';
    const { getPaymentProvider } = await import('../src/providers/provider-factory.js');
    const a = getPaymentProvider();
    const b = getPaymentProvider();
    expect(a).toBe(b);
  });
});
