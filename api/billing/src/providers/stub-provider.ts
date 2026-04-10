// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@mwashburn160/api-core';
import type { ExternalSubscriptionResult, PaymentProvider } from './payment-provider';
import type { BillingInterval } from '../models/subscription';

const logger = createLogger('stub-provider');

export class StubPaymentProvider implements PaymentProvider {
  async createCustomer(orgId: string, _email: string): Promise<string> {
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
    };
  }

  async cancelSubscription(externalId: string): Promise<void> {
    logger.debug('Stub: cancelSubscription', { externalId });
  }

  async updateSubscription(externalId: string, planId: string): Promise<void> {
    logger.debug('Stub: updateSubscription', { externalId, planId });
  }

  async reactivateSubscription(externalId: string): Promise<void> {
    logger.debug('Stub: reactivateSubscription', { externalId });
  }
}

/** Singleton stub provider instance. */
export const stubProvider = new StubPaymentProvider();
