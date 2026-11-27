// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_LEADER_LOCK_TTL_MS, envBool, envInt, envNameFragment, getTierLimits, VALID_QUOTA_TYPES, QUOTA_RESET_DAYS } from '@pipeline-builder/api-core';
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
  // api-core's shared fragment, not a second copy of the regex: `plan-tiers.ts`
  // derives `PLAN_TIER_<TIER>_<LIMIT>` with the same rule, and the two families
  // must agree on how a camelCase quota name becomes an env name.
  return `QUOTA_DEFAULT_${envNameFragment(type)}`;
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
    /** Days a usage-ledger bucket (and raw exception row) is kept before Mongo's TTL monitor drops it. */
    usageEventRetentionDays: number;
    /** Send the 80% / 100% threshold notices (org inbox + the org's webhook). */
    thresholdNoticesEnabled: boolean;
    /** TTL (ms) for a registry storage-usage reading (and for a failed one). */
    storageUsageCacheTtlMs: number;
  };
  /**
   * The leader-locked storage-notice sweep. GETTERS: read when the scheduler is
   * built at boot (as they were when the sweep read them itself), not when this
   * module is first imported.
   */
  storageSweep: {
    /** `false` turns the sweep off (threshold notices must also be on for it to run). */
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly startupDelayMs: number;
    /** Crash-recovery window for the leader lock (it heartbeats while a pass runs). */
    readonly lockTtlMs: number;
    /** Orgs examined per pass. */
    readonly maxOrgs: number;
    /** How long before a still-crossed storage band is re-notified. */
    readonly reminderMs: number;
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
    // `defaults` (and the `QUOTA_DEFAULT_*` overrides) are the limit for an org
    // with NO tier preset to fall back to: the UNPROVISIONED-ORG FALLBACK READ
    // (buildDefaultOrgQuotaResponse) and `defaultLimitFor` with an unknown or
    // missing tier — see models/organization.ts. Real orgs are
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
    // The usage ledger answers "what used this quota" — hourly buckets of every
    // outcome (`quota_usage_buckets`) plus a raw row per denial / overshoot /
    // refund (`quota_usage_events`). Read at index-build time (TTL indexes), so
    // changing it on an existing install needs both TTL indexes rebuilt. Bucket
    // volume scales with distinct (principal × route × pipeline) per hour, not
    // with requests — see models/usage-bucket.ts for the sizing.
    usageEventRetentionDays: envInt('QUOTA_USAGE_EVENT_RETENTION_DAYS', 90, { min: 1 }),
    thresholdNoticesEnabled: envBool('QUOTA_THRESHOLD_NOTICES_ENABLED', true),
    // Registry storage is measured by walking the org's namespace; the dashboard
    // read polls every minute, so one reading serves the whole window.
    storageUsageCacheTtlMs: envInt('QUOTA_STORAGE_USAGE_CACHE_TTL_MS', 60000, { min: 0 }),
  },
  storageSweep: {
    get enabled() { return envBool('QUOTA_STORAGE_SWEEP_ENABLED', true); },
    // Hours, not minutes. Each org costs one registry read (cached per org for
    // QUOTA_STORAGE_USAGE_CACHE_TTL_MS), and storage moves slowly.
    get intervalMs() { return envInt('QUOTA_STORAGE_SWEEP_INTERVAL_HOURS', 6, { min: 1 }) * 60 * 60 * 1000; },
    get startupDelayMs() { return envInt('QUOTA_STORAGE_SWEEP_STARTUP_DELAY_MS', 120_000, { min: 0 }); },
    get lockTtlMs() { return envInt('QUOTA_STORAGE_SWEEP_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1000 }); },
    get maxOrgs() { return envInt('QUOTA_STORAGE_SWEEP_MAX_ORGS', 200, { min: 1 }); },
    get reminderMs() { return envInt('QUOTA_STORAGE_NOTICE_REMINDER_DAYS', 7, { min: 1 }) * 86_400_000; },
  },
};
