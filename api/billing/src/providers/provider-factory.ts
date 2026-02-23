/**
 * @module providers/provider-factory
 * @description Factory to create the appropriate PaymentProvider based on config.
 *
 * Uses BILLING_PROVIDER env var:
 *   - 'stub' (default) — no-op provider for local dev
 *   - 'aws-marketplace' — AWS Marketplace SaaS integration
 */

import { createLogger } from '@mwashburn160/api-core';
import { config } from '../config';
import { AWSMarketplaceProvider } from './aws-marketplace-provider';
import type { PaymentProvider } from './payment-provider';
import { StubPaymentProvider } from './stub-provider';

const logger = createLogger('provider-factory');

let cachedProvider: PaymentProvider | null = null;

/**
 * Get the configured payment provider (singleton).
 * Validates required config when using aws-marketplace.
 */
export function getPaymentProvider(): PaymentProvider {
  if (cachedProvider) return cachedProvider;

  switch (config.billingProvider) {
    case 'aws-marketplace': {
      if (!config.marketplace.productCode) {
        throw new Error(
          'AWS_MARKETPLACE_PRODUCT_CODE is required when BILLING_PROVIDER=aws-marketplace',
        );
      }
      cachedProvider = new AWSMarketplaceProvider(config.marketplace);
      logger.info('Using AWS Marketplace payment provider', {
        productCode: config.marketplace.productCode,
        region: config.marketplace.region,
      });
      break;
    }
    case 'stub':
    default: {
      cachedProvider = new StubPaymentProvider();
      logger.info('Using stub payment provider');
      break;
    }
  }

  return cachedProvider;
}
