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
  BatchMeterUsageCommand,
  type UsageRecord,
} from '@aws-sdk/client-marketplace-metering';
import { createLogger } from '@pipeline-builder/api-core';
import { incCounter } from '@pipeline-builder/api-server';
import type { ExternalSubscriptionResult, PaymentProvider } from './payment-provider.js';
import type { MarketplaceConfig } from '../config.js';
import type { BillingInterval } from '../models/subscription.js';
import { Subscription } from '../models/subscription.js';

const logger = createLogger('aws-marketplace-provider');

/** Result of resolving a marketplace registration token. */
export interface ResolveResult {
  customerIdentifier: string;
  productCode: string;
}

/** Result of checking entitlements. */
export interface EntitlementResult {
  planId: string;
  dimension: string;
  isEntitled: boolean;
  expirationDate?: Date;
}

/** Outcome of a BatchMeterUsage report for a customer's add-ons. */
export interface MeterUsageResult {
  /** Records AWS accepted (submitted minus unprocessed). */
  metered: number;
  /** Bundle IDs with no `bundleToDimensionMap` entry — not reported. */
  skipped: string[];
  /** Records AWS returned as unprocessed (should be retried by the caller). */
  unprocessed: number;
  /** Dimensions of the unprocessed records — AWS did NOT apply the (reduced)
   *  quantity for these, so the caller must not draw credit down for them
   *  (else a partial batch would discount those dimensions twice). */
  unprocessedDimensions: string[];
}

/** AWS BatchMeterUsage accepts at most 25 usage records per call. */
const BATCH_METER_MAX_RECORDS = 25;

export class AWSMarketplaceProvider implements PaymentProvider {
  private readonly meteringClient: MarketplaceMeteringClient;
  private readonly entitlementClient: MarketplaceEntitlementServiceClient;
  private readonly marketplaceConfig: MarketplaceConfig;

  // Marketplace has no customer-balance primitive. When discounts are enabled
  // (BILLING_DISCOUNTS_ENABLED — the same switch as Stripe), usage credits are
  // allowed and realized by WITHHOLDING reported metered usage (the metering job
  // draws the balance down); otherwise discounts are disallowed for these
  // accounts. There is no synchronous `applyUsageCredit` push — the credit is
  // banked locally and the metering cycle realizes it.
  readonly usageCreditSupport: 'metered' | 'none';

  constructor(marketplaceConfig: MarketplaceConfig) {
    this.marketplaceConfig = marketplaceConfig;
    // Realize usage-credit discounts by WITHHOLDING reported metered usage (the
    // metering cycle draws the balance down via `planMeteredDrawdown`). Enabled
    // ONLY when credits + metering are on AND at least one dimension is priced —
    // advertising 'metered' without a running drawdown cycle OR without a price map
    // would BANK a credit that never reduces the AWS bill (silent money loss). So a
    // credit is accepted only when the mechanism that realizes it can actually run.
    const priced = Object.keys(marketplaceConfig.dimensionPriceMap ?? {}).length > 0;
    this.usageCreditSupport = (marketplaceConfig.creditsEnabled && marketplaceConfig.meteringEnabled && priced) ? 'metered' : 'none';
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
  async createCustomer(orgId: string, _email?: string): Promise<string> {
    const existing = await Subscription.findOne({
      orgId,
      'metadata.provider': 'aws-marketplace',
    }).sort({ createdAt: -1 });

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
      // We only reach here after confirming an active AWS Marketplace
      // entitlement, so the subscription is entitlement-worthy immediately.
      status: 'active',
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
   * No-op — plan/interval changes are driven by SNS notifications from AWS
   * Marketplace (entitlements are the source of truth). Accepts `interval` to
   * satisfy the shared PaymentProvider contract, but never pushes it.
   * @see https://docs.aws.amazon.com/marketplace/latest/userguide/saas-notification.html
   */
  async updateSubscription(externalId: string, planId: string, interval: BillingInterval): Promise<void> {
    logger.debug('AWS Marketplace: updateSubscription handled via SNS', { externalId, planId, interval });
  }

  /**
   * No-op — reactivations are driven by SNS notifications from AWS Marketplace.
   * @see https://docs.aws.amazon.com/marketplace/latest/userguide/saas-notification.html
   */
  async reactivateSubscription(externalId: string): Promise<void> {
    logger.debug('AWS Marketplace: reactivateSubscription handled via SNS', { externalId });
  }

  /**
   * No-op — Marketplace add-ons are not pushed as line items the way Stripe's
   * are. In-app self-service bundle mutations are rejected upstream (see
   * `billing-helpers.bundleSelfServiceAllowed`). Marketplace add-on charges are
   * reported as METERED usage instead — see {@link meterAddonUsage}, invoked by
   * `reportMarketplaceAddonUsage` on a reporting cadence rather than on-change.
   */
  async syncAddons(externalId: string): Promise<void> {
    logger.debug('AWS Marketplace: add-ons metered via BatchMeterUsage, not pushed', { externalId });
  }

  /**
   * Report a customer's current add-on quantities to AWS Marketplace as METERED
   * usage (BatchMeterUsage). Each add-on bundle maps to a metered dimension via
   * `bundleToDimensionMap`; the bundle's quantity is the metered quantity. Bundles
   * with no mapping are skipped. Records are chunked to AWS's 25-per-call limit.
   *
   * This is the metered-billing counterpart to Stripe's line-item add-ons: rather
   * than pushing a subscription change, we report consumption and AWS bills the
   * customer for it. Callers invoke this on a cadence (e.g. a periodic usage job)
   * — NOT synchronously on an add-on mutation, since Marketplace add-ons aren't
   * self-service in-app.
   *
   * @param customerIdentifier AWS Marketplace CustomerIdentifier (from ResolveCustomer).
   * @param addons Current add-on set (bundleId + quantity).
   * @param timestamp Usage timestamp (defaults to now); AWS dedupes by hour.
   * @see https://docs.aws.amazon.com/marketplace/latest/APIReference/API_BatchMeterUsage.html
   */
  async meterAddonUsage(
    customerIdentifier: string,
    addons: ReadonlyArray<{ bundleId: string; quantity: number }>,
    timestamp: Date = new Date(),
  ): Promise<MeterUsageResult> {
    const map = this.marketplaceConfig.bundleToDimensionMap ?? {};
    const skipped: string[] = [];
    const records: UsageRecord[] = [];
    for (const addon of addons) {
      const dimension = map[addon.bundleId];
      if (!dimension) { skipped.push(addon.bundleId); continue; }
      // Quantity must be a non-negative integer; a 0-quantity add-on is a no-op.
      const quantity = Math.max(0, Math.trunc(addon.quantity));
      if (quantity === 0) continue;
      records.push({ CustomerIdentifier: customerIdentifier, Dimension: dimension, Quantity: quantity, Timestamp: timestamp });
    }

    if (records.length === 0) {
      logger.info('AWS Marketplace: no metered add-on dimensions to report', { customerIdentifier, skipped });
      return { metered: 0, skipped, unprocessed: 0, unprocessedDimensions: [] };
    }

    let submitted = 0;
    let unprocessed = 0;
    const unprocessedDimensions: string[] = [];
    for (let i = 0; i < records.length; i += BATCH_METER_MAX_RECORDS) {
      const batch = records.slice(i, i + BATCH_METER_MAX_RECORDS);
      const result = await this.meteringClient.send(new BatchMeterUsageCommand({
        ProductCode: this.marketplaceConfig.productCode,
        UsageRecords: batch,
      }));
      submitted += batch.length;
      for (const rec of result.UnprocessedRecords ?? []) {
        unprocessed += 1;
        if (rec.Dimension) unprocessedDimensions.push(rec.Dimension);
      }
    }

    const metered = submitted - unprocessed;
    logger.info('AWS Marketplace: metered add-on usage', { customerIdentifier, metered, unprocessed, skipped });
    return { metered, skipped, unprocessed, unprocessedDimensions };
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

    if (!result.CustomerIdentifier || !result.ProductCode) {
      throw new Error('ResolveCustomer returned incomplete data');
    }

    // Note: AWS also returns CustomerAWSAccountId; we deliberately do NOT map or
    // persist it (repo policy forbids storing AWS account ids).
    return {
      customerIdentifier: result.CustomerIdentifier,
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
      const mapped = this.marketplaceConfig.dimensionToPlanMap[dimension];
      if (!mapped) {
        // Listing/config drift: a dimension AWS entitled the customer to isn't in
        // AWS_MARKETPLACE_DIMENSION_MAP, so a paying customer silently resolves to
        // the free tier (under-entitled). Warn + meter so it's visible.
        logger.warn('Unmapped AWS Marketplace dimension — defaulting to developer tier', { dimension, customerIdentifier });
        incCounter('billing_marketplace_unmapped_dimension_total', { dimension });
      }
      const planId = mapped || 'developer';

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
}
