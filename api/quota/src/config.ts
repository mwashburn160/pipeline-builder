// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

export interface QuotaDefaults {
  plugins: number;
  pipelines: number;
  apiCalls: number;
  aiCalls: number;
  /** aggregate registry storage cap per org, in bytes. -1 = unlimited. */
  storageBytes: number;
  /** Count caps on user-editable feature tables; match the developer-tier
   *  preset in api-core's quota-tiers.ts. -1 = unlimited. */
  dashboards: number;
  alertRules: number;
  alertDestinations: number;
  idpConfigs: number;
}

export interface AppConfig {
  port: number;
  mongodb: {
    uri: string;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  quota: {
    defaults: QuotaDefaults;
    resetDays: number;
  };
}

if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is required');
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  mongodb: {
    uri: process.env.MONGODB_URI,
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  },
  quota: {
    defaults: {
      plugins: parseInt(process.env.QUOTA_DEFAULT_PLUGINS || '100', 10),
      pipelines: parseInt(process.env.QUOTA_DEFAULT_PIPELINES || '10', 10),
      apiCalls: parseInt(process.env.QUOTA_DEFAULT_API_CALLS || '-1', 10),
      aiCalls: parseInt(process.env.QUOTA_DEFAULT_AI_CALLS || '100', 10),
      // 5 GiB default matches the developer tier preset in api-core's
      // quota-tiers.ts. Override via QUOTA_DEFAULT_STORAGE_BYTES (operator
      // env) for orgs that need a different baseline before tier upgrade.
      storageBytes: parseInt(process.env.QUOTA_DEFAULT_STORAGE_BYTES || `${5 * 1024 * 1024 * 1024}`, 10),
      // Count caps on user-editable feature tables. Match the developer-tier
      // preset; operators can override per-org via the existing PUT /quotas
      // CRUD endpoint without changing these defaults.
      dashboards: parseInt(process.env.QUOTA_DEFAULT_DASHBOARDS || '20', 10),
      alertRules: parseInt(process.env.QUOTA_DEFAULT_ALERT_RULES || '50', 10),
      alertDestinations: parseInt(process.env.QUOTA_DEFAULT_ALERT_DESTINATIONS || '10', 10),
      idpConfigs: parseInt(process.env.QUOTA_DEFAULT_IDP_CONFIGS || '1', 10),
    },
    resetDays: parseInt(process.env.QUOTA_RESET_DAYS || '3', 10),
  },
};
