// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export type BillingProviderType = 'stub' | 'aws-marketplace' | 'stripe';

export interface MarketplaceConfig {
  productCode: string;
  region: string;
  snsTopicArn: string;
  /** Map of AWS Marketplace dimension names to local plan IDs. */
  dimensionToPlanMap: Record<string, string>;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** Map of "{planId}_{interval}" keys to Stripe Price IDs. */
  priceToPlanMap: Record<string, string>;
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
  messageService: {
    host: string;
    port: number;
  };
  marketplace: MarketplaceConfig;
  stripe: StripeConfig;
  /** Grace period in days before downgrading on payment failure (default 7). */
  paymentGracePeriodDays: number;
  /** Days before renewal to send a reminder notification (default 7). */
  renewalReminderDays: number;
  /** Interval in ms for the subscription lifecycle checker (default 1 hour). */
  lifecycleCheckIntervalMs: number;
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

  messageService: {
    host: process.env.MESSAGE_SERVICE_HOST || 'message',
    port: parseInt(process.env.MESSAGE_SERVICE_PORT || '3000', 10),
  },

  paymentGracePeriodDays: parseInt(process.env.PAYMENT_GRACE_PERIOD_DAYS || '7', 10),
  renewalReminderDays: parseInt(process.env.RENEWAL_REMINDER_DAYS || '7', 10),
  lifecycleCheckIntervalMs: parseInt(process.env.BILLING_LIFECYCLE_CHECK_INTERVAL_MS || '3600000', 10),

  marketplace: {
    productCode: process.env.AWS_MARKETPLACE_PRODUCT_CODE || '',
    region: process.env.AWS_MARKETPLACE_REGION || process.env.AWS_REGION || 'us-east-1',
    snsTopicArn: process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN || '',
    dimensionToPlanMap: safeJsonParse(
      process.env.AWS_MARKETPLACE_DIMENSION_MAP,
      { developer: 'developer', pro: 'pro', unlimited: 'unlimited' },
      'AWS_MARKETPLACE_DIMENSION_MAP',
    ),
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
};
