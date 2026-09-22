// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { envInt, getTierLimits, VALID_QUOTA_TYPES, QUOTA_RESET_DAYS } from '@pipeline-builder/api-core';
import type { QuotaType } from '@pipeline-builder/api-core';

// Unprovisioned-org fallback = the developer-tier preset, sourced from api-core
// so it can't drift. Env vars still override per field.
const DEV = getTierLimits('developer');

/**
 * Per-type fallback limits (-1 = unlimited; `storageBytes` is in bytes). One
 * entry per `VALID_QUOTA_TYPES` member, so a new quota type needs no edit here.
 */
type QuotaDefaults = Record<QuotaType, number>;

/** `apiCalls` → `QUOTA_DEFAULT_API_CALLS`. */
export function quotaDefaultEnvName(type: QuotaType): string {
  return `QUOTA_DEFAULT_${type.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
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
    /**
     * How long (ms) a successfully resolved POOLED root cap stays usable as the
     * fallback when a later resolution fails. `0` disables the fallback, which
     * makes every pooled-resolution blip an outright denial for teams.
     */
    poolFallbackTtlMs: number;
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
    defaults: Object.fromEntries(
      VALID_QUOTA_TYPES.map((t) => [t, envInt(quotaDefaultEnvName(t), DEV[t])]),
    ) as QuotaDefaults,
    // The shared usage-counter period (api-core owns the one definition).
    resetDays: QUOTA_RESET_DAYS,
    atRiskCacheTtlMs: envInt('QUOTA_AT_RISK_CACHE_TTL_MS', 60000, { min: 0 }),
    // Grace window for the pooled root cap. A team's OWN limits are seeded -1
    // on every dimension (only the root's pooled cap binds), so a failed pool
    // resolution has nothing to fall back to and must DENY. Keeping the last
    // successfully resolved cap for a minute turns a Mongo blip into slightly
    // stale enforcement instead of a hard outage for every team.
    poolFallbackTtlMs: envInt('QUOTA_POOL_FALLBACK_TTL_MS', 60000, { min: 0 }),
  },
};
