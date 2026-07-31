// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export type BillingProviderType = 'stub' | 'aws-marketplace' | 'stripe';

export interface MarketplaceConfig {
  productCode: string;
  region: string;
  snsTopicArn: string;
  /** Map of AWS Marketplace dimension names to local plan IDs. */
  dimensionToPlanMap: Record<string, string>;
  /**
   * Map of local add-on bundle IDs → AWS Marketplace METERED dimension keys
   * (the dimensions registered on the product listing, e.g. `seat_pack` →
   * `seats`). Used by BatchMeterUsage to report add-on consumption for
   * Marketplace-billed accounts. Empty until the listing's metered dimensions
   * are configured — an unmapped bundle is skipped (not metered).
   */
  bundleToDimensionMap: Record<string, string>;
  /**
   * Map of AWS Marketplace METERED dimension key → local list price in CENTS
   * **per metered unit per metering cycle** (cycle length = meteringIntervalMs).
   * Drives the usage-credit drawdown: `withheldUnits × price` is drawn from the
   * account's credit balance. A dimension with no price here is never drawn down
   * (its usage is reported in full). Set from `AWS_MARKETPLACE_DIMENSION_PRICE_MAP`.
   */
  dimensionPriceMap: Record<string, number>;
  /**
   * Whether usage-credit discounts are realized on Marketplace by withholding
   * reported metered usage (`usageCreditSupport: 'metered'`). Set to the SAME
   * value as the discount switch (`BILLING_DISCOUNTS_ENABLED`) — there is no
   * separate Marketplace toggle. Approximate; only offsets metered charges. See
   * docs/billing-discounts.md.
   */
  creditsEnabled: boolean;
  /** Whether the metering cycle runs (`BILLING_METERING_ENABLED`). The credit
   *  drawdown is only accepted when this AND `creditsEnabled` are on — otherwise
   *  the provider reports no credit support (no banking without realization). */
  meteringEnabled: boolean;
  /**
   * Shadow mode (`BILLING_METERING_DRAWDOWN_DRYRUN`): the cycle computes + logs
   * the intended withholding but reports FULL quantities and leaves the credit
   * balance untouched — for validating the price map before going live.
   */
  drawdownDryRun: boolean;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** Map of "{planId}_{interval}" keys to Stripe Price IDs. */
  priceToPlanMap: Record<string, string>;
}

export interface DiscountConfig {
  /** Feature flag — the discount surface 404s when off (default off, opt-in). */
  enabled: boolean;
  /** Mint-time ceiling on a percent discount (1-100). */
  maxPercent: number;
  /** Mint-time ceiling on a dollar/credit discount, in CENTS. */
  maxCents: number;
}

export interface AppConfig {
  enabled: boolean;
  port: number;
  billingProvider: BillingProviderType;
  mongodb: {
    uri: string;
  };
  quotaService: {
    host: string;
    port: number;
  };
  platformService: {
    host: string;
    port: number;
  };
  messageService: {
    host: string;
    port: number;
  };
  marketplace: MarketplaceConfig;
  stripe: StripeConfig;
  discounts: DiscountConfig;
  /** Public frontend base URL — the fallback return target for the Stripe billing
   *  portal when the request carries no Origin header (`PLATFORM_FRONTEND_URL`). */
  frontendUrl: string;
  /** Grace period in days before downgrading on payment failure (default 7). */
  paymentGracePeriodDays: number;
  /** Days before renewal to send a reminder notification (default 7). */
  renewalReminderDays: number;
  /** Interval in ms for the subscription lifecycle checker (default 1 hour). */
  lifecycleCheckIntervalMs: number;
  /**
   * Max ACTIVE subscriptions the entitlement-drift reconciler scans per tick.
   * Bounds the low-frequency drift pass so a large customer base is amortized
   * across ticks rather than hammered every run (default 100).
   */
  entitlementDriftMaxPerTick: number;
  /**
   * Minimum interval (ms) before an already-reconciled subscription is
   * drift-checked again. Combined with the per-tick cap, this ~daily gate
   * ensures every sub is checked at most about once per this window
   * (default 24h).
   */
  entitlementDriftIntervalMs: number;
  /**
   * Whether the AWS Marketplace add-on metering job runs (BatchMeterUsage). Off
   * by default — enable only once the listing's metered dimensions are
   * registered and `AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP` matches them.
   */
  meteringEnabled: boolean;
  /** Interval in ms for the Marketplace add-on metering job (default 1 hour). AWS
   *  dedupes BatchMeterUsage records by (customer, dimension, hour). */
  meteringIntervalMs: number;
}

/** Safely parse a JSON env var, falling back to a default on parse error. */
function safeJsonParse<T>(value: string | undefined, fallback: T, envVarName: string): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    // eslint-disable-next-line no-console -- startup config warning before logger is available
    console.warn(`Invalid JSON in ${envVarName}, using default:`, value);
    return fallback;
  }
}

const billingEnabled = (process.env.BILLING_ENABLED || 'true').toLowerCase() !== 'false';

// Single discount switch (on by default). It governs the discount surface AND
// Marketplace metered-credit realization, so the two are the SAME value — there
// is no separate Marketplace opt-in.
const discountsEnabled = (process.env.BILLING_DISCOUNTS_ENABLED || 'true').toLowerCase() !== 'false';
// Parsed ONCE — the top-level `meteringEnabled` (scheduler gate) and
// `marketplace.meteringEnabled` (credit-drawdown gate + provider invariant) MUST be
// the same value, so they read this single const rather than re-parsing the env.
const meteringEnabled = (process.env.BILLING_METERING_ENABLED || '').toLowerCase() === 'true';

if (billingEnabled && !process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is required when BILLING_ENABLED=true');
}

export const config: AppConfig = {
  enabled: billingEnabled,
  port: parseInt(process.env.PORT || '3000', 10),
  billingProvider: (process.env.BILLING_PROVIDER || 'stub') as BillingProviderType,

  mongodb: {
    uri: process.env.MONGODB_URI || '',
  },

  quotaService: {
    host: process.env.QUOTA_SERVICE_HOST || 'quota',
    port: parseInt(process.env.QUOTA_SERVICE_PORT || '3000', 10),
  },

  platformService: {
    host: process.env.PLATFORM_SERVICE_HOST || 'platform',
    port: parseInt(process.env.PLATFORM_SERVICE_PORT || '3000', 10),
  },

  messageService: {
    host: process.env.MESSAGE_SERVICE_HOST || 'message',
    port: parseInt(process.env.MESSAGE_SERVICE_PORT || '3000', 10),
  },

  paymentGracePeriodDays: parseInt(process.env.PAYMENT_GRACE_PERIOD_DAYS || '7', 10),
  renewalReminderDays: parseInt(process.env.RENEWAL_REMINDER_DAYS || '7', 10),
  lifecycleCheckIntervalMs: parseInt(process.env.BILLING_LIFECYCLE_CHECK_INTERVAL_MS || '3600000', 10),
  entitlementDriftMaxPerTick: parseInt(process.env.BILLING_ENTITLEMENT_DRIFT_MAX_PER_TICK || '100', 10),
  entitlementDriftIntervalMs: parseInt(process.env.BILLING_ENTITLEMENT_DRIFT_INTERVAL_MS || '86400000', 10),
  meteringEnabled,
  meteringIntervalMs: parseInt(process.env.BILLING_METERING_INTERVAL_MS || '3600000', 10),
  frontendUrl: process.env.PLATFORM_FRONTEND_URL || '',

  marketplace: {
    productCode: process.env.AWS_MARKETPLACE_PRODUCT_CODE || '',
    region: process.env.AWS_MARKETPLACE_REGION || process.env.AWS_REGION || 'us-east-1',
    snsTopicArn: process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN || '',
    dimensionToPlanMap: safeJsonParse(
      process.env.AWS_MARKETPLACE_DIMENSION_MAP,
      { developer: 'developer', pro: 'pro', team: 'team', enterprise: 'enterprise' },
      'AWS_MARKETPLACE_DIMENSION_MAP',
    ),
    bundleToDimensionMap: safeJsonParse(
      process.env.AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP,
      // Default: dimension key == bundle ID (a metered quantity of "packs
      // purchased"). Register these dimensions on the listing, or override this
      // map to translate bundle IDs → the listing's actual dimension names.
      {
        seat_pack: 'seat_pack',
        pipeline_pack: 'pipeline_pack',
        plugin_pack: 'plugin_pack',
        api_pack: 'api_pack',
        ai_pack: 'ai_pack',
        storage_pack: 'storage_pack',
        audit_log: 'audit_log',
        sso: 'sso',
      } as Record<string, string>,
      'AWS_MARKETPLACE_BUNDLE_DIMENSION_MAP',
    ),
    // Dimension → local list price in CENTS per metered unit per cycle. Empty by
    // default: an unpriced dimension is never drawn down (reported in full).
    dimensionPriceMap: safeJsonParse(
      process.env.AWS_MARKETPLACE_DIMENSION_PRICE_MAP,
      {} as Record<string, number>,
      'AWS_MARKETPLACE_DIMENSION_PRICE_MAP',
    ),
    // Same value as the discount switch — one toggle for both providers.
    creditsEnabled: discountsEnabled,
    // Same single-parsed value as the top-level flag so the provider can enforce
    // the "no banking a credit without a drawdown cycle" invariant on its own.
    meteringEnabled,
    drawdownDryRun: (process.env.BILLING_METERING_DRAWDOWN_DRYRUN || '').toLowerCase() === 'true',
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    priceToPlanMap: safeJsonParse(
      process.env.STRIPE_PRICE_MAP,
      {} as Record<string, string>,
      'STRIPE_PRICE_MAP',
    ),
  },
  discounts: {
    // On by default (mirrors BILLING_ENABLED's opt-out style); set
    // BILLING_DISCOUNTS_ENABLED=false to hide the discount surface. The SAME
    // switch drives Marketplace metered credits (marketplace.creditsEnabled).
    enabled: discountsEnabled,
    maxPercent: Math.min(100, parseInt(process.env.BILLING_DISCOUNT_MAX_PERCENT || '100', 10) || 100),
    maxCents: parseInt(process.env.BILLING_DISCOUNT_MAX_CENTS || '10000000', 10) || 10000000,
  },
};
