// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { getTierLimits } from '@pipeline-builder/api-core';

// Unprovisioned-org fallback = the developer-tier preset, sourced from api-core
// so it can't drift (the previous hardcoded copy had gone stale — notably
// apiCalls: -1, which re-opened the shared-resource DoS hole the tier
// restructure closed). Env vars still override per field.
const DEV = getTierLimits('developer');

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
    /** TTL (ms) for the at-risk org computation cache served by GET /quotas/at-risk. */
    atRiskCacheTtlMs: number;
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
      plugins: parseInt(process.env.QUOTA_DEFAULT_PLUGINS || `${DEV.plugins}`, 10),
      pipelines: parseInt(process.env.QUOTA_DEFAULT_PIPELINES || `${DEV.pipelines}`, 10),
      apiCalls: parseInt(process.env.QUOTA_DEFAULT_API_CALLS || `${DEV.apiCalls}`, 10),
      aiCalls: parseInt(process.env.QUOTA_DEFAULT_AI_CALLS || `${DEV.aiCalls}`, 10),
      // Aggregate registry storage cap (bytes). Override via
      // QUOTA_DEFAULT_STORAGE_BYTES for orgs that need a different baseline.
      storageBytes: parseInt(process.env.QUOTA_DEFAULT_STORAGE_BYTES || `${DEV.storageBytes}`, 10),
      // Count caps on user-editable feature tables. Operators can override
      // per-org via the existing PUT /quotas CRUD endpoint.
      dashboards: parseInt(process.env.QUOTA_DEFAULT_DASHBOARDS || `${DEV.dashboards}`, 10),
      alertRules: parseInt(process.env.QUOTA_DEFAULT_ALERT_RULES || `${DEV.alertRules}`, 10),
      alertDestinations: parseInt(process.env.QUOTA_DEFAULT_ALERT_DESTINATIONS || `${DEV.alertDestinations}`, 10),
      idpConfigs: parseInt(process.env.QUOTA_DEFAULT_IDP_CONFIGS || `${DEV.idpConfigs}`, 10),
    },
    resetDays: parseInt(process.env.QUOTA_RESET_DAYS || '3', 10),
    atRiskCacheTtlMs: parseInt(process.env.QUOTA_AT_RISK_CACHE_TTL_MS || '60000', 10),
  },
};
