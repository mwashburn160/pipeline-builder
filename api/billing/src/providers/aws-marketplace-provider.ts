// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  MarketplaceEntitlementServiceClient,
  GetEntitlementsCommand,
  type Entitlement,
} from '@aws-sdk/client-marketplace-entitlement-service';
import {
  MarketplaceMeteringClient,
  ResolveCustomerCommand,
} from '@aws-sdk/client-marketplace-metering';
import { createLogger } from '@pipeline-builder/api-core';
import type { ExternalSubscriptionResult, PaymentProvider } from './payment-provider';
import type { MarketplaceConfig } from '../config';
import type { BillingInterval } from '../models/subscription';
import { Subscription } from '../models/subscription';

const logger = createLogger('aws-marketplace-provider');

/** Result of resolving a marketplace registration token. */
export interface ResolveResult {
  customerIdentifier: string;
  customerAWSAccountId: string;
  productCode: string;
}

/** Result of checking entitlements. */
export interface EntitlementResult {
  planId: string;
  dimension: string;
  isEntitled: boolean;
  expirationDate?: Date;
}

export class AWSMarketplaceProvider implements PaymentProvider {
  private readonly meteringClient: MarketplaceMeteringClient;
  private readonly entitlementClient: MarketplaceEntitlementServiceClient;
  private readonly marketplaceConfig: MarketplaceConfig;

  constructor(marketplaceConfig: MarketplaceConfig) {
    this.marketplaceConfig = marketplaceConfig;
    this.meteringClient = new MarketplaceMeteringClient({ region: marketplaceConfig.region });
    this.entitlementClient = new MarketplaceEntitlementServiceClient({
      region: marketplaceConfig.region,
    });
  }

  // PaymentProvider interface methods

  /**
   * Look up the AWS Marketplace CustomerIdentifier for an organization.
   * Marketplace customers are identified via ResolveCustomer during the registration
   * flow (POST /billing/marketplace/resolve). This method retrieves the stored
   * identifier from an existing marketplace subscription.
   * @see https://docs.aws.amazon.com/marketplace/latest/APIReference/API_ResolveCustomer.html
   */
  async createCustomer(orgId: string, _email: string): Promise<string> {
    const existing = await Subscription.findOne({
      orgId,
      'metadata.provider': 'aws-marketplace',
    });

    if (existing?.metadata?.awsCustomerIdentifier) {
      const customerIdentifier = existing.metadata.awsCustomerIdentifier as string;
      logger.info('Found existing marketplace customer', { orgId, customerIdentifier });
      return customerIdentifier;
    }

    throw new Error(
      'AWS Marketplace customers must register through the Marketplace. '
      + 'Use POST /billing/marketplace/resolve with a registration token.',
    );
  }

  /**
   * Verify marketplace entitlements and return subscription references.
   * Calls the AWS Marketplace Entitlement Service to confirm the customer
   * has an active entitlement before allowing subscription creation.
   * @see https://docs.aws.amazon.com/marketplace/latest/APIReference/API_GetEntitlements.html
   */
  async createSubscription(
    customerId: string,
    planId: string,
    _interval: BillingInterval,
  ): Promise<ExternalSubscriptionResult> {
    const entitlements = await this.getEntitlements(customerId);
    const activeEntitlement = entitlements.find((e) => e.isEntitled);

    if (!activeEntitlement) {
      throw new Error(
        'No active AWS Marketplace entitlement found for this customer. '
        + 'The customer may need to subscribe through AWS Marketplace.',
      );
    }

    if (activeEntitlement.planId !== planId) {
      logger.warn('Requested plan differs from marketplace entitlement', {
        customerId,
        requestedPlan: planId,
        entitledPlan: activeEntitlement.planId,
      });
    }

    return {
      externalId: `aws_sub_${customerId}`,
      externalCustomerId: customerId,
    };
  }

  /**
   * No-op — cancellations are driven by SNS notifications from AWS Marketplace.
   * @see https://docs.aws.amazon.com/marketplace/latest/userguide/saas-notification.html
   */
  async cancelSubscription(externalId: string): Promise<void> {
    logger.debug('AWS Marketplace: cancelSubscription handled via SNS', { externalId });
  }

  /**
   * No-op — plan changes are driven by SNS notifications from AWS Marketplace.
   * @see https://docs.aws.amazon.com/marketplace/latest/userguide/saas-notification.html
   */
  async updateSubscription(externalId: string, planId: string): Promise<void> {
    logger.debug('AWS Marketplace: updateSubscription handled via SNS', { externalId, planId });
  }

  /**
   * No-op — reactivations are driven by SNS notifications from AWS Marketplace.
   * @see https://docs.aws.amazon.com/marketplace/latest/userguide/saas-notification.html
   */
  async reactivateSubscription(externalId: string): Promise<void> {
    logger.debug('AWS Marketplace: reactivateSubscription handled via SNS', { externalId });
  }

  // AWS Marketplace-specific methods

  /**
   * Exchange a marketplace registration token for customer identity.
   * Called when a customer is redirected from AWS Marketplace to our registration URL.
   */
  async resolveRegistrationToken(token: string): Promise<ResolveResult> {
    logger.info('Resolving AWS Marketplace registration token');

    const command = new ResolveCustomerCommand({ RegistrationToken: token });
    const result = await this.meteringClient.send(command);

    if (!result.CustomerIdentifier || !result.CustomerAWSAccountId || !result.ProductCode) {
      throw new Error('ResolveCustomer returned incomplete data');
    }

    return {
      customerIdentifier: result.CustomerIdentifier,
      customerAWSAccountId: result.CustomerAWSAccountId,
      productCode: result.ProductCode,
    };
  }

  /**
   * Get current entitlements for a customer.
   * Returns the plan ID mapped from the AWS dimension name.
   */
  async getEntitlements(customerIdentifier: string): Promise<EntitlementResult[]> {
    logger.info('Getting AWS Marketplace entitlements', { customerIdentifier });

    const command = new GetEntitlementsCommand({
      ProductCode: this.marketplaceConfig.productCode,
      Filter: {
        CUSTOMER_IDENTIFIER: [customerIdentifier],
      },
    });

    const result = await this.entitlementClient.send(command);
    const entitlements: Entitlement[] = result.Entitlements || [];

    return entitlements.map((ent) => {
      const dimension = ent.Dimension || 'unknown';
      const planId = this.marketplaceConfig.dimensionToPlanMap[dimension] || 'developer';

      return {
        planId,
        dimension,
        isEntitled: ent.Value?.IntegerValue !== undefined
          ? ent.Value.IntegerValue > 0
          : ent.Value?.BooleanValue === true || ent.Value?.StringValue === 'Enabled',
        expirationDate: ent.ExpirationDate ? new Date(ent.ExpirationDate) : undefined,
      };
    });
  }

  getProductCode(): string {
    return this.marketplaceConfig.productCode;
  }

  getSnsTopicArn(): string {
    return this.marketplaceConfig.snsTopicArn;
  }
}
