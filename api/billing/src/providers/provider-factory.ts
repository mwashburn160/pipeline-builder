/**
 * @module providers/provider-factory
 * @description Factory to create the appropriate PaymentProvider based on config.
 *
 * Uses BILLING_PROVIDER env var:
 *   - 'stub' (default) — no-op provider for local dev
 *   - 'aws-marketplace' — AWS Marketplace SaaS integration
 *   - 'stripe' — Stripe payment processing
 */

import { createLogger } from '@mwashburn160/api-core';
import { config } from '../config';
import { AWSMarketplaceProvider } from './aws-marketplace-provider';
import type { PaymentProvider } from './payment-provider';
import { StripeProvider } from './stripe-provider';
import { StubPaymentProvider } from './stub-provider';

const logger = createLogger('provider-factory');

let cachedProvider: PaymentProvider | null = null;

/**
 * Get the configured payment provider (singleton).
 * Validates required config for the selected provider.
 */
export function getPaymentProvider(): PaymentProvider {
  if (cachedProvider) return cachedProvider;

  /** Provider factories keyed by billing provider type. */
  const factories: Record<string, () => PaymentProvider> = {
    'aws-marketplace': () => {
      if (!config.marketplace.productCode) {
        throw new Error('AWS_MARKETPLACE_PRODUCT_CODE is required when BILLING_PROVIDER=aws-marketplace');
      }
      logger.info('Using AWS Marketplace payment provider', {
        productCode: config.marketplace.productCode,
        region: config.marketplace.region,
      });
      return new AWSMarketplaceProvider(config.marketplace);
    },
    'stripe': () => {
      if (!config.stripe.secretKey) {
        throw new Error('STRIPE_SECRET_KEY is required when BILLING_PROVIDER=stripe');
      }
      logger.info('Using Stripe payment provider');
      return new StripeProvider(config.stripe);
    },
    'stub': () => {
      logger.info('Using stub payment provider');
      return new StubPaymentProvider();
    },
  };

  const factory = factories[config.billingProvider] ?? factories.stub;
  cachedProvider = factory();

  return cachedProvider;
}
