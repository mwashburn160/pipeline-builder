// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import type { ExternalSubscriptionResult, PaymentProvider, ProviderSubscriptionView } from './payment-provider.js';
import type { BillingInterval } from '../models/subscription.js';

const logger = createLogger('stub-provider');

export class StubPaymentProvider implements PaymentProvider {
  async createCustomer(orgId: string, _email?: string): Promise<string> {
    logger.debug('Stub: createCustomer', { orgId });
    return `stub_cus_${orgId}`;
  }

  async createSubscription(
    customerId: string,
    planId: string,
    _interval: BillingInterval,
  ): Promise<ExternalSubscriptionResult> {
    logger.debug('Stub: createSubscription', { customerId, planId });
    return {
      externalId: `stub_sub_${Date.now()}`,
      externalCustomerId: customerId,
      // Dev/stub subscriptions have no real payment step — treat as fully
      // active so the local flow grants entitlements immediately.
      status: 'active',
    };
  }

  async cancelSubscription(externalId: string): Promise<void> {
    logger.debug('Stub: cancelSubscription', { externalId });
  }

  async updateSubscription(externalId: string, planId: string, interval: BillingInterval): Promise<void> {
    logger.debug('Stub: updateSubscription', { externalId, planId, interval });
  }

  async reactivateSubscription(externalId: string): Promise<void> {
    logger.debug('Stub: reactivateSubscription', { externalId });
  }

  /**
   * Stub subscriptions never lapse — always report active. The lifecycle
   * checker therefore never downgrades a stub-provider sub on the stale-active
   * path (dev/test convenience).
   */
  async getSubscription(externalId: string): Promise<ProviderSubscriptionView | null> {
    logger.debug('Stub: getSubscription', { externalId });
    return { status: 'active' };
  }
}
