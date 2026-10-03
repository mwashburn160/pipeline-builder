// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { setGauge } from '@pipeline-builder/api-server';
import { getBillingConfig } from '../config/billing-config.js';
import { config } from '../config.js';

const logger = createLogger('billing-config-validate');

const INTERVALS = ['monthly', 'annual'] as const;

/**
 * Every reason this check can report, per provider. Published as 0 OR 1 — see `report`.
 * Exported so the test can assert the published set matches this list exactly: a reason
 * added here but never reported would be a gauge nobody writes, and one reported but not
 * listed would be a gauge nobody documented.
 */
export const REASONS = {
  'stripe': ['webhook_secret_missing', 'price_map_incomplete'],
  'aws-marketplace': [
    'sns_topics_missing', 'sns_subscription_topic_missing', 'sns_entitlement_topic_missing',
    'dimension_map_empty', 'dimension_price_map_empty',
  ],
} as const;

/**
 * Publish one reason as `billing_provider_config_incomplete{provider,reason}`.
 *
 * ALWAYS writes, 0 as well as 1. A gauge only set when something is wrong cannot be
 * told apart from one that was never evaluated, and "absent" is the state a broken
 * deploy is in too. Writing both values makes `> 0` an unambiguous alert.
 */
function report(provider: string, reason: string, bad: boolean): void {
  setGauge('billing_provider_config_incomplete', { provider, reason }, bad ? 1 : 0);
}

/**
 * Boot-time sanity check for the active billing provider's configuration.
 *
 * Deliberately **warns rather than throws**: the provider factory already
 * hard-fails on the truly-required secrets (`STRIPE_SECRET_KEY` /
 * `AWS_MARKETPLACE_PRODUCT_CODE`), and blocking boot on a partially-configured
 * price map would be worse than surfacing it.
 *
 * But a warn alone was not enough. Several of the conditions below leave the
 * provider NON-FUNCTIONAL — an unset webhook secret means no Stripe lifecycle event
 * ever reconciles; unset SNS topics mean no entitlement change ever arrives — and a
 * single startup log line in a container is not something anyone sees. Each reason
 * is therefore also published as a gauge so a misconfigured provider is visible in
 * monitoring (alert: BillingProviderConfigIncomplete) rather than only in the log
 * of a pod that started days ago.
 */
export function validateProviderConfig(): void {
  if (config.billingProvider === 'stripe') {
    validateStripe();
  } else if (config.billingProvider === 'aws-marketplace') {
    validateMarketplace();
  }
}

function validateStripe(): void {
  report('stripe', 'webhook_secret_missing', !config.stripe.webhookSecret);
  if (!config.stripe.webhookSecret) {
    logger.warn('STRIPE_WEBHOOK_SECRET is not set — POST /billing/stripe/webhook will 503 and no subscription/payment state will reconcile');
  }

  const priceMap = config.stripe.priceToPlanMap ?? {};
  const billing = getBillingConfig();
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

  report('stripe', 'price_map_incomplete', missing.length > 0);
  if (missing.length) {
    logger.warn('STRIPE_PRICE_MAP is missing entries — those plans/bundles cannot be subscribed or charged until you add their Stripe Price ids', { missing });
  }
}

function validateMarketplace(): void {
  const topicArns = config.marketplace.snsTopicArns;
  report('aws-marketplace', 'sns_topics_missing', topicArns.length === 0);
  report('aws-marketplace', 'sns_subscription_topic_missing',
    !topicArns.some((arn) => arn.includes(':aws-mp-subscription-notification-')));
  report('aws-marketplace', 'sns_entitlement_topic_missing',
    !topicArns.some((arn) => arn.includes(':aws-mp-entitlement-notification-')));
  if (topicArns.length === 0) {
    logger.warn('AWS_MARKETPLACE_SNS_TOPIC_ARN is not set — SNS notifications fail closed (rejected), so entitlement/cancellation lifecycle changes will not sync');
  } else {
    // Each topic carries different actions, and a message from an unlisted
    // topic is rejected — so a missing one silently drops that whole class.
    if (!topicArns.some((arn) => arn.includes(':aws-mp-subscription-notification-'))) {
      logger.warn('AWS_MARKETPLACE_SNS_TOPIC_ARN has no aws-mp-subscription-notification topic — subscribe/unsubscribe (cancellation) notifications will be rejected');
    }
    if (!topicArns.some((arn) => arn.includes(':aws-mp-entitlement-notification-'))) {
      logger.warn('AWS_MARKETPLACE_SNS_TOPIC_ARN has no aws-mp-entitlement-notification topic — entitlement-updated (tier/quantity change) notifications will be rejected');
    }
  }
  report('aws-marketplace', 'dimension_map_empty',
    Object.keys(config.marketplace.dimensionToPlanMap ?? {}).length === 0);
  report('aws-marketplace', 'dimension_price_map_empty',
    config.meteringEnabled && Object.keys(config.marketplace.dimensionPriceMap ?? {}).length === 0);
  if (Object.keys(config.marketplace.dimensionToPlanMap ?? {}).length === 0) {
    logger.warn('AWS_MARKETPLACE_DIMENSION_MAP is empty (identity mapping in effect) — confirm your AWS tier dimensions are named exactly like the plan ids (pro/team/enterprise), or unmapped dimensions resolve to the free developer tier');
  }
  if (config.meteringEnabled && Object.keys(config.marketplace.dimensionPriceMap ?? {}).length === 0) {
    logger.warn('BILLING_METERING_ENABLED is on but AWS_MARKETPLACE_DIMENSION_PRICE_MAP is empty — usage-credit drawdown cannot value any dimension, so credits will never reduce the AWS bill');
  }
}
