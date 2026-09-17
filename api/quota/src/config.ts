// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envInt, getTierLimits } from '@pipeline-builder/api-core';

// Unprovisioned-org fallback = the developer-tier preset, sourced from api-core
// so it can't drift (the previous hardcoded copy had gone stale — notably
// apiCalls: -1, which re-opened the shared-resource DoS hole the tier
// restructure closed). Env vars still override per field.
const DEV = getTierLimits('developer');

interface QuotaDefaults {
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

interface AppConfig {
  port: number;
  mongodb: {
    uri: string;
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
  port: envInt('PORT', 3000, { min: 1 }),
  mongodb: {
    uri: process.env.MONGODB_URI,
  },
  quota: {
    // `defaults` (and the `QUOTA_DEFAULT_*` overrides) govern the
    // UNPROVISIONED-ORG FALLBACK READ only (buildDefaultOrgQuotaResponse /
    // Mongoose field defaults) — see models/organization.ts. Real orgs are
    // created + seeded by the platform service, and enforcement reserves against
    // those STORED limits, so changing these does NOT change the cap an existing
    // org is held to; it only changes what a not-yet-provisioned org reads back.
    defaults: {
      plugins: envInt('QUOTA_DEFAULT_PLUGINS', DEV.plugins),
      pipelines: envInt('QUOTA_DEFAULT_PIPELINES', DEV.pipelines),
      apiCalls: envInt('QUOTA_DEFAULT_API_CALLS', DEV.apiCalls),
      aiCalls: envInt('QUOTA_DEFAULT_AI_CALLS', DEV.aiCalls),
      // Aggregate registry storage cap (bytes). Override via
      // QUOTA_DEFAULT_STORAGE_BYTES for orgs that need a different baseline.
      storageBytes: envInt('QUOTA_DEFAULT_STORAGE_BYTES', DEV.storageBytes),
      // Count caps on user-editable feature tables. Operators can override
      // per-org via the existing PUT /quotas CRUD endpoint.
      dashboards: envInt('QUOTA_DEFAULT_DASHBOARDS', DEV.dashboards),
      alertRules: envInt('QUOTA_DEFAULT_ALERT_RULES', DEV.alertRules),
      alertDestinations: envInt('QUOTA_DEFAULT_ALERT_DESTINATIONS', DEV.alertDestinations),
      idpConfigs: envInt('QUOTA_DEFAULT_IDP_CONFIGS', DEV.idpConfigs),
    },
    // Guarded: a raw parseInt turned a typo'd QUOTA_RESET_DAYS into NaN, which
    // made every getNextResetDate() an Invalid Date. Clamp to >= 1 day.
    resetDays: envInt('QUOTA_RESET_DAYS', 3, { min: 1 }),
    atRiskCacheTtlMs: envInt('QUOTA_AT_RISK_CACHE_TTL_MS', 60000, { min: 0 }),
  },
};
