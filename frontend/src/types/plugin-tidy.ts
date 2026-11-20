// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic plugin version tidying (`/api/plugins/tidy/*`; api/plugin
 * services/tidy/, not importable). The report shapes are kept identical to the
 * server's by test/wire-type-drift.test.ts.
 */

export type AutoTidyMode = 'off' | 'notify' | 'on';

export type TidyState = 'fresh' | 'warn' | 'warn_queued' | 'warned' | 'deactivate' | 'deactivated' | 'retire' | 'skipped' | 'reactivate' | 'clear';

export type TidySkipReason =
  | 'managed' | 'never_tidy' | 'only_version' | 'inactive_by_owner' | 'default' | 'latest' | 'frozen'
  | 'remediation_pending' | 'install_pin' | 'listed_in_use' | 'kev_accepted' | 'in_use';

export type TidyAction = 'warned' | 'deactivated' | 'retired' | 'reactivated' | 'cleared' | 'refused' | 'failed';

/** One version in a tidy report (`fresh` versions are left out). */
export interface TidyVersionEntry {
  pluginId: string;
  name: string;
  version: string;
  state: TidyState;
  /** Why a protection holds it (`skipped`, `reactivate`, `clear`). */
  reason?: TidySkipReason;
  lastUsedAt: string | null;
  /** N: the day it goes (went) stale. */
  staleAt: string;
  warnedAt?: string;
  deactivateAt?: string;
  retireAt?: string;
  /** `warn_queued`: when the org's next digest may go out. */
  nextDigestAt?: string;
  /** Bytes its removal frees: its kept source plus, when measured, its image's marginal bytes. */
  bytes: number | null;
  /** The run's action. */
  action?: TidyAction;
  error?: string;
}

export interface TidyTotals {
  warn: number;
  warnQueued: number;
  warned: number;
  deactivate: number;
  deactivated: number;
  retire: number;
  skipped: number;
  reactivate: number;
  /** Bytes tidying frees once every stale version here is retired and purged; null when unmeasured. */
  bytesFreed: number | null;
}

/** One org's tidy report (the preview, or one org of a run). */
export interface TidyOrgReport {
  orgId: string;
  generatedAt: string;
  dryRun: boolean;
  /** `PLUGIN_AUTO_TIDY_ENABLED`: whether the daily job runs at all. */
  operatorEnabled: boolean;
  mode: AutoTidyMode;
  staleAfterDays: number;
  neverTidy: string[];
  lastDigestAt: string | null;
  nextDigestAt: string;
  versions: TidyVersionEntry[];
  totals: TidyTotals;
  /** Whether the image bytes are measured (the preview asks image-registry; a run does not). */
  storage: { measured: boolean };
  /** The delete batch the run's retirements share (run only, when any). */
  batchId?: string;
}

/** An org's effective tidy settings. */
export interface TidySettings {
  autoTidy: AutoTidyMode;
  staleAfterDays: number;
  /** Plugin names tidying never touches, sorted. */
  neverTidy: string[];
  /** The org's last tidy digest (ISO), or null. */
  lastDigestAt: string | null;
}

/** `GET /api/plugins/tidy/preview`. */
export interface TidyPreviewView {
  settings: TidySettings;
  report: TidyOrgReport;
  /** `org_settings:write`: may change the settings. */
  canEdit: boolean;
  /** `plugins:write`: may Keep a version or set never-tidy. */
  canKeep: boolean;
}

/** `PUT /api/plugins/tidy/settings` body. */
export interface TidySettingsWrite {
  autoTidy?: AutoTidyMode;
  staleAfterDays?: number;
}

/** The fewest days a version may go unused before it is stale. */
export const TIDY_STALE_MIN_DAYS = 30;

export const AUTO_TIDY_MODE_LABELS: Record<AutoTidyMode, string> = {
  off: 'Off',
  notify: 'Notify only (weekly digest, nothing changes)',
  on: 'On (deactivate, then delete unused versions)',
};

export const TIDY_SKIP_REASON_LABELS: Record<TidySkipReason, string> = {
  managed: 'Managed toolchain',
  never_tidy: 'Plugin set to never tidy',
  only_version: 'Only version',
  inactive_by_owner: 'Deactivated by you',
  default: 'Default version',
  latest: 'Latest version',
  frozen: 'Frozen by a publish request',
  remediation_pending: 'Pending remediation',
  install_pin: 'Pinned by an install',
  listed_in_use: 'Listed copy in use',
  kev_accepted: 'KEV finding under a risk acceptance (rollback target)',
  in_use: 'Used by a pipeline',
};
