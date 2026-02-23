/**
 * @module config
 * @description Typed application configuration from environment variables.
 */

export type BillingProviderType = 'stub' | 'aws-marketplace';

export interface MarketplaceConfig {
  productCode: string;
  region: string;
  snsTopicArn: string;
  /** Map of AWS Marketplace dimension names to local plan IDs. */
  dimensionToPlanMap: Record<string, string>;
}

export interface AppConfig {
  enabled: boolean;
  port: number;
  billingProvider: BillingProviderType;
  mongodb: {
    uri: string;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  quotaService: {
    host: string;
    port: number;
  };
  marketplace: MarketplaceConfig;
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
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  },
  quotaService: {
    host: process.env.QUOTA_SERVICE_HOST || 'quota',
    port: parseInt(process.env.QUOTA_SERVICE_PORT || '3000', 10),
  },
  marketplace: {
    productCode: process.env.AWS_MARKETPLACE_PRODUCT_CODE || '',
    region: process.env.AWS_MARKETPLACE_REGION || process.env.AWS_REGION || 'us-east-1',
    snsTopicArn: process.env.AWS_MARKETPLACE_SNS_TOPIC_ARN || '',
    dimensionToPlanMap: JSON.parse(
      process.env.AWS_MARKETPLACE_DIMENSION_MAP
        || '{"developer":"developer","pro":"pro","unlimited":"unlimited"}',
    ),
  },
};
