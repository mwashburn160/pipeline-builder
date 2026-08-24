// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { config } from '../config.js';

const logger = createLogger('billing-config-validate');

const INTERVALS = ['monthly', 'annual'] as const;

/**
 * Boot-time sanity check for the active billing provider's configuration.
 *
 * Deliberately **warns rather than throws**: the provider factory already
 * hard-fails on the truly-required secrets (`STRIPE_SECRET_KEY` /
 * `AWS_MARKETPLACE_PRODUCT_CODE`), and blocking boot on a partially-configured
 * price map would be worse than surfacing it. The goal is to turn "a plan/bundle
 * silently can't be charged" and "the webhook secret is unset" from a 500 at the
 * first customer into a loud, actionable startup log line.
 */
export function validateProviderConfig(): void {
  if (config.billingProvider === 'stripe') {
    validateStripe();
  } else if (config.billingProvider === 'aws-marketplace') {
    validateMarketplace();
  }
}

function validateStripe(): void {
  if (!config.stripe.webhookSecret) {
    logger.warn('STRIPE_WEBHOOK_SECRET is not set — POST /billing/stripe/webhook will 503 and no subscription/payment state will reconcile');
  }

  const priceMap = config.stripe.priceToPlanMap ?? {};
  const billing = Config.get('billing');
  const missing: string[] = [];

  // Every chargeable plan × interval needs a Stripe Price, or subscribe fails fast.
  for (const plan of billing.plans) {
    if (plan.tier === 'unlimited') continue; // billing-disabled default, never sold
    for (const iv of INTERVALS) {
      if ((plan.prices?.[iv] ?? 0) > 0 && !priceMap[`${plan.id}_${iv}`]) missing.push(`${plan.id}_${iv}`);
    }
  }
  // Every priced bundle × interval too, or its line item is silently skipped
  // (granted but not charged — see stripe-provider.syncAddons).
  for (const bundle of billing.bundles ?? []) {
    for (const iv of INTERVALS) {
      if ((bundle.prices?.[iv] ?? 0) > 0 && !priceMap[`${bundle.id}_${iv}`]) missing.push(`${bundle.id}_${iv}`);
    }
  }

  if (missing.length) {
    logger.warn('STRIPE_PRICE_MAP is missing entries — those plans/bundles cannot be subscribed or charged until you add their Stripe Price ids', { missing });
  }
}

function validateMarketplace(): void {
  if (!config.marketplace.snsTopicArn) {
    logger.warn('AWS_MARKETPLACE_SNS_TOPIC_ARN is not set — SNS notifications fail closed (rejected), so entitlement/cancellation lifecycle changes will not sync');
  }
  if (Object.keys(config.marketplace.dimensionToPlanMap ?? {}).length === 0) {
    logger.warn('AWS_MARKETPLACE_DIMENSION_MAP is empty (identity mapping in effect) — confirm your AWS tier dimensions are named exactly like the plan ids (pro/team/enterprise), or unmapped dimensions resolve to the free developer tier');
  }
  if (config.meteringEnabled && Object.keys(config.marketplace.dimensionPriceMap ?? {}).length === 0) {
    logger.warn('BILLING_METERING_ENABLED is on but AWS_MARKETPLACE_DIMENSION_PRICE_MAP is empty — usage-credit drawdown cannot value any dimension, so credits will never reduce the AWS bill');
  }
}
