// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_LEADER_LOCK_TTL_MS, envInt, envStr } from '@pipeline-builder/api-core';

/**
 * The message service's operator-tunable settings, in one place.
 *
 * Every value is read through api-core's `envInt` / `envStr` so the docs-drift
 * guard (`packages/api-core/test/env-documented.test.ts`) sees it. Values are
 * resolved at import time unless declared as a getter: a getter re-reads the
 * environment on every access, which is kept where the original call site read
 * at call time (and its tests change the variable between cases).
 */
interface AppConfig {
  send: {
    /** Messages + replies one org may send per window. */
    rateMax: number;
    rateWindowMs: number;
  };
  attachments: {
    /** Uploads one org may make per window. */
    uploadRateMax: number;
    uploadRateWindowMs: number;
    /** S3 bucket every attachment blob lives in. */
    bucket: string;
    /** Max long-edge (px) of a generated thumbnail. */
    thumbnailMaxDim: number;
    /** Hours an uploaded-but-never-sent attachment survives before the purge sweep reaps it. Read per sweep. */
    readonly pendingTtlHours: number;
  };
  /** Days a SYSTEM notification is kept (see services/notification-retention.ts). */
  notificationRetentionDays: number;
  support: {
    /** Fair-use support cases per purchased contact within `caseAllowanceWindowDays` (0 disables the check). */
    caseAllowancePerContact: number;
    caseAllowanceWindowDays: number;
    /** Bound on the platform support-entitlement read. */
    entitlementTimeoutMs: number;
    /** How long a last-known-good entitlement may be served while the platform is unreachable. */
    entitlementCacheTtlSeconds: number;
    /** Bound on the billing incident consume/refund call. */
    incidentTimeoutMs: number;
  };
  oncallSweep: {
    /** Page this many minutes before a premium case's first-response deadline. */
    caseLeadMinutes: number;
    intervalMs: number;
    /** Cap on cases paged per tick. */
    batchSize: number;
    /** Crash-recovery window of the sweep's leader lock. */
    lockTtlMs: number;
    startupDelayMs: number;
  };
}

export const config: AppConfig = {
  send: {
    rateMax: envInt('MESSAGE_SEND_RATE_MAX', 60, { min: 1 }),
    rateWindowMs: envInt('MESSAGE_SEND_RATE_WINDOW_MS', 60000, { min: 1000 }),
  },
  attachments: {
    uploadRateMax: envInt('MESSAGE_ATTACHMENT_RATE_MAX', 30, { min: 1 }),
    uploadRateWindowMs: envInt('MESSAGE_ATTACHMENT_RATE_WINDOW_MS', 60000, { min: 1000 }),
    bucket: envStr('S3_BUCKET', 'message-attachments'),
    thumbnailMaxDim: envInt('MESSAGE_THUMBNAIL_MAX_DIM', 320, { min: 48 }),
    get pendingTtlHours() {
      return envInt('MESSAGE_ATTACHMENT_PENDING_TTL_HOURS', 24, { min: 1 });
    },
  },
  notificationRetentionDays: envInt('MESSAGE_NOTIFICATION_RETENTION_DAYS', 365, { min: 7 }),
  support: {
    caseAllowancePerContact: envInt('SUPPORT_CASE_ALLOWANCE_PER_CONTACT', 5, { min: 0 }),
    caseAllowanceWindowDays: envInt('SUPPORT_CASE_ALLOWANCE_WINDOW_DAYS', 30, { min: 1 }),
    entitlementTimeoutMs: envInt('SUPPORT_ENTITLEMENT_TIMEOUT_MS', 3000, { min: 1 }),
    entitlementCacheTtlSeconds: envInt('SUPPORT_ENTITLEMENT_CACHE_TTL_SECONDS', 900, { min: 1 }),
    incidentTimeoutMs: envInt('SUPPORT_INCIDENT_TIMEOUT_MS', 3000, { min: 250, max: 30_000 }),
  },
  oncallSweep: {
    caseLeadMinutes: envInt('ONCALL_CASE_LEAD_MINUTES', 120, { min: 1 }),
    intervalMs: envInt('ONCALL_SWEEP_INTERVAL_MS', 300_000, { min: 10_000 }),
    batchSize: envInt('ONCALL_SWEEP_BATCH_SIZE', 100, { min: 1 }),
    lockTtlMs: envInt('ONCALL_SWEEP_LOCK_TTL_MS', DEFAULT_LEADER_LOCK_TTL_MS, { min: 1000 }),
    startupDelayMs: envInt('ONCALL_SWEEP_STARTUP_DELAY_MS', 60_000, { min: 0 }),
  },
};
